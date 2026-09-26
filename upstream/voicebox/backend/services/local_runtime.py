"""Portable local configuration and runtime paths; no model imports or writes."""
from __future__ import annotations

import json
import os
from pathlib import Path


DEFAULTS = {
    "custom_voice_model": "models/qwen-custom-voice-0.6b",
    "custom_voice_revision": "85e237c12c027371202489a0ec509ded67b5e4b5",
    "base_model": "models/qwen-base-0.6b",
    "base_revision": "5d83992436eae1d760afd27aff78a71d676296fc",
    "resource_guard": None,
    "preferred_port": 23164,
    "emotion_model": "models/indextts-2.5",
    "emotion_revision": "c39ce5ba981572cb187443877ff559dfb246ce63",
    "emotion_source_revision": "ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c",
    "emotion_ready": False,
    "emotion_analyzer_ready": False,
}
QWEN_WEIGHT_SIZES = {
    "custom_voice_model": {"model.safetensors": 1811626576, "speech_tokenizer/model.safetensors": 682293092},
    "base_model": {"model.safetensors": 1829344272, "speech_tokenizer/model.safetensors": 682293092},
}
QWEN_REQUIRED_FILES = (
    "config.json", "generation_config.json", "merges.txt", "vocab.json",
    "tokenizer_config.json", "preprocessor_config.json",
    "speech_tokenizer/config.json", "speech_tokenizer/preprocessor_config.json",
)


def load_configuration(root: Path) -> dict:
    """A clean download works without private machine configuration.

    Invalid explicit settings must fail visibly instead of changing the chosen
    model or shared compute guard. Reading never rewrites an existing file.
    """
    result = dict(DEFAULTS)
    for name in ("local_config.example.json", "local_config.json"):
        path = root / name
        if not path.exists():
            continue
        try:
            values = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(values, dict):
                raise ValueError("settings must be an object")
        except (OSError, ValueError) as exc:
            raise ValueError(f"无法读取 {name}。请修正 JSON 格式后重试；原文件没有被修改。") from exc
        result.update(values)
    return result


def resolve_path(root: Path, value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else root / path


def resource_guard_path(root: Path, config: dict) -> Path:
    """Use the bundled guard by default, preserving an explicit shared guard."""
    configured = config.get("resource_guard")
    path = resolve_path(root, configured or "scripts/resource_guard.py")
    if not path.is_file():
        raise ValueError("计算资源锁脚本不存在：" + str(path) +
                         "。请检查 local_config.json 的 resource_guard 设置；不会绕过资源锁。")
    return path


def qwen_files_ready(path: Path, model_key: str) -> bool:
    """Cheap readiness, distinct from the installer's full hash verification."""
    try:
        return (all((path / name).is_file() and (path / name).stat().st_size > 0
                    for name in QWEN_REQUIRED_FILES) and
                all((path / name).is_file() and (path / name).stat().st_size == size
                    for name, size in QWEN_WEIGHT_SIZES[model_key].items()))
    except (OSError, KeyError):
        return False


def configure_process_tools(root: Path, environ=None) -> None:
    """Prefer this release's FFmpeg without modifying the machine's PATH."""
    environ = os.environ if environ is None else environ
    directory = root / "runtime/ffmpeg/bin"
    if not (directory / "ffmpeg.exe").is_file():
        return
    existing = environ.get("PATH", "").split(os.pathsep)
    normalized = os.path.normcase(str(directory.resolve()))
    remaining = [part for part in existing if part and
                 os.path.normcase(os.path.realpath(part)) != normalized]
    environ["PATH"] = os.pathsep.join([str(directory), *remaining])


def require_cuda(torch) -> None:
    try:
        available = torch.cuda.is_available()
    except Exception as exc:
        raise RuntimeError("无法初始化 NVIDIA 显卡。请更新显卡驱动并重新运行安装配音工作台；声音库试听仍可使用。") from exc
    if not available:
        raise RuntimeError("未检测到可用的 NVIDIA CUDA 显卡。当前版本的本地生成需要 NVIDIA 显卡及兼容驱动；声音库试听仍可使用。")
