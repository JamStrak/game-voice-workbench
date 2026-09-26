"""Offline IndexTTS 2.5 worker. Run only through the shared resource guard.

The emotion classifier and speech model use separate processes, so their GPU
weights never coexist. On 6 GB cards the reference encoder stays on the CPU.
"""
import gc
import json
import os
from pathlib import Path
import random
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'upstream/voicebox'))
from backend.services.local_runtime import configure_process_tools, require_cuda
configure_process_tools(ROOT)
CACHE = ROOT / 'cache' / 'emotion'
CACHE.mkdir(parents=True, exist_ok=True)
for name in ('temp', 'nltk_data', 'matplotlib', 'torch'):
    (CACHE/name).mkdir(parents=True, exist_ok=True)
os.environ.update(HF_HOME=str(CACHE / 'huggingface'), HF_HUB_OFFLINE='1',
                  TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                  MODELSCOPE_CACHE=str(CACHE / 'modelscope'),
                  NUMBA_CACHE_DIR=str(CACHE / 'numba'), DO_NOT_TRACK='1',
                  MPLCONFIGDIR=str(CACHE/'matplotlib'), XDG_CACHE_HOME=str(CACHE),
                  TORCH_HOME=str(CACHE/'torch'), NLTK_DATA=str(CACHE/'nltk_data'),
                  TEMP=str(CACHE/'temp'), TMP=str(CACHE/'temp'))
sys.path.insert(0, str(ROOT / 'upstream' / 'indextts'))
NAMES = ['happy', 'angry', 'sad', 'afraid', 'disgusted', 'depressed', 'surprised', 'calm']
LABELS = ['开心', '愤怒', '悲伤', '恐惧', '厌恶', '低落', '惊讶', '平静']
STRENGTH = {'light': 0.35, 'medium': 0.6, 'strong': 0.8}


def result_for(vector, analyzer):
    import math
    if len(vector) != 8 or any(not math.isfinite(float(x)) for x in vector):
        raise ValueError('情绪分析没有返回有效结果，请手动指定表达方式。')
    vector = [min(1.2, max(0.0, float(x))) for x in vector]
    if sum(vector) == 0:
        vector[-1] = 1.0
    index = max(range(8), key=lambda i: vector[i])
    return dict(resolved_emotion=NAMES[index], summary=LABELS[index], vector=vector, analyzer=analyzer)


def load_synthesis_model(index, torch, model_dir):
    # Pin the reference encoder to CPU, moving only its selected hidden
    # state to CUDA. This preserves full precision reference features while
    # saving ~2.2 GiB of GPU weights; no voice is substituted.
    original_encoder_loader = index.Wav2Vec2BertModel.from_pretrained

    class CPUReferenceEncoder:
        def __init__(self, model):
            self.model = model.cpu().eval()
        def to(self, *args, **kwargs):
            return self
        def eval(self):
            return self
        def __call__(self, input_features, attention_mask, **kwargs):
            from types import SimpleNamespace
            with torch.no_grad():
                output = self.model(input_features=input_features.cpu(),
                                    attention_mask=attention_mask.cpu(), **kwargs)
            selected = output.hidden_states[17].to(input_features.device)
            return SimpleNamespace(hidden_states=[None] * 17 + [selected])

    index.Wav2Vec2BertModel.from_pretrained = lambda *a, **kw: CPUReferenceEncoder(original_encoder_loader(*a, **kw))
    # Load GPT weights once with mmap, convert before transferring to CUDA;
    # the original FP32 GPU transfer causes an avoidable startup peak.
    def compact_checkpoint(model, path):
        state = torch.load(path, map_location='cpu', mmap=True, weights_only=True)
        state = state.get('model', state)
        missing, unexpected = model.load_state_dict(state, strict=False, assign=True)
        if missing or unexpected:
            raise RuntimeError('情绪模型权重与固定源码不匹配。')
        model.bfloat16()
        del state
        gc.collect()
        return {}
    index.load_checkpoint = compact_checkpoint
    model = index.IndexTTS2(cfg_path=str(model_dir / 'config.yaml'), model_dir=str(model_dir),
                           device='cuda:0', use_bf16=True, use_deepspeed=False,
                           use_cuda_kernel=False, use_accel=False, use_torch_compile=False,
                           use_qwen_emo=False)
    return model


