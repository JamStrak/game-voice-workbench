"""Resumable installer corruption recovery without network or model files."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("emotion_download", ROOT / "scripts/setup_emotion.py")
download = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(download)


class Response(io.BytesIO):
    status = 206


class EmotionDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="voice-download-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.content = b"valid fixture"
        self.item = dict(repo="fixture/test", revision="pinned", remote="model.bin", path="model.bin",
                         size=len(self.content), sha256=hashlib.sha256(self.content).hexdigest(), git_blob="unused")

    def fetch(self, responses):
        with patch.object(download, "MODEL", self.root), \
             patch.object(download.urllib.request, "urlopen", side_effect=responses) as network, \
             patch.object(download.time, "sleep"):
            result = download.download(self.item)
        self.assertEqual((self.root / "model.bin").read_bytes(), self.content)
        self.assertFalse((self.root / "model.bin.part").exists())
        self.assertEqual(result["actual_sha256"], self.item["sha256"])
        return network

    def test_oversized_saved_partial_is_discarded_then_retried_from_zero(self):
        (self.root / "model.bin.part").write_bytes(b"broken" * 10)
        network = self.fetch([Response(self.content)])
        network.assert_called_once()
        self.assertEqual(network.call_args.args[0].get_header("Range"), "bytes=0-12")

    def test_downloaded_hash_mismatch_is_discarded_before_retry(self):
        network = self.fetch([Response(b"x" * len(self.content)), Response(self.content)])
        self.assertEqual(network.call_count, 2)
        self.assertTrue(all(call.args[0].get_header("Range") == "bytes=0-12" for call in network.call_args_list))

    def test_oversized_response_does_not_poison_next_retry(self):
        self.assertEqual(self.fetch([Response(self.content * 2), Response(self.content)]).call_count, 2)

    def test_empty_response_retries_instead_of_looping_forever(self):
        self.assertEqual(self.fetch([Response(b""), Response(self.content)]).call_count, 2)

    def test_complete_verified_file_is_never_replaced_or_downloaded(self):
        target = self.root / "model.bin"
        target.write_bytes(self.content)
        before = target.stat().st_mtime_ns
        with patch.object(download, "MODEL", self.root), \
             patch.object(download.urllib.request, "urlopen") as network:
            download.download(self.item)
        network.assert_not_called()
        self.assertEqual(target.stat().st_mtime_ns, before)
        self.assertEqual(target.read_bytes(), self.content)


if __name__ == "__main__":
    unittest.main()
