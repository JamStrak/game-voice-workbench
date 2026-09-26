"""Offline preview producer, invoked only by build_voice_library through guard."""
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import time
import traceback

from build_voice_library import ROOT, LIBRARY, initialize, write_catalog


def completed_sample(sample):
    """Resume only intact outputs, not a stale ready flag beside a corrupt file."""
    output = LIBRARY/'audio'/sample['audio_path']
    if sample['status'] != 'ready' or not output.is_file():
        return False
    content = output.read_bytes()
    return (content[:4] == b'RIFF' and content[8:12] == b'WAVE'
            and hashlib.sha256(content).hexdigest() == sample.get('sha256'))


def main(stage):
    catalog = initialize()
    cfg = json.loads((ROOT/'local_config.json').read_text(encoding='utf-8'))
    selected = [(voice, sample) for voice in catalog['voices'] for sample in voice['samples']
                if (sample['id'] == 'natural') == (stage == 'natural')
                and not completed_sample(sample)]
    if not selected:
        print('All previews already present.', flush=True); return
    if stage == 'emotion':
        from emotion_resources import available_physical_memory, require_synthesis_ram
        require_synthesis_ram(available_physical_memory())
        import emotion_worker as emotion
    else:
        os.environ.update(HF_HOME=str(ROOT/'cache'/'huggingface'), HF_HUB_OFFLINE='1',
                          TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
    import numpy as np
    import torch
    import soundfile as sf
    from emotion_resources import require_synthesis_vram, stop_on_length_limit
    torch.set_num_threads(4)
    require_synthesis_vram(*torch.cuda.mem_get_info())
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    if stage == 'natural':
        from qwen_tts import Qwen3TTSModel
        model_path = Path(cfg['custom_voice_model'])
        if not model_path.is_absolute(): model_path = ROOT/model_path
        model = Qwen3TTSModel.from_pretrained(str(model_path), device_map='cuda:0',
                    torch_dtype=torch.bfloat16, attn_implementation='sdpa')
    else:
        os.chdir(emotion.CACHE)
        from emotion_compat import prepare_native_paths
        prepare_native_paths()
        from indextts import infer_v2_5 as index
        model_dir = ROOT/cfg['emotion_model']
        model = emotion.load_synthesis_model(index, torch, model_dir)
    loaded = time.perf_counter()
    failed = []
    for number, (voice, sample) in enumerate(selected, 1):
        tick = time.perf_counter()
        output = LIBRARY/'audio'/sample['audio_path']
        output.parent.mkdir(parents=True, exist_ok=True)
        tmp = output.with_suffix('.tmp.wav')
        seed = sample['seed']
        random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
        try:
            if stage == 'natural':
                wavs, sr = model.generate_custom_voice(text=sample['text'], language='Chinese',
                    speaker=voice['speaker'], max_new_tokens=512, temperature=0.9, subtalker_temperature=0.9)
                sf.write(tmp, wavs[0], sr, subtype='PCM_16')
            else:
                reference = LIBRARY/'audio'/voice['id']/'natural.wav'
                if not reference.is_file(): raise RuntimeError('缺少同一音色的自然参考试听。')
                vector = model.normalize_emo_vec([0.6 if name == sample['id'] else 0 for name in emotion.NAMES])
                with stop_on_length_limit():
                    model.infer(spk_audio_prompt=str(reference), text=sample['text'], output_path=str(tmp),
                        lang='ZH', emo_vector=vector, emo_alpha=1.0, use_random=False,
                        max_text_tokens_per_segment=80, max_mel_tokens=1200, num_beams=1)
                sample['applied_vector'] = vector
            audio, sr = sf.read(tmp, dtype='float32')
            duration = len(audio)/sr
            if not 1 <= duration <= (18 if stage == 'natural' else 12):
                raise RuntimeError(f'试听时长异常：{duration:.2f}秒，保留供检查，未发布。')
            if not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.001:
                raise RuntimeError('试听无有效声音，未发布。')
            clipped = float(np.mean(np.abs(audio) >= 0.999))
            if clipped > 0.01: raise RuntimeError('试听削波过多，未发布。')
            tmp.replace(output)
            sample.update(status='ready', duration=round(duration, 3), sample_rate=sr,
                          sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                          production_seconds=round(time.perf_counter()-tick, 3),
                          checks=dict(finite=True, peak=float(np.max(np.abs(audio))),
                                      rms=float(np.sqrt(np.mean(audio**2))), clipped_fraction=clipped))
            sample.pop('error', None)
            if stage == 'natural':
                # Use the same neutral reference in future app emotion jobs.
                identity = f'{voice["speaker"]}:{cfg["custom_voice_revision"]}:reference-v1'
                cache = ROOT/'data'/'emotion-references'/(hashlib.sha256(identity.encode()).hexdigest()[:24]+'.wav')
                cache.parent.mkdir(parents=True, exist_ok=True)
                if not cache.exists(): shutil.copyfile(output, cache)
        except Exception as exc:
            sample.update(status='failed', error=str(exc))
            failed.append(f'{voice["id"]}/{sample["id"]}: {exc}')
            traceback.print_exc()
            if 'out of memory' in str(exc).lower():
                write_catalog(catalog); raise
        write_catalog(catalog)
        print(f'{number}/{len(selected)} {voice["id"]}/{sample["id"]}: {sample["status"]}', flush=True)
    report = dict(stage=stage, load_seconds=round(loaded-started,3), total_seconds=round(time.perf_counter()-started,3),
                  peak_reserved_mib=round(torch.cuda.max_memory_reserved()/1024**2), failed=failed,
                  completed=sum(s['status']=='ready' for _,s in selected), attempted=len(selected))
    (ROOT/'validation'/'voice-library-20260923'/f'{stage}-report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    if failed: raise SystemExit(1)


if __name__ == '__main__':
    main(sys.argv[1])
