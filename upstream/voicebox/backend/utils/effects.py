"""Minimal FFmpeg post-processing retaining Voicebox effect-chain APIs."""
from __future__ import annotations

import math
import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional
import numpy as np

EFFECT_REGISTRY: Dict[str, Dict[str, Any]] = {
    "tempo": {
        "label": "语速", "description": "调整语速并保持音高；默认 1.0 倍。",
        "params": {"speed": {"default": 1.0, "min": 0.5, "max": 2.0, "step": 0.05, "description": "语速倍数"}},
    },
    "gain": {
        "label": "音量", "description": "音量增益；过大可能导致导出失真。",
        "params": {"gain_db": {"default": 0.0, "min": -40.0, "max": 40.0, "step": 0.5, "description": "增益（dB）"}},
    },
    "pitch": {
        "label": "音高（后期）", "description": "升降音高并保持时长；这是后期处理，不是新的模型音色。",
        "params": {"semitones": {"default": 0.0, "min": -4.0, "max": 4.0, "step": 0.5, "description": "升降半音"}},
    },
    "normalize": {
        "label": "响度标准化（可选）", "description": "FFmpeg loudnorm 单遍标准化；默认不启用。",
        "params": {"target_lufs": {"default": -16.0, "min": -30.0, "max": -10.0, "step": 0.5, "description": "目标响度（LUFS）"}},
    },
}

BUILTIN_PRESETS: Dict[str, Dict[str, Any]] = {
    "ryan_promotion": {
        "name": "Ryan 推广 · 中文 · 1.25 倍", "sort_order": 0,
        "description": "用于 Ryan 中文推广原声的语速预设；音色与语言请在生成时选择。",
        "effects_chain": [{"type": "tempo", "enabled": True, "params": {"speed": 1.25}}],
    },
    "natural": {
        "name": "普通配音 · 1.0 倍", "sort_order": 1, "description": "原始语速，音量不变。",
        "effects_chain": [{"type": "tempo", "enabled": True, "params": {"speed": 1.0}}],
    },
}


def get_available_effects() -> List[Dict[str, Any]]:
    """Return the upstream JSON-serializable editor registry shape."""
    return [{"type": kind, "label": info["label"], "description": info["description"],
             "params": {name: dict(definition) for name, definition in info["params"].items()}}
            for kind, info in EFFECT_REGISTRY.items()]


def get_builtin_presets() -> Dict[str, Dict[str, Any]]:
    return BUILTIN_PRESETS


def validate_effects_chain(effects_chain: List[Dict[str, Any]]) -> Optional[str]:
    """Return a validation error, or None when valid (including disabled effects)."""
    if not isinstance(effects_chain, list):
        return "effects_chain must be a list"
    for index, effect in enumerate(effects_chain):
        if not isinstance(effect, dict):
            return f"Effect at index {index} must be a dict"
        kind = effect.get("type")
        if not isinstance(kind, str) or kind not in EFFECT_REGISTRY:
            return f"Unknown effect type '{kind}' at index {index}. Available: {list(EFFECT_REGISTRY)}"
        if not isinstance(effect.get("enabled", True), bool):
            return f"Effect '{kind}' at index {index}: enabled must be a boolean"
        params = effect.get("params", {})
        if not isinstance(params, dict):
            return f"Effect '{kind}' at index {index}: params must be a dict"
        for name, value in params.items():
            prefix = f"Effect '{kind}' at index {index}: param '{name}'"
            if name not in EFFECT_REGISTRY[kind]["params"]:
                return f"{prefix} is unknown"
            definition = EFFECT_REGISTRY[kind]["params"][name]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return f"{prefix} must be a finite number"
            if isinstance(value, float) and not math.isfinite(value):
                return f"{prefix} must be a finite number"
            if not definition["min"] <= value <= definition["max"]:
                return f"{prefix} must be between {definition['min']} and {definition['max']} (got {value})"
    return None