def run(folder):
    start = time.perf_counter()
    request = json.loads((folder / 'request.json').read_text(encoding='utf-8'))
    if request.get('operation') != 'analyze':
        from emotion_resources import (
            MIN_SYNTHESIS_FREE_RAM_MIB, available_physical_memory, require_synthesis_ram,
        )
        available_bytes = available_physical_memory()
        (folder / 'resources-host.json').write_text(json.dumps(dict(
            available_mib=None if available_bytes is None else round(available_bytes / 1024**2),
            required_available_mib=MIN_SYNTHESIS_FREE_RAM_MIB,
            measurement='GlobalMemoryStatusEx' if sys.platform == 'win32' else 'unavailable',
            admission_policy='conservative_threshold_not_performance_guarantee',
        ), indent=2), encoding='utf-8')
        require_synthesis_ram(available_bytes)
    import numpy as np
    import torch
    import soundfile as sf
    torch.set_num_threads(4)
    require_cuda(torch)
    if request.get('operation') != 'analyze':
        from emotion_resources import require_synthesis_vram, stop_on_length_limit
        free_bytes, total_bytes = torch.cuda.mem_get_info()
        (folder / 'resources.json').write_text(json.dumps(dict(
            free_mib=round(free_bytes / 1024**2), total_mib=round(total_bytes / 1024**2),
            required_free_mib=4096), indent=2), encoding='utf-8')
        require_synthesis_vram(free_bytes, total_bytes)
    torch.cuda.reset_peak_memory_stats()
    seed = request.get('seed')
    if seed is not None:
        random.seed(seed); np.random.seed(seed % (2**32)); torch.manual_seed(seed)
    model_dir = Path(request['config'].get('emotion_model', 'models/indextts-2.5'))
    if not model_dir.is_absolute():
        model_dir = ROOT / model_dir
    # The upstream module sets a relative cache path on import. CWD is our
    # project cache, and every model constructor below uses explicit local paths.
    os.chdir(CACHE)
    from emotion_compat import prepare_native_paths
    prepare_native_paths()
    from indextts import infer_v2_5 as index
    expression = request['expression']
    if request.get('operation') == 'analyze':
        classifier = index.QwenEmotion(str(model_dir / 'qwen0.6bemo4-merge'))
        original = classifier.model.generate

        def bounded_generate(*args, **kwargs):
            kwargs.update(max_new_tokens=256, do_sample=False)
            return original(*args, **kwargs)

        classifier.model.generate = bounded_generate
        analysis_text = expression.get('instruction', '').strip() or request['text']
        scores = classifier.inference(analysis_text)
        vector = [scores.get('melancholic' if name == 'depressed' else name, 0) for name in NAMES]
        result = result_for(vector, 'IndexTTS-QwenEmotion')
        (folder / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    else:
        if expression['mode'] == 'auto':
            result = request['expression_result']
            vector = result['vector']
        else:
            vector = [float(name == expression['emotion']) for name in NAMES]
            result = result_for(vector, 'manual')
        vector = [x * STRENGTH[expression['intensity']] for x in vector]
        model = load_synthesis_model(index, torch, model_dir)
        loaded = time.perf_counter()
        (folder / 'generating').touch()
        vector = model.normalize_emo_vec(vector)
        result = dict(result, applied_vector=vector)
        with stop_on_length_limit():
            model.infer(spk_audio_prompt=request['reference_audio'], text=request['text'],
                        output_path=str(folder / 'raw.wav'),
                        lang={'zh': 'ZH', 'en': 'EN', 'ja': 'JA', 'es': 'ES', 'ar': 'AR'}[request['language']],
                        emo_vector=vector, emo_alpha=1.0, use_random=False,
                        max_text_tokens_per_segment=80, max_mel_tokens=1200, num_beams=1)
        audio, sr = sf.read(folder / 'raw.wav', dtype='float32')
        if not len(audio) or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.0001:
            raise RuntimeError('没有生成有效声音，请重试或降低情绪强度。')
        (folder / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        report = dict(engine='indextts', model_revision=request['config'].get('emotion_revision'),
                      total_seconds=round(time.perf_counter()-start, 3),
                      startup_and_load_seconds=round(loaded-start, 3), audio_seconds=len(audio)/sr,
                      sample_rate=sr, reference_encoder='cpu-float32', expression=expression,
                      expression_result=result, seed=seed,
                      peak_allocated_mb=torch.cuda.max_memory_allocated()/1024**2,
                      peak_reserved_mb=torch.cuda.max_memory_reserved()/1024**2,
                      torch=torch.__version__, device=torch.cuda.get_device_name())
        (folder / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    job = Path(sys.argv[1]).resolve()
    with (job / 'inference.log').open('w', encoding='utf-8', buffering=1) as log:
        sys.stdout = sys.stderr = log
        try:
            run(job)
        except Exception as exc:
            message = str(exc)
            if 'out of memory' in message.lower():
                message = '显存不足，本次情绪配音未完成。请关闭占用显存的应用后重试。'
            (job / 'error.txt').write_text(message, encoding='utf-8')
            traceback.print_exc()
            sys.exit(1)
