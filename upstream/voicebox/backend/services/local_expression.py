"""Emotion request validation and backward-compatible generation metadata.

This module deliberately does not import or initialize a speech model. Readiness
requires both installed files and a successful local validation flag.
"""
import json
from pathlib import Path

from pydantic import ValidationError

from ..models import ExpressionConfig
from .local_runtime import load_configuration

ROOT = Path(__file__).resolve().parents[4]
CORE_WEIGHTS = {
    "gpt.pth": 3259599833,
    "codec.pth": 607290935,
    "s2mel.pth": 414908601,
}
ANALYZER_WEIGHT_BYTES = 1192135096
EXPRESSION_LANGUAGES = {"zh", "en", "ja", "es", "ar"}
CORE_FILES = (
    "config.yaml", "feat1.pt", "feat2.pt", "wav2vec2bert_stats.pt",
    "multilingual_zh_ja_yue_char_del.tiktoken",
    "hf_cache/w2v-bert-2.0/config.json",
    "hf_cache/w2v-bert-2.0/preprocessor_config.json",
    "hf_cache/w2v-bert-2.0/model.safetensors",
    "hf_cache/bigvgan/config.json",
    "hf_cache/bigvgan/bigvgan_generator.pt",
    "hf_cache/campplus_cn_common.bin",
)


def normalize_expression(expression=None):
    if isinstance(expression, ExpressionConfig):
        expression = expression.model_dump()
    return ExpressionConfig.model_validate(expression or {}).model_dump()


def encode_expression(expression, result=None):
    envelope = {"expression": normalize_expression(expression)}
    if result is not None:
        if not isinstance(result, dict):
            raise ValueError("情绪分析结果必须为对象")
        envelope["result"] = result
    return json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))


def decode_expression(instruct):
    """Recognize our structured envelope, never reinterpret a legacy prompt."""
    if not isinstance(instruct, str) or not instruct.strip().startswith("{"):
        return None, None
    try:
        envelope = json.loads(instruct)
        if not isinstance(envelope, dict) or set(envelope) - {"expression", "result"}:
            return None, None
        expression = envelope.get("expression")
        if not isinstance(expression, dict) or "mode" not in expression:
            return None, None
        if set(expression) - {"mode", "emotion", "intensity", "instruction"}:
            return None, None
        expression = normalize_expression(expression)
        result = envelope.get("result")
        return expression, result if isinstance(result, dict) else None
    except (ValueError, TypeError, ValidationError):
        return None, None


def _has_size(path, size):
    try:
        return path.is_file() and path.stat().st_size == size
    except OSError:
        return False


def _has_file(path):
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def expression_capabilities():
    try:
        cfg = load_configuration(ROOT)
        if not isinstance(cfg, dict):
            raise ValueError("Invalid local configuration")
    except (OSError, ValueError):
        return {"ready": False, "analyzer_ready": False, "reason": "情绪配音配置尚未就绪。"}

    model_dir = Path(cfg.get("emotion_model") or "models/indextts-2.5")
    if not model_dir.is_absolute():
        model_dir = ROOT / model_dir
    environment_ready = (ROOT / ".venv-emotion" / "Scripts" / "python.exe").is_file()
    core_ready = environment_ready and all(_has_file(model_dir / name) for name in CORE_FILES) and all(
        _has_size(model_dir / name, size) for name, size in CORE_WEIGHTS.items()
    )
    ready = core_ready and cfg.get("emotion_ready") is True
    analyzer_dir = model_dir / "qwen0.6bemo4-merge"
    analyzer_ready = ready and cfg.get("emotion_analyzer_ready") is True and _has_size(
        analyzer_dir / "model.safetensors", ANALYZER_WEIGHT_BYTES
    ) and (analyzer_dir / "config.json").is_file() and (analyzer_dir / "tokenizer.json").is_file()

    reason = None
    if not core_ready:
        reason = "情绪配音环境或模型文件尚未完整安装；自然配音仍可使用。"
    elif not ready:
        reason = "情绪配音尚未通过本机验证；自然配音仍可使用。"
    elif not analyzer_ready:
        reason = "可以手动指定情绪；自动情绪分析尚未通过本机验证。"
    return {"ready": ready, "analyzer_ready": analyzer_ready, "reason": reason}


def validate_expression(expression, language="zh"):
    normalized = normalize_expression(expression)
    if normalized["mode"] == "natural":
        return normalized
    if language not in EXPRESSION_LANGUAGES:
        raise ValueError("情绪配音目前支持中文、英语、日语、西班牙语和阿拉伯语。")
    capabilities = expression_capabilities()
    if not capabilities["ready"]:
        raise ValueError(capabilities["reason"] or "情绪配音尚未就绪。")
    if normalized["mode"] == "auto" and not capabilities["analyzer_ready"]:
        raise ValueError(capabilities["reason"] or "自动情绪分析尚未就绪。")
    return normalized
