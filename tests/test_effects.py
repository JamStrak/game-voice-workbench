"""Run: .venv/Scripts/python.exe -m unittest discover -s tests -p test_effects.py"""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

import numpy as np

MODULE_PATH = Path(__file__).resolve().parents[1] / "upstream/voicebox/backend/utils/effects.py"
spec = importlib.util.spec_from_file_location("voicebox_effects", MODULE_PATH)
effects = importlib.util.module_from_spec(spec)
spec.loader.exec_module(effects)


class EffectsTests(unittest.TestCase):
    def setUp(self):
        self.sr = 24000
        self.audio = (0.1 * np.sin(2 * np.pi * 440 * np.arange(self.sr * 2) / self.sr)).astype(np.float32)

    def test_registry_and_presets_are_compatible_json(self):
        registry = effects.get_available_effects()
        json.dumps(registry)
        self.assertEqual({entry["type"] for entry in registry}, {"tempo", "gain", "normalize", "pitch"})
        for preset in effects.get_builtin_presets().values():
            self.assertTrue({"name", "sort_order", "description", "effects_chain"} <= preset.keys())
            self.assertIsNone(effects.validate_effects_chain(preset["effects_chain"]))
        self.assertEqual(effects.BUILTIN_PRESETS["ryan_promotion"]["effects_chain"][0]["params"]["speed"], 1.25)

    def test_defaults_and_disabled_effects_leave_audio_unchanged(self):
        for chain in ([], [{"type": "tempo"}], [{"type": "gain"}], [{"type": "pitch"}],
                      [{"type": "tempo", "enabled": False, "params": {"speed": 2.0}}]):
            with self.subTest(chain=chain), patch.object(effects.subprocess, "run") as run:
                output = effects.apply_effects(self.audio, self.sr, chain)
                run.assert_not_called()
            np.testing.assert_array_equal(output, self.audio)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    def test_tempo_duration_and_pitch(self):
        for speed in (0.5, 1.25, 2.0):
            with self.subTest(speed=speed):
                out = effects.apply_effects(self.audio, self.sr, [{"type": "tempo", "params": {"speed": speed}}])
                self.assertAlmostEqual(len(out) / self.sr, 2 / speed, delta=0.06)
                frequency = np.fft.rfftfreq(len(out), 1 / self.sr)[np.argmax(abs(np.fft.rfft(out)))]
                self.assertAlmostEqual(frequency, 440, delta=3)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    def test_gain_and_stereo_shape(self):
        stereo = np.stack((self.audio, self.audio * 0.5))
        out = effects.apply_effects(stereo, self.sr, [{"type": "gain", "params": {"gain_db": 6.0}}])
        self.assertEqual(out.shape, stereo.shape)
        np.testing.assert_allclose(out, stereo * 10 ** (6 / 20), atol=1e-6)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    def test_pitch_changes_frequency_without_changing_duration(self):
        for semitones in (-4, 4):
            with self.subTest(semitones=semitones):
                out = effects.apply_effects(self.audio, self.sr, [{"type": "pitch", "params": {"semitones": semitones}}])
                frequency = np.fft.rfftfreq(len(out), 1 / self.sr)[np.argmax(abs(np.fft.rfft(out)))]
                self.assertAlmostEqual(frequency, 440 * 2 ** (semitones / 12), delta=3)
                self.assertAlmostEqual(len(out) / self.sr, len(self.audio) / self.sr, delta=0.06)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    def test_pitch_and_tempo_keep_separate_meanings(self):
        out = effects.apply_effects(self.audio, self.sr, [{"type": "pitch", "params": {"semitones": 4}},
                                                       {"type": "tempo", "params": {"speed": 1.25}}])
        frequency = np.fft.rfftfreq(len(out), 1 / self.sr)[np.argmax(abs(np.fft.rfft(out)))]
        self.assertAlmostEqual(frequency, 440 * 2 ** (4 / 12), delta=3)
        self.assertAlmostEqual(len(out) / self.sr, 2 / 1.25, delta=0.08)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    def test_optional_normalization_keeps_sample_rate_and_finite_audio(self):
        out = effects.apply_effects(self.audio, self.sr, [{"type": "normalize"}])
        self.assertEqual(len(out), len(self.audio))
        self.assertTrue(np.isfinite(out).all())
        self.assertLessEqual(float(np.max(np.abs(out))), 1.0)

    def test_invalid_params_fail_before_ffmpeg(self):
        chains = [None, {}, [None], [{"type": []}], [{"type": "chorus"}],
                  [{"type": "tempo", "enabled": "false"}], [{"type": "tempo", "params": None}],
                  [{"type": "gain", "params": {"unknown": 2}}]]
        chains += [[{"type": "tempo", "params": {"speed": value}}]
                   for value in (float("nan"), float("inf"), float("-inf"), True, "1.25", 0.49, 2.01, 10 ** 200)]
        chains += [[{"type": "pitch", "params": {"semitones": value}}]
                   for value in (float("nan"), float("inf"), True, "4", -4.01, 4.01)]
        with patch.object(effects.subprocess, "run") as run:
            for chain in chains:
                with self.subTest(chain=chain):
                    self.assertIsNotNone(effects.validate_effects_chain(chain))
                    with self.assertRaises(ValueError):
                        effects.apply_effects(self.audio, self.sr, chain)
            run.assert_not_called()

    def test_ffmpeg_errors_are_actionable(self):
        chain = [{"type": "gain", "params": {"gain_db": 1.0}}]
        with patch.object(effects.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "找不到 FFmpeg"):
                effects.apply_effects(self.audio, self.sr, chain)
        failed = subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"test filter error")
        with patch.object(effects.shutil, "which", return_value="ffmpeg"), patch.object(effects.subprocess, "run", return_value=failed) as run:
            with self.assertRaisesRegex(RuntimeError, "test filter error"):
                effects.apply_effects(self.audio, self.sr, chain)
            if effects.os.name == "nt":
                self.assertEqual(run.call_args.kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)


if __name__ == "__main__":
    unittest.main()
