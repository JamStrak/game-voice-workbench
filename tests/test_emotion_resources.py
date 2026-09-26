"""Reject Windows GPU spill conditions before model loading."""
from pathlib import Path
import builtins
import ctypes
import json
import os
import runpy
import sys
import tempfile
import unittest
from unittest import mock
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import emotion_resources
from emotion_resources import (
    MIN_SYNTHESIS_FREE_RAM_MIB, available_physical_memory, require_synthesis_ram,
    require_synthesis_vram, stop_on_length_limit,
)


class EmotionResourceTests(unittest.TestCase):
    def test_ram_exact_threshold_and_more_are_admitted(self):
        self.assertEqual(MIN_SYNTHESIS_FREE_RAM_MIB, 8192)
        for free_bytes in (8 * 1024**3, 12 * 1024**3):
            with self.subTest(free_bytes=free_bytes):
                require_synthesis_ram(free_bytes)

    def test_low_ram_has_actionable_message(self):
        with self.assertRaisesRegex(RuntimeError, '当前可用内存 7.55GB.*至少 8GB.*关闭其它占内存应用后重试'):
            require_synthesis_ram(int(7.55 * 1024**3))
        with self.assertRaises(RuntimeError):
            require_synthesis_ram(8 * 1024**3 - 1)
        with self.assertRaises(RuntimeError):
            require_synthesis_ram(0)

    def test_non_windows_skips_unavailable_ram(self):
        with mock.patch.object(emotion_resources.sys, 'platform', 'linux'):
            self.assertIsNone(available_physical_memory())
            require_synthesis_ram(None)

    def test_windows_api_reads_available_physical_not_pagefile(self):
        def report(pointer):
            status = ctypes.cast(pointer, ctypes.POINTER(emotion_resources._MemoryStatusEx)).contents
            self.assertEqual(status.dwLength, 64)
            status.ullAvailPhys = 9 * 1024**3
            status.ullAvailPageFile = 30 * 1024**3
            return 1
        api = mock.Mock(side_effect=report)
        with mock.patch.object(emotion_resources.sys, 'platform', 'win32'), \
                mock.patch.object(emotion_resources.ctypes, 'WinDLL', return_value=mock.Mock(GlobalMemoryStatusEx=api), create=True):
            self.assertEqual(available_physical_memory(), 9 * 1024**3)

    def test_windows_missing_reading_fails_closed(self):
        with mock.patch.object(emotion_resources.sys, 'platform', 'win32'), \
                mock.patch.object(emotion_resources.ctypes, 'WinDLL', return_value=mock.Mock(GlobalMemoryStatusEx=mock.Mock(return_value=0)), create=True):
            self.assertIsNone(available_physical_memory())
            with self.assertRaisesRegex(RuntimeError, '无法读取当前可用内存.*尚未启动.*重试'):
                require_synthesis_ram(None)

    def test_worker_records_and_rejects_before_model_library_imports(self):
        with mock.patch.dict(os.environ):
            worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts' / 'emotion_worker.py'))
        real_import = builtins.__import__
        def forbid_model_imports(name, *args, **kwargs):
            if name.split('.')[0] in ('torch', 'numpy', 'soundfile'):
                self.fail(f'Heavy dependency imported before RAM admission: {name}')
            return real_import(name, *args, **kwargs)
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(emotion_resources, 'available_physical_memory', return_value=int(7.55 * 1024**3)), \
                mock.patch('builtins.__import__', side_effect=forbid_model_imports):
            folder = Path(temp)
            (folder / 'request.json').write_text(json.dumps({'operation': 'synthesize'}), encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, '至少 8GB'):
                worker['run'](folder)
            report = json.loads((folder / 'resources-host.json').read_text(encoding='utf-8'))
            self.assertEqual(report['required_available_mib'], 8192)
            self.assertEqual(report['available_mib'], round(7.55 * 1024))

    def test_analysis_does_not_use_synthesis_ram_threshold(self):
        with mock.patch.dict(os.environ):
            worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts' / 'emotion_worker.py'))
        real_import = builtins.__import__
        class StopBeforeHeavyImports(Exception):
            pass
        def stop_import(name, *args, **kwargs):
            if name == 'numpy':
                raise StopBeforeHeavyImports()
            return real_import(name, *args, **kwargs)
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(emotion_resources, 'available_physical_memory') as read_memory, \
                mock.patch('builtins.__import__', side_effect=stop_import):
            folder = Path(temp)
            (folder / 'request.json').write_text(json.dumps({'operation': 'analyze'}), encoding='utf-8')
            with self.assertRaises(StopBeforeHeavyImports):
                worker['run'](folder)
            read_memory.assert_not_called()
            self.assertFalse((folder / 'resources-host.json').exists())

    def test_game_occupancy_explains_how_to_retry(self):
        with self.assertRaisesRegex(RuntimeError, '可用 2.8GB.*4.0GB.*游戏.*重试'):
            require_synthesis_vram(2867 * 1024**2, 6144 * 1024**2)

    def test_idle_gpu_and_exact_budget_are_admitted(self):
        for free_mib in (4096, 5271):
            with self.subTest(free_mib=free_mib):
                require_synthesis_vram(free_mib * 1024**2, 6144 * 1024**2)

    def test_missing_eos_stops_before_expensive_flow(self):
        entered_flow = False
        with self.assertRaisesRegex(RuntimeError, '长度上限.*没有生成音频'):
            with stop_on_length_limit():
                warnings.warn('WARN: generation stopped due to exceeding `max_mel_tokens` (1200). Input text tokens: 12.', RuntimeWarning)
                entered_flow = True
        self.assertFalse(entered_flow)

    def test_unrelated_upstream_warning_does_not_abort_synthesis(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            with stop_on_length_limit():
                warnings.warn('optional generation flag ignored', RuntimeWarning)
        self.assertEqual(len(caught), 1)


if __name__ == '__main__':
    unittest.main()
