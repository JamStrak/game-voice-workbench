"""Clean-release behavior without a model, GPU, global PATH, or private config."""
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "upstream/voicebox"))
from backend.services import local_runtime as runtime


class RuntimePortabilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="配音 release ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_clean_download_uses_relative_defaults_without_writing_private_config(self):
        cfg = runtime.load_configuration(self.root)
        self.assertEqual(cfg["preferred_port"], 23164)
        for key in ("custom_voice_model", "base_model", "emotion_model"):
            self.assertFalse(Path(cfg[key]).is_absolute())
            self.assertEqual(runtime.resolve_path(self.root, cfg[key]).parent, self.root / "models")
        self.assertIsNone(cfg["resource_guard"])
        self.assertFalse(cfg["emotion_ready"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_example_and_bom_local_configuration_merge_without_rewriting_existing_values(self):
        (self.root / "local_config.example.json").write_text('{"preferred_port":24001}', encoding="utf-8")
        path = self.root / "local_config.json"
        content = json.dumps({"preferred_port":24002, "resource_guard":"shared/guard.py", "custom_voice_model":"shared/model"})
        path.write_text(content, encoding="utf-8-sig")
        before = path.read_bytes()
        cfg = runtime.load_configuration(self.root)
        self.assertEqual(cfg["preferred_port"], 24002)
        self.assertEqual(cfg["custom_voice_model"], "shared/model")
        self.assertEqual(path.read_bytes(), before)
        self.assertIn("base_revision", cfg)

    def test_invalid_explicit_configuration_fails_without_fallback_or_rewrite(self):
        path = self.root / "local_config.json"
        for invalid in ("{broken", "[]", "null"):
            with self.subTest(value=invalid):
                path.write_text(invalid, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "local_config.json"):
                    runtime.load_configuration(self.root)
                self.assertEqual(path.read_text(encoding="utf-8"), invalid)

    def test_guard_defaults_to_bundle_but_never_silently_replaces_explicit_guard(self):
        guard = self.root / "scripts/resource_guard.py"
        guard.parent.mkdir()
        guard.touch()
        self.assertEqual(runtime.resource_guard_path(self.root, {}), guard)
        self.assertEqual(runtime.resource_guard_path(self.root, {"resource_guard":None}), guard)
        with self.assertRaisesRegex(ValueError, "不会绕过资源锁"):
            runtime.resource_guard_path(self.root, {"resource_guard":"missing/shared_guard.py"})
        shared = self.root / "shared guard.py"
        shared.touch()
        self.assertEqual(runtime.resource_guard_path(self.root, {"resource_guard":str(shared)}), shared)
        self.assertEqual(runtime.resource_guard_path(self.root, {"resource_guard":"shared guard.py"}), shared)

    def test_private_ffmpeg_path_is_unicode_safe_idempotent_and_process_local(self):
        tool = self.root / "runtime/ffmpeg/bin/ffmpeg.exe"
        tool.parent.mkdir(parents=True)
        tool.touch()
        system_path = os.environ.get("PATH")
        env = {"PATH": "system-tools"}
        runtime.configure_process_tools(self.root, env)
        once = env["PATH"]
        runtime.configure_process_tools(self.root, env)
        self.assertEqual(env["PATH"], once)
        self.assertEqual(env["PATH"].split(os.pathsep), [str(tool.parent), "system-tools"])
        self.assertEqual(os.environ.get("PATH"), system_path)

    def test_missing_private_ffmpeg_keeps_existing_developer_path(self):
        env = {"PATH":"existing-ffmpeg"}
        runtime.configure_process_tools(self.root, env)
        self.assertEqual(env["PATH"], "existing-ffmpeg")

    def test_cuda_failure_is_actionable_without_loading_any_model(self):
        available = Mock(return_value=False)
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=available))
        with self.assertRaisesRegex(RuntimeError, "声音库试听仍可使用"):
            runtime.require_cuda(torch)
        available.return_value = True
        runtime.require_cuda(torch)
        available.side_effect = OSError("driver unavailable")
        with self.assertRaisesRegex(RuntimeError, "更新显卡驱动"):
            runtime.require_cuda(torch)

    def test_model_status_rejects_truncated_weights_and_missing_tokenizer_config(self):
        weights = {"model.safetensors": 4, "speech_tokenizer/model.safetensors": 5}
        with patch.dict(runtime.QWEN_WEIGHT_SIZES, {"base_model": weights}):
            for name, size in weights.items():
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x" * size)
            self.assertFalse(runtime.qwen_files_ready(self.root, "base_model"))
            for name in runtime.QWEN_REQUIRED_FILES:
                (self.root / name).write_text("{}", encoding="utf-8")
            self.assertTrue(runtime.qwen_files_ready(self.root, "base_model"))
            (self.root / "model.safetensors").write_bytes(b"bad")
            self.assertFalse(runtime.qwen_files_ready(self.root, "base_model"))
            (self.root / "model.safetensors").write_bytes(b"good")
            (self.root / "tokenizer_config.json").unlink()
            self.assertFalse(runtime.qwen_files_ready(self.root, "base_model"))


if __name__ == "__main__":
    unittest.main()
