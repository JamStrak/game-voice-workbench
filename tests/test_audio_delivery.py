"""Audio caching and library I/O checks without importing speech-model stacks."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "upstream/voicebox"))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from backend import config
from backend.database import Generation, GenerationVersion, VoiceProfile, get_db
from backend.database.models import Base
from backend.routes import audio
import backend.services as services


def isolated_library_module():
    # The library's profile serializer imports Torch through cloning utilities.
    # These tests exercise SQL/filesystem behavior using a tiny serializer only;
    # do not alter the real services module used by other test suites.
    serializer = SimpleNamespace(_profile_to_response=lambda profile: SimpleNamespace(
        model_dump=lambda **kw: {"id": profile.id, "name": profile.name}))
    spec = importlib.util.spec_from_file_location(
        "backend.services._library_delivery_test", ROOT / "upstream/voicebox/backend/services/local_voice_library.py")
    module = importlib.util.module_from_spec(spec)
    module_key = "backend.services.profiles"
    missing = object()
    previous = sys.modules.get(module_key, missing)
    sys.modules[module_key] = serializer
    try:
        with patch.object(services, "profiles", serializer, create=True):
            spec.loader.exec_module(module)
    finally:
        # Restore only our stub. Restoring the whole sys.modules mapping also
        # discards real modules loaded meanwhile, breaking NumPy and Pydantic
        # class identity when the remaining suites import those modules again.
        if previous is missing:
            sys.modules.pop(module_key, None)
        else:
            sys.modules[module_key] = previous
    return module


library = isolated_library_module()


class AudioDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data_patch = patch.object(config, "_data_dir", self.root)
        self.data_patch.start()
        self.audio = self.root / "voice-library/audio/qwen-ryan/natural.wav"
        self.audio.parent.mkdir(parents=True)
        self.write_wav(self.audio)
        self.catalog_path = self.root / "voice-library/catalog.json"
        self.catalog = {"schema_version": 1, "voices": [{
            "id": "qwen-ryan", "speaker": "Ryan", "name": "Ryan", "samples": [{
                "id": "natural", "status": "ready", "audio_path": "qwen-ryan/natural.wav"}]}]}
        self.catalog_path.write_text(json.dumps(self.catalog), encoding="utf-8")
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        with self.Session() as db:
            db.add(VoiceProfile(id="profile", name="Test", language="zh"))
            db.add(Generation(id="generation", profile_id="profile", text="你好", language="zh", status="completed",
                              audio_path=str(self.audio), duration=0.1))
            db.add(GenerationVersion(id="version", generation_id="generation", audio_path=str(self.audio), label="take 1", is_default=True))
            db.commit()
        app = FastAPI()
        app.include_router(audio.router)
        def get_session():
            with self.Session() as db:
                yield db
        app.dependency_overrides[get_db] = get_session
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.engine.dispose()
        self.data_patch.stop()
        self.temp.cleanup()

    def write_wav(self, path, value=1):
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(bytes((value, 0)) * 2400)

    def test_version_conditional_request_is_bodyless_and_immutable(self):
        response = self.client.get("/audio/version/version")
        self.assertEqual(response.status_code, 200)
        self.assertIn("immutable", response.headers["cache-control"])
        for validator in (response.headers["etag"], "W/" + response.headers["etag"], '"old", ' + response.headers["etag"], "*"):
            conditional = self.client.get("/audio/version/version", headers={"If-None-Match": validator})
            self.assertEqual(conditional.status_code, 304)
            self.assertEqual(conditional.content, b"")
        dated = self.client.get("/audio/version/version", headers={"If-Modified-Since": response.headers["last-modified"]})
        self.assertEqual(dated.status_code, 304)

    def test_default_pointer_revalidates_after_selected_version_changes(self):
        old = self.client.get("/audio/generation")
        self.assertEqual(old.headers["cache-control"], "private, no-cache")
        replacement = self.root / "replacement.wav"
        self.write_wav(replacement, value=2)
        # Same file length and timestamp still has a distinct pointer identity.
        old_stat = self.audio.stat()
        os.utime(replacement, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
        with self.Session() as db:
            db.query(Generation).filter_by(id="generation").update({"audio_path": str(replacement)})
            db.commit()
        changed = self.client.get("/audio/generation", headers={"If-None-Match": old.headers["etag"]})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["etag"], old.headers["etag"])
        self.assertEqual(changed.content, replacement.read_bytes())
        dated = self.client.get("/audio/generation", headers={"If-Modified-Since": old.headers["last-modified"]})
        self.assertEqual(dated.status_code, 200)
        self.assertEqual(dated.content, replacement.read_bytes())
        self.assertEqual(self.client.get("/audio/version/version").content, self.audio.read_bytes())

    def test_range_and_if_range_keep_existing_semantics(self):
        whole = self.client.get("/audio/version/version")
        partial = self.client.get("/audio/version/version", headers={"Range": "bytes=0-1023", "If-Range": whole.headers["etag"]})
        self.assertEqual(partial.status_code, 206)
        self.assertEqual(partial.content, whole.content[:1024])
        self.assertEqual(partial.headers["content-range"], f"bytes 0-1023/{len(whole.content)}")
        changed = self.client.get("/audio/version/version", headers={"Range": "bytes=0-1023", "If-Range": '"stale"'})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.content, whole.content)
        outside = self.client.get("/audio/version/version", headers={"Range": "bytes=999999-"})
        self.assertEqual(outside.status_code, 416)

    def test_etag_precedes_modified_since_and_deleted_files_are_not_revalidated(self):
        original = self.client.get("/audio/generation")
        response = self.client.get("/audio/generation", headers={
            "If-None-Match": '"stale"', "If-Modified-Since": original.headers["last-modified"]})
        self.assertEqual(response.status_code, 200)
        self.audio.unlink()
        missing = self.client.get("/audio/generation", headers={"If-None-Match": original.headers["etag"]})
        self.assertEqual(missing.status_code, 404)

    def test_catalog_cache_reuses_parse_but_isolates_and_invalidates_edits(self):
        library._read_catalog.cache_clear()
        with patch.object(library.json, "loads", wraps=json.loads) as loads:
            first = library.read_catalog()
            first["voices"][0]["name"] = "Caller edit"
            self.assertEqual(library.read_catalog()["voices"][0]["name"], "Ryan")
            self.assertEqual(loads.call_count, 1)
            self.catalog["voices"][0]["name"] = "Updated voice"
            self.catalog_path.write_text(json.dumps(self.catalog), encoding="utf-8")
            self.assertEqual(library.read_catalog()["voices"][0]["name"], "Updated voice")
            self.assertEqual(loads.call_count, 2)
        self.catalog_path.unlink()
        self.assertEqual(library.read_catalog()["voices"], [])

    def test_wav_cache_invalidates_replacement_and_deleted_files(self):
        sample = self.catalog["voices"][0]["samples"][0]
        library._valid_wav.cache_clear()
        with patch.object(library.wave, "open", wraps=wave.open) as opened:
            self.assertEqual(library.sample_path(sample), self.audio)
            self.assertEqual(library.sample_path(sample), self.audio)
            self.assertEqual(opened.call_count, 1)
            self.audio.write_bytes(b"invalid WAV")
            self.assertIsNone(library.sample_path(sample))
            self.assertEqual(opened.call_count, 2)
            self.audio.unlink()
            self.assertIsNone(library.sample_path(sample))

    def test_personal_library_uses_two_queries_and_current_default_without_database_cache(self):
        with self.Session() as db:
            for number in range(12):
                profile = f"p{number}"
                db.add(VoiceProfile(id=profile, name=profile, language="zh"))
                for take in range(5):
                    gen = f"g{number}-{take}"
                    db.add(Generation(id=gen, profile_id=profile, text="试听", language="zh", status="completed", duration=0.1, audio_path=str(self.audio)))
                    db.add(GenerationVersion(id=f"v{number}-{take}", generation_id=gen, label="raw", is_default=True, audio_path=str(self.audio)))
            db.commit()
            statements = []
            def record(*args): statements.append(args[2])
            event.listen(self.engine, "before_cursor_execute", record)
            try:
                listing = library.catalog_listing(db)
                self.assertEqual(len(statements), 2)
            finally:
                event.remove(self.engine, "before_cursor_execute", record)
            self.assertTrue(all(len(p["samples"]) == 3 for p in listing["personal_voices"] if p["id"] != "profile"))
            db.query(GenerationVersion).filter_by(id="version").update({"is_default": False})
            db.add(GenerationVersion(id="new-version", generation_id="generation", label="effect", is_default=True, audio_path=str(self.audio)))
            db.commit()
            updated = next(p for p in library.catalog_listing(db)["personal_voices"] if p["id"] == "profile")
            self.assertEqual(updated["samples"][0]["audio_url"], "/audio/version/new-version")


if __name__ == "__main__":
    unittest.main()
