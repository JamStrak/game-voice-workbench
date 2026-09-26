"""Publication boundary regressions; never access personal files or GitHub."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("distribution_build", ROOT / "scripts/build_distribution.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class DistributionBoundaryTests(unittest.TestCase):
    def test_rejects_local_config_user_audio_database_and_models(self):
        for name in ("local_config.json", "data/profiles/voice.wav", "data/voicebox.db", "models/weights.bin"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"private fixture")
                with self.assertRaises(ValueError):
                    build.audit(Path(directory))

    def test_allows_builtin_samples_and_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "data/voice-library/audio/voice/natural.wav"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"RIFF test fixture")
            (root / "README.md").write_text("Public fixture", encoding="utf-8")
            result = build.audit(root)
            self.assertEqual(result["file_count"], 2)
            self.assertEqual(len(result["files"][0]["sha256"]), 64)

    def test_rejects_token_and_private_machine_paths(self):
        fixtures = ["ghp_" + "a" * 36, "C:" + "/Users/" + "Jam" + "/secret"]
        for fixture in fixtures:
            with tempfile.TemporaryDirectory() as directory:
                (Path(directory) / "bad.txt").write_text(fixture, encoding="utf-8")
                with self.assertRaises(ValueError):
                    build.audit(Path(directory))

    def test_existing_destination_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "keep.txt").write_text("keep", encoding="utf-8")
            with self.assertRaises(ValueError):
                build.build(ROOT, folder)
            self.assertEqual((folder / "keep.txt").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
