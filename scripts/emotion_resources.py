"""Conservative admission checks for the measured IndexTTS configuration."""
from contextlib import contextmanager
import ctypes
import sys
import warnings

MIN_SYNTHESIS_FREE_MIB = 4096
MIN_SYNTHESIS_FREE_RAM_MIB = 8192


class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ('dwLength', ctypes.c_uint32),
        ('dwMemoryLoad', ctypes.c_uint32),
        ('ullTotalPhys', ctypes.c_uint64),
        ('ullAvailPhys', ctypes.c_uint64),
        ('ullTotalPageFile', ctypes.c_uint64),
        ('ullAvailPageFile', ctypes.c_uint64),
        ('ullTotalVirtual', ctypes.c_uint64),
        ('ullAvailVirtual', ctypes.c_uint64),
        ('ullAvailExtendedVirtual', ctypes.c_uint64),
    ]


def available_physical_memory():
    """Return Windows available physical RAM in bytes, or an unavailable reading.

    Use the OS API without importing any model libraries. Non-Windows hosts do
    not need an additional dependency; Windows failures are rejected by the
    admission check rather than being mistaken for sufficient memory.
    """
    if sys.platform != 'win32':
        return None
    try:
        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(status)
        get_status = ctypes.WinDLL('kernel32', use_last_error=True).GlobalMemoryStatusEx
        get_status.argtypes = [ctypes.POINTER(_MemoryStatusEx)]
        get_status.restype = ctypes.c_int
        if not get_status(ctypes.byref(status)):
            return None
        return int(status.ullAvailPhys)
    except (AttributeError, OSError):
        return None


def require_synthesis_ram(available_bytes):
    """Reserve the measured ~6.2 GiB load plus ~1.8 GiB for the interface.

    This is a conservative admission threshold, not a performance guarantee:
    other applications may consume RAM after this check.
    """
    if available_bytes is None:
        if sys.platform == 'win32':
            raise RuntimeError('无法读取当前可用内存，情绪配音尚未启动。请稍后重试。')
        return
    if available_bytes < MIN_SYNTHESIS_FREE_RAM_MIB * 1024**2:
        raise RuntimeError(
            f'当前可用内存 {available_bytes / 1024**3:.2f}GB，'
            '情绪配音需至少 8GB 空闲内存，请关闭其它占内存应用后重试。'
        )


def require_synthesis_vram(free_bytes, total_bytes):
    """Leave room for the measured 3.4 GiB peak and CUDA overhead.

    Windows can spill CUDA allocations into shared system memory instead of
    raising OOM. Reject this state before loading weights to avoid very long
    inference while another application (for example, a game) uses the GPU.
    """
    free_mib = free_bytes / 1024**2
    total_mib = total_bytes / 1024**2
    if free_mib < MIN_SYNTHESIS_FREE_MIB:
        raise RuntimeError(
            f'当前显存不足：可用 {free_mib / 1024:.1f}GB / 共 {total_mib / 1024:.1f}GB，'
            '情绪配音需要至少 4.0GB 空闲显存。请先关闭占用显卡的游戏或其他应用，再点重试；'
            '本次没有生成音频。'
        )


@contextmanager
def stop_on_length_limit():
    """Abort before flow synthesis when upstream failed to produce EOS."""
    with warnings.catch_warnings():
        warnings.filterwarnings(
            'error', category=RuntimeWarning,
            message=r'^WARN: generation stopped due to exceeding `max_mel_tokens`')
        try:
            yield
        except RuntimeWarning as exc:
            if 'exceeding `max_mel_tokens`' not in str(exc):
                raise
            raise RuntimeError('该句生成达到长度上限，请拆成更短台词后重试。本次没有生成音频。') from exc
