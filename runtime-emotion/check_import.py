"""CPU-only import, tokenizer and normalizer check; never instantiate a TTS model."""
import os
from pathlib import Path
import sys
import json
import time
import faulthandler

root = Path(__file__).resolve().parents[1]
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
os.environ["NLTK_DATA"] = str(root / "cache/emotion/nltk_data")
os.environ["HF_HOME"] = str(root / "cache/emotion/huggingface")
os.environ["HF_HUB_CACHE"] = str(root / "cache/emotion/huggingface/hub")
os.environ["MODELSCOPE_CACHE"] = str(root / "cache/emotion/modelscope")
os.environ["MPLCONFIGDIR"] = str(root / "cache/emotion/matplotlib")
os.environ["XDG_CACHE_HOME"] = str(root / "cache/emotion")
os.environ["TORCH_HOME"] = str(root / "cache/emotion/torch")
os.environ["NUMBA_CACHE_DIR"] = str(root / "cache/emotion/numba")
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
sys.path.insert(0, str(root / "upstream/indextts"))
sys.path.insert(0, str(root / "scripts"))
os.chdir(root / "cache/emotion")
start = time.time()
faulthandler.dump_traceback_later(120)
print("Importing torch and IndexTTS on CPU", flush=True)
import torch
from emotion_compat import prepare_native_paths
prepare_native_paths()
from indextts.infer_v2_5 import IndexTTS2, QwenEmotion
from indextts.s2mel.modules.flow_matching import CFM
from indextts.s2mel.modules.length_regulator import InterpolateRegulator
from indextts.utils.tokenizer import get_tokenizer
from indextts.utils.front import TextNormalizer
from indextts.utils.ja_g2p import JapaneseG2PProcessor
print("Checking tokenizer, WeText FSTs and Japanese dictionary", flush=True)
tokenizer = get_tokenizer(multilingual=True, model_dir=str(root / "models/indextts-2.5"))
tokens = tokenizer.encode("今天终于见到你了。")
normalizer = TextNormalizer()
normalizer.load()
japanese = JapaneseG2PProcessor(g2p_ratio=0)
report = {"ok": True, "torch": torch.__version__, "cuda_visible": torch.cuda.is_available(),
          "api": "indextts.infer_v2_5.IndexTTS2", "emotion_api": "indextts.infer_v2_5.QwenEmotion",
          "tokens": len(tokens), "normalizer": normalizer.normalize("今天是2026年。"),
          "seconds": round(time.time() - start, 2)}
(root / "runtime-emotion/import-check.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
faulthandler.cancel_dump_traceback_later()
print(json.dumps(report, ensure_ascii=False, indent=2))
