"""Installation invariants; use a tiny fake HTTP source, never public model downloads."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("setup_distribution", ROOT / "scripts/setup_distribution.py")
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)


def item_for(data):
    return {"path": "model.bin", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}


class DistributionTests(unittest.TestCase):
    def test_complete_valid_file_is_not_downloaded(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "model.bin"
            target.write_bytes(b"already verified")
            SETUP.download("https://example.invalid", target, item_for(target.read_bytes()),
                           open_url=lambda *a, **k: self.fail("verified file downloaded again"))

    def test_resumes_exact_range_then_atomically_replaces(self):
        data = b"0123456789"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "model.bin"
            target.with_suffix(".bin.part").write_bytes(data[:4])
            def opener(request, **kwargs):
                self.assertEqual(request.get_header("Range"), "bytes=4-9")
                return Response(data[4:], 206, {"Content-Range": "bytes 4-9/10"})
            SETUP.download("https://example.invalid", target, item_for(data), open_url=opener)
            self.assertEqual(target.read_bytes(), data)
            self.assertFalse(target.with_suffix(".bin.part").exists())

    def test_ignored_range_restarts_without_appending_duplicate_bytes(self):
        data = b"0123456789"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "model.bin"
            target.with_suffix(".bin.part").write_bytes(data[:4])
            SETUP.download("https://example.invalid", target, item_for(data),
                           open_url=lambda *a, **k: Response(data))
            self.assertEqual(target.read_bytes(), data)

    def test_wrong_range_never_promotes_or_changes_partial(self):
        data = b"0123456789"
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "model.bin"
            partial = target.with_suffix(".bin.part")
            partial.write_bytes(data[:4])
            with self.assertRaisesRegex(RuntimeError, "续传位置"):
                SETUP.download("https://example.invalid", target, item_for(data), attempts=1,
                               open_url=lambda *a, **k: Response(data[4:], 206, {"Content-Range": "bytes 0-5/10"}))
            self.assertFalse(target.exists())
            self.assertEqual(partial.read_bytes(), data[:4])

    def test_hash_mismatch_removes_corrupt_partial_and_can_retry(self):
        data = b"good"
        replies = iter([Response(b"bad!"), Response(data)])
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "model.bin"
            SETUP.download("https://example.invalid", target, item_for(data),
                           open_url=lambda *a, **k: next(replies), sleep=lambda _: None)
            self.assertEqual(target.read_bytes(), data)

    def test_first_source_failure_switches_to_matching_mirror(self):
        data = b"public model"
        requests = []
        def opener(request, **kwargs):
            requests.append(request.full_url)
            if len(requests) == 1:
                raise urllib.error.URLError("first source unavailable")
            return Response(data)
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "model.bin"
            SETUP.download("https://huggingface.co/fixed/model", target, item_for(data),
                           open_url=opener, sleep=lambda _: None,
                           fallback_urls=["https://modelscope.cn/fixed/model"])
            self.assertEqual(requests, ["https://huggingface.co/fixed/model", "https://modelscope.cn/fixed/model"])
            self.assertEqual(target.read_bytes(), data)

    def test_git_blob_checksum_for_small_metadata(self):
        data = b'{"sample_rate": 24000}'
        item = {"size": len(data), "git_blob": hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()}
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "config.json"
            target.write_bytes(data)
            self.assertTrue(SETUP.verify(target, item))
            target.write_bytes(b"x" * len(data))
            self.assertFalse(SETUP.verify(target, item))

    def test_config_initialization_is_relative_and_preserves_existing_preferences(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            example = json.loads((ROOT / "local_config.example.json").read_text(encoding="utf-8-sig"))
            (root / "local_config.example.json").write_text(json.dumps(example), encoding="utf-8")
            SETUP.init_config(root)
            config = root / "local_config.json"
            first = json.loads(config.read_text(encoding="utf-8"))
            self.assertIsNone(first["resource_guard"])
            self.assertFalse(first["emotion_ready"])
            self.assertFalse(Path(first["custom_voice_model"]).is_absolute())
            first["preferred_port"] = 24164
            config.write_text(json.dumps(first), encoding="utf-8")
            SETUP.init_config(root)
            self.assertEqual(json.loads(config.read_text())["preferred_port"], 24164)

    def test_emotion_never_marked_ready_before_download_verification(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "local_config.example.json").write_text('{"emotion_model":"models/indextts-2.5"}')
            with self.assertRaisesRegex(RuntimeError, "尚未完整校验"):
                SETUP.complete_emotion(root)
            self.assertFalse(json.loads((root / "local_config.json").read_text())["emotion_ready"])

    def test_manifest_paths_cannot_escape_installation(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                SETUP.safe_path(Path(folder), "../outside")

    def test_distribution_downloads_are_fixed_and_hashed(self):
        manifest = json.loads((ROOT / "scripts/distribution_manifest.json").read_text())
        for name in ("uv", "ffmpeg", "emotion_source"):
            self.assertRegex(manifest[name]["sha256"], r"^[a-f0-9]{64}$")
            self.assertNotIn("/latest/", manifest[name]["url"])
            self.assertTrue(manifest[name]["url"].startswith("https://"))
        for model in manifest["models"]:
            self.assertRegex(model["revision"], r"^[a-f0-9]{40}$")
            for item in model["files"]:
                self.assertGreater(item["size"], 0)
                self.assertRegex(item.get("sha256") or item["git_blob"], r"^[a-f0-9]{40,64}$")
                for mirror in item.get("mirrors", []):
                    self.assertEqual(mirror["sha256"], item["sha256"])
                    self.assertRegex(mirror["revision"], r"^[a-f0-9]{40}$")


if __name__ == "__main__":
    unittest.main()
