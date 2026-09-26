"""Local adaptation: every GPU job lives inside the shared guard's Windows Job.

The web process never holds model weights. Cancellation terminates the guard,
whose kill-on-close Job terminates its worker before we admit the next job.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import shutil
import hashlib
import soundfile as sf
from .local_runtime import load_configuration, resource_guard_path

ROOT = Path(__file__).resolve().parents[4]

def configuration():
    return load_configuration(ROOT)


async def run_worker(folder, request, *, emotion=False, generation_id=None, timeout=1800):
    from . import local_hub
    runtime = local_hub.runtime
    token = runtime.begin_worker() if runtime is not None else None
    proof = {'verified': True}
    try:
        return await _run_worker(folder, request, emotion=emotion, generation_id=generation_id,
                                 timeout=timeout, proof=proof)
    finally:
        if runtime is not None:
            runtime.end_worker(token, verified=proof['verified'])


async def _run_worker(folder, request, *, emotion=False, generation_id=None, timeout=1800, proof):
    """One guarded subprocess; cancellation closes its entire Windows Job."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder/'request.json').write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
    cfg = request['config']
    guard = resource_guard_path(ROOT, cfg)
    worker_python = str(ROOT/'.venv-emotion'/'Scripts'/'python.exe') if emotion else sys.executable
    if emotion and not Path(worker_python).is_file():
        raise ValueError('情绪配音环境尚未安装。请双击“安装配音工作台.vbs”并选择情绪配音。')
    worker_script = 'emotion_worker.py' if emotion else 'inference_worker.py'
    command = [sys.executable, str(guard), '--owner', '配音工作台', '--timeout', '900', '--',
               worker_python, str(ROOT/'scripts'/worker_script), str(folder)]
    from ..database import get_db
    from . import history
    with (folder/'worker.log').open('w', encoding='utf-8') as log:
        proc = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        proof['verified'] = False
        try:
            shown = False
            deadline = time.monotonic() + timeout
            while proc.poll() is None:
                await asyncio.sleep(0.3)
                if time.monotonic() >= deadline:
                    raise RuntimeError('任务等待或运行超时，请稍后重试。')
                if generation_id and not shown and (folder/'generating').exists():
                    db = next(get_db())
                    try: await history.update_generation_status(generation_id, 'generating', db)
                    finally: db.close()
                    shown = True
            if proc.returncode:
                error = (folder/'error.txt')
                detail = error.read_text(encoding='utf-8') if error.exists() else (folder/'worker.log').read_text(encoding='utf-8')[-1800:]
                raise RuntimeError('配音未完成：'+detail)
        finally:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    # The guarded worker is a kill-on-close job descendant.
                    await asyncio.to_thread(proc.wait, 15)
            finally:
                # Failed/unfinished cleanup stays unknown, never a false idle.
                proof['verified'] = proc.poll() is not None


async def analyze_expression(text, expression):
    from .local_expression import validate_expression
    validate_expression(expression)
    folder = ROOT/'data'/'jobs'/f'emotion-analysis-{uuid.uuid4()}'
    request = dict(operation='analyze', text=text, expression=expression,
                   config=configuration(), seed=20260922)
    await run_worker(folder, request, emotion=True, timeout=1020)
    result = json.loads((folder/'result.json').read_text(encoding='utf-8'))
    return dict(expression=expression, **result)


async def reference_for(profile_id, folder, cfg, seed):
    """Use the selected clone sample or synthesize THAT preset's neutral sample."""
    from .. import config
    from ..database import get_db, VoiceProfile, ProfileSample
    db = next(get_db())
    try:
        profile = db.query(VoiceProfile).filter_by(id=profile_id).first()
        if not profile:
            raise ValueError('声音档案不存在。')
        if profile.voice_type == 'preset':
            if profile.library_voice_id:
                from .local_voice_library import get_voice, sample_path
                voice = get_voice(profile.library_voice_id)
                natural = next((sample for sample in voice.get('samples', []) if sample['id'] == 'natural'), None)
                reference = sample_path(natural) if natural else None
                if reference is None:
                    raise ValueError('该内置声音的自然试听尚未就绪，请等待声音库准备完成。')
                return str(reference)
            if profile.preset_engine != 'qwen_custom_voice' or not profile.preset_voice_id:
                raise ValueError('该内置音色暂不支持情绪配音。')
            identity = f'{profile.preset_voice_id}:{cfg["custom_voice_revision"]}:reference-v1'
            cached = ROOT/'data'/'emotion-references'/(hashlib.sha256(identity.encode()).hexdigest()[:24]+'.wav')
            if cached.is_file():
                return str(cached)
            reference = None
        else:
            sample = db.query(ProfileSample).filter_by(profile_id=profile_id).order_by(ProfileSample.id).first()
            if not sample:
                raise ValueError('这个声音档案还没有参考录音，请先添加录音。')
            reference = config.resolve_storage_path(sample.audio_path)
            if not reference or not reference.is_file():
                raise ValueError('该声音的参考录音不存在，请重新添加。')
    finally:
        db.close()
    if reference is not None:
        return str(reference)
    ref_job = folder/'reference'
    request = dict(profile_id=profile_id, text='你好，我会认真说好每一句台词，让故事中的角色鲜活起来。',
                   language='zh', engine='qwen_custom_voice', model_size='0.6B', seed=seed,
                   data_dir=str(ROOT/'data'), config=cfg)
    await run_worker(ref_job, request)
    cached.parent.mkdir(parents=True, exist_ok=True)
    temporary = cached.with_suffix('.tmp.wav')
    shutil.copyfile(ref_job/'raw.wav', temporary)
    temporary.replace(cached)
    return str(cached)


async def infer(generation_id, profile_id, text, language, engine, model_size, seed, instruct=None):
    cfg = configuration()
    folder = ROOT/'data'/'jobs'/f'{generation_id}-{time.time_ns()}'
    request = dict(profile_id=profile_id, text=text, language=language, engine=engine,
                   model_size=model_size or '0.6B', seed=seed, data_dir=str(ROOT/'data'), config=cfg)
    if engine == 'indextts':
        from .local_expression import decode_expression, validate_expression, encode_expression
        expression, previous_result = decode_expression(instruct)
        if not expression:
            raise ValueError('缺少情绪设置，无法生成。')
        validate_expression(expression, language)
        request['expression'] = expression
        # Keep retries and alternate takes consistent with the original analysis.
        if expression['mode'] == 'auto':
            result = previous_result or await analyze_expression(text, expression)
            request['expression_result'] = {k: v for k,v in result.items() if k != 'expression'}
        request['reference_audio'] = await reference_for(profile_id, folder, cfg, seed)
        await run_worker(folder, request, emotion=True, generation_id=generation_id)
        result = json.loads((folder/'result.json').read_text(encoding='utf-8'))
        from ..database import get_db, Generation
        db = next(get_db())
        try:
            gen = db.query(Generation).filter_by(id=generation_id).first()
            if gen:
                gen.instruct = encode_expression(expression, result)
                db.commit()
        finally:
            db.close()
    else:
        if engine not in ('qwen', 'qwen_custom_voice') or model_size not in ('0.6B', None):
            raise ValueError('普通配音仅启用 Qwen 0.6B，请选择已安装的声音档案。')
        if instruct:
            raise ValueError('当前普通配音模型不支持情绪指令，请使用“表达方式”设置。')
        await run_worker(folder, request, generation_id=generation_id)
    return sf.read(folder/'raw.wav', dtype='float32')
