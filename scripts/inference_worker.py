"""Run the pinned Voicebox Qwen backend in an isolated, resource-guarded worker."""
import asyncio, json, os, sys, time, traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for key, value in {'HF_HOME': str(ROOT/'cache'/'huggingface'), 'HF_HUB_OFFLINE':'1',
                   'TRANSFORMERS_OFFLINE':'1', 'NUMBA_CACHE_DIR':str(ROOT/'cache'/'numba'),
                   'HF_HUB_DISABLE_TELEMETRY':'1', 'DO_NOT_TRACK':'1'}.items():
    os.environ[key] = value
sys.path.insert(0, str(ROOT/'upstream'/'voicebox'))
from backend.services.local_runtime import configure_process_tools, require_cuda, qwen_files_ready
configure_process_tools(ROOT)

async def run(folder):
    started = time.perf_counter()
    request = json.loads((folder/'request.json').read_text(encoding='utf-8'))
    import torch, soundfile as sf
    require_cuda(torch)
    from backend import config, database
    config.set_data_dir(request['data_dir'])
    database.init_db()
    from backend.backends import get_tts_backend_for_engine
    from backend.services import profiles
    engine = request['engine']
    backend = get_tts_backend_for_engine(engine)
    path_key = 'custom_voice_model' if engine == 'qwen_custom_voice' else 'base_model'
    model_path = Path(request['config'][path_key])
    if not model_path.is_absolute(): model_path = ROOT/model_path
    if not qwen_files_ready(model_path, path_key):
        raise RuntimeError('模型尚未准备完整：'+str(model_path)+'。请双击“安装配音工作台.vbs”并选择基础配音，完成模型下载后重试。')
    backend._get_model_path = lambda size: str(model_path)
    backend._is_model_cached = lambda *args: True
    # Qwen's default eager path is wasteful on this 6GB GPU; tested SDPA/BF16.
    from qwen_tts import Qwen3TTSModel
    original_loader = Qwen3TTSModel.from_pretrained
    def load(*args, **kwargs):
        kwargs['attn_implementation'] = 'sdpa'
        return original_loader(*args, **kwargs)
    Qwen3TTSModel.from_pretrained = load
    torch.cuda.reset_peak_memory_stats()
    before_load = time.perf_counter()
    await backend.load_model_async('0.6B')
    loaded = time.perf_counter()
    # Bound runaway generation. This is not an emotion control.
    method_name = 'generate_custom_voice' if engine == 'qwen_custom_voice' else 'generate_voice_clone'
    original_generate = getattr(backend.model, method_name)
    def generate(*args, **kwargs):
        kwargs.update(max_new_tokens=3072, temperature=0.9, subtalker_temperature=0.9)
        return original_generate(*args, **kwargs)
    setattr(backend.model, method_name, generate)
    db = next(database.get_db())
    try:
        prompt = await profiles.create_voice_prompt_for_profile(request['profile_id'], db, engine=engine, use_cache=False)
    finally: db.close()
    (folder/'generating').touch()
    from backend.utils.chunked_tts import generate_chunked
    audio, sr = await generate_chunked(backend, request['text'], prompt,
                                      language=request['language'], seed=request['seed'],
                                      max_chunk_chars=800, crossfade_ms=50)
    if len(audio)/sr >= 245:
        raise RuntimeError('生成接近长度上限，可能截断；请分成较短台词。')
    sf.write(folder/'raw.wav', audio, sr, subtype='PCM_16')
    report = dict(engine=engine, model_revision=request['config']['custom_voice_revision' if engine=='qwen_custom_voice' else 'base_revision'],
                  startup_and_load_seconds=round(loaded-started,3), model_load_seconds=round(loaded-before_load,3), total_seconds=round(time.perf_counter()-started,3),
                  audio_seconds=len(audio)/sr, sample_rate=sr,
                  peak_allocated_mb=torch.cuda.max_memory_allocated()/1024**2,
                  peak_reserved_mb=torch.cuda.max_memory_reserved()/1024**2,
                  torch=torch.__version__, device=torch.cuda.get_device_name(),
                  sampling=dict(seed=request['seed'],temperature=0.9,subtalker_temperature=0.9,max_new_tokens=3072))
    (folder/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    backend.unload_model()

if __name__ == '__main__':
    job = Path(sys.argv[1])
    inference_log = (job/'inference.log').open('w',encoding='utf-8',buffering=1)
    sys.stdout = sys.stderr = inference_log
    try: asyncio.run(run(job))
    except Exception as exc:
        (job/'error.txt').write_text(str(exc), encoding='utf-8')
        traceback.print_exc()
        sys.exit(1)