class _FFmpegBoard:
    """Callable adapter for the legacy build_pedalboard name, without pedalboard."""
    def __init__(self, effects_chain: List[Dict[str, Any]]):
        error = validate_effects_chain(effects_chain)
        if error:
            raise ValueError(error)
        self.filters = []
        for effect in effects_chain:
            if not effect.get("enabled", True):
                continue
            kind = effect["type"]
            params = {name: effect.get("params", {}).get(name, definition["default"])
                      for name, definition in EFFECT_REGISTRY[kind]["params"].items()}
            if kind == "tempo" and params["speed"] != 1.0:
                self.filters.append(f"atempo={params['speed']:.10g}")
            elif kind == "gain" and params["gain_db"] != 0.0:
                self.filters.append(f"volume={params['gain_db']:.10g}dB")
            elif kind == "pitch" and params["semitones"] != 0.0:
                ratio = 2 ** (params["semitones"] / 12)
                self.filters.append(f"asetrate={{sample_rate}}*{ratio:.12g},aresample={{sample_rate}},atempo={1 / ratio:.12g}")
            elif kind == "normalize":
                self.filters.append(f"loudnorm=I={params['target_lufs']:.10g}:TP=-1.5:LRA=11")

    def __call__(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        if isinstance(sample_rate, bool) or not isinstance(sample_rate, (int, np.integer)) or not 8000 <= sample_rate <= 192000:
            raise ValueError("sample_rate must be an integer between 8000 and 192000 Hz")
        data = np.asarray(audio, dtype=np.float32)
        if data.ndim not in (1, 2) or (data.ndim == 2 and not 1 <= data.shape[0] <= 8):
            raise ValueError("audio must be mono (samples,) or channels-first (1-8 channels, samples)")
        if not np.all(np.isfinite(data)):
            raise ValueError("audio must contain only finite samples")
        if not self.filters or data.size == 0:
            return data.copy()
        executable = shutil.which("ffmpeg")
        if not executable:
            raise RuntimeError("找不到 FFmpeg。请双击“安装配音工作台.vbs”修复项目内的 FFmpeg，然后重新启动配音工作台。")
        channels = 1 if data.ndim == 1 else data.shape[0]
        command = [executable, "-hide_banner", "-loglevel", "error", "-nostdin",
                   "-f", "f32le", "-ar", str(sample_rate), "-ac", str(channels), "-i", "pipe:0",
                   "-af", ",".join(self.filters).format(sample_rate=sample_rate), "-ar", str(sample_rate), "-ac", str(channels),
                   "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]
        try:
            result = subprocess.run(command, input=data.T.astype("<f4", copy=False).tobytes(),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("FFmpeg 后期处理超过 120 秒，请缩短音频后重试。") from exc
        except OSError as exc:
            raise RuntimeError(f"无法启动 FFmpeg（{executable}）：{exc}") from exc
        if result.returncode:
            detail = result.stderr.decode("utf-8", errors="replace").strip()[-2000:]
            raise RuntimeError(f"FFmpeg 后期处理失败（退出码 {result.returncode}）：{detail}")
        if not result.stdout or len(result.stdout) % (4 * channels):
            raise RuntimeError("FFmpeg 未返回有效音频数据。")
        processed = np.frombuffer(result.stdout, dtype="<f4").copy()
        if not np.all(np.isfinite(processed)):
            raise RuntimeError("FFmpeg 返回了无效的音频采样值。")
        return processed if data.ndim == 1 else processed.reshape(-1, channels).T


def build_pedalboard(effects_chain: List[Dict[str, Any]]) -> _FFmpegBoard:
    """Retain upstream callable API name; no pedalboard dependency is used."""
    return _FFmpegBoard(effects_chain)


def apply_effects(audio: np.ndarray, sample_rate: int, effects_chain: List[Dict[str, Any]]) -> np.ndarray:
    """Apply the ordered chain, keeping sample rate and channel dimensionality."""
    return build_pedalboard(effects_chain)(audio, sample_rate)
