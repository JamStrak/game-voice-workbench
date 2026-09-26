"""Library previews are real assets; customizing never changes the source voice."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch
import wave
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "upstream/voicebox"))

from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from backend import config, models
from backend.database import Generation, GenerationVersion, ProfileSample, VoiceProfile
from backend.database.models import Base
from backend.database.migrations import run_migrations
from backend.routes import generations, local_workbench
from backend.routes.local_voice_library import VariantRequest, get_library_audio
from backend.services import local_voice_library as library, profiles
from backend.services.local_expression import decode_expression

READY = {"ready": True, "analyzer_ready": True, "reason": None}
HAPPY = {"mode": "manual", "emotion": "happy", "intensity": "medium", "instruction": ""}


class VoiceLibraryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp.name)
        self.data_patch = patch.object(config, "_data_dir", self.data_dir)
        self.data_patch.start()
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.catalog = {"schema_version": 1, "voices": [{
            "id": "qwen-ryan", "name": "Ryan · 活力男声", "speaker": "Ryan", "gender": "male",
            "native_language": "en", "description": "英语底色的男声", "tags": ["男声"],
            "samples": [
                {"id": "natural", "label": "自然", "text": "你好", "language": "zh", "status": "ready",
                 "audio_path": "qwen-ryan/natural.wav", "expression": {"mode": "natural"}, "duration": 0.1},
                {"id": "happy", "label": "开心", "text": "成功了", "language": "zh", "status": "pending",
                 "audio_path": "qwen-ryan/happy.wav", "expression": HAPPY, "duration": None},
            ]}]}
        self.write_catalog()
        self.audio = self.data_dir / "voice-library/audio/qwen-ryan/natural.wav"
        self.audio.parent.mkdir(parents=True)
        self.write_wav(self.audio)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.data_patch.stop()
        self.temp.cleanup()

    def write_catalog(self):
        path = self.data_dir / "voice-library/catalog.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.catalog, ensure_ascii=False), encoding="utf-8")

    def write_wav(self, path):
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(b"\x01\x00" * 2400)

    def variant(self, **kwargs):
        return library.create_variant("qwen-ryan", VariantRequest(
            name=kwargs.pop("name", "项目角色"), expression=HAPPY,
            effects_chain=[{"type": "tempo", "params": {"speed": 1.25}},
                           {"type": "pitch", "params": {"semitones": -2}}], **kwargs), self.db)

    async def test_read_catalog_has_no_creation_side_effect_and_only_plays_real_ready_files(self):
        result = library.catalog_listing(self.db)
        self.assertEqual(self.db.query(VoiceProfile).count(), 0)
        voice = result["voices"][0]
        self.assertIsNone(voice["profile_id"])
        self.assertEqual(voice["ready_samples"], 1)
        self.assertIsNone(voice["samples"][1]["audio_url"])
        response = await get_library_audio("qwen-ryan", "natural")
        self.assertEqual(Path(response.path), self.audio)
        with self.assertRaises(HTTPException):
            await get_library_audio("qwen-ryan", "happy")
        self.audio.unlink()
        sample = library.catalog_listing(self.db)["voices"][0]["samples"][0]
        self.assertEqual(sample["status"], "failed")
        self.assertIsNone(sample["audio_url"])

    async def test_catalog_cannot_serve_an_outside_or_invalid_wav(self):
        outside = self.data_dir / "other.wav"
        self.write_wav(outside)
        self.catalog["voices"][0]["samples"][0]["audio_path"] = "../../other.wav"
        self.write_catalog()
        with self.assertRaises(HTTPException):
            await get_library_audio("qwen-ryan", "natural")
        self.catalog["voices"][0]["samples"][0]["audio_path"] = "qwen-ryan/natural.wav"
        self.write_catalog()
        self.audio.write_bytes(b"not an audio file" * 10)
        self.assertIsNone(library.catalog_listing(self.db)["voices"][0]["samples"][0]["audio_url"])

    def test_use_is_idempotent_and_does_not_adopt_existing_personal_profile(self):
        user_profile = VoiceProfile(id="mine", name="Ryan", voice_type="preset", preset_voice_id="Ryan",
                                    preset_engine="qwen_custom_voice", default_engine="qwen_custom_voice")
        self.db.add(user_profile)
        self.db.commit()
        first = library.ensure_builtin_profile("qwen-ryan", self.db)
        second = library.ensure_builtin_profile("qwen-ryan", self.db)
        self.assertEqual(first.id, second.id)
        self.assertEqual(first.id, library.builtin_profile_id("qwen-ryan"))
        self.assertTrue(first.is_builtin)
        self.assertFalse(user_profile.is_builtin)
        self.assertEqual(self.db.query(VoiceProfile).count(), 2)

    async def test_all_profile_mutations_reject_builtin_without_touching_files(self):
        from backend.app import app
        from backend.routes import profiles as profile_routes
        builtin = library.ensure_builtin_profile("qwen-ryan", self.db)
        sample = ProfileSample(id="sample", profile_id=builtin.id, audio_path=str(self.audio), reference_text="不可编辑")
        self.db.add(sample)
        self.db.commit()
        actions = [
            lambda: profiles.update_profile(builtin.id, models.VoiceProfileCreate(name="改名"), self.db),
            lambda: profiles.delete_profile(builtin.id, self.db),
            lambda: profiles.add_profile_sample(builtin.id, str(self.audio), "新的参考", self.db),
            lambda: profiles.delete_profile_sample(sample.id, self.db),
            lambda: profiles.update_profile_sample(sample.id, "修改文本", self.db),
            lambda: profiles.upload_avatar(builtin.id, "missing.png", self.db),
            lambda: profiles.delete_avatar(builtin.id, self.db),
            lambda: profile_routes.update_profile_effects(builtin.id, models.ProfileEffectsUpdate(effects_chain=[]), self.db),
            lambda: profile_routes.add_profile_sample(builtin.id, UploadFile(io.BytesIO(b"bad"), filename="file.wav"), "文本", self.db),
            lambda: profile_routes.upload_profile_avatar(builtin.id, UploadFile(io.BytesIO(b"bad"), filename="file.png"), self.db),
        ]
        for action in actions:
            with self.subTest(action=action), self.assertRaises(HTTPException) as caught:
                await action()
            self.assertEqual(caught.exception.status_code, 403)
        self.assertTrue(self.audio.is_file())
        self.assertEqual(self.db.query(VoiceProfile).filter_by(id=builtin.id).one().name, builtin.name)
        self.assertEqual(sample.reference_text, "不可编辑")

    async def test_variant_keeps_source_unchanged_and_saves_editable_project_defaults(self):
        builtin = library.ensure_builtin_profile("qwen-ryan", self.db)
        variant = self.variant(project_name="新项目")
        self.assertNotEqual(variant.id, builtin.id)
        self.assertFalse(variant.is_builtin)
        self.assertEqual(variant.default_expression.model_dump(), HAPPY)
        self.assertEqual(variant.project_name, "新项目")
        self.assertEqual(variant.preset_voice_id, "Ryan")
        self.assertEqual(variant.effects_chain[1].params["semitones"], -2)
        await profiles.update_profile(variant.id, models.VoiceProfileCreate(name=variant.name, language="zh",
                                      default_expression={"mode": "manual", "emotion": "sad"}, project_name="续作"), self.db)
        edited = await profiles.get_profile(variant.id, self.db)
        self.assertEqual(edited.default_expression.emotion, "sad")
        self.assertEqual(edited.project_name, "续作")
        self.assertEqual(edited.library_voice_id, "qwen-ryan")
        await profiles.update_profile(variant.id, models.VoiceProfileCreate(name="只改名字", language="zh"), self.db)
        self.assertEqual((await profiles.get_profile(variant.id, self.db)).default_expression.emotion, "sad")
        mother = await profiles.get_profile(builtin.id, self.db)
        self.assertEqual(mother.default_expression.mode, "natural")
        self.assertIsNone(mother.effects_chain)

    async def test_profile_defaults_reach_generation_and_batch_but_explicit_natural_wins(self):
        variant = self.variant()
        with patch("backend.services.local_expression.expression_capabilities", return_value=READY):
            request = models.GenerationRequest(profile_id=variant.id, text="好消息", language="zh")
            engine, size, instruct = generations.prepare_generation(request, variant)
            self.assertEqual(engine, "indextts")
            self.assertEqual(decode_expression(instruct)[0], HAPPY)
            natural = request.model_copy(update={"expression": models.ExpressionConfig(mode="natural")})
            engine, size, instruct = generations.prepare_generation(natural, variant)
            self.assertEqual((engine, size, instruct), ("qwen_custom_voice", "0.6B", None))
            line = local_workbench.Line(number="A001", role="角色", profile_id=variant.id, text="好消息")
            batch_request = local_workbench.generation_request(line.model_dump(), self.db)
            self.assertEqual(decode_expression(generations.prepare_generation(batch_request, variant)[2])[0], HAPPY)
            with patch.object(generations, "get_task_manager", return_value=Mock()), patch.object(generations, "run_generation", new=AsyncMock()) as run, patch.object(generations, "enqueue_generation", side_effect=lambda _id, coro: coro.close()):
                response = await generations.generate_speech(request, self.db)
                self.assertEqual(response.expression.emotion, "happy")
                self.assertEqual(run.call_args.kwargs["effects_chain"][0]["params"]["speed"], 1.25)
                self.assertEqual(run.call_args.kwargs["effects_chain"][1]["params"]["semitones"], -2)
                row = self.db.query(Generation).filter_by(id=response.id).one()
                self.assertEqual(json.loads(row.effects_chain_snapshot), run.call_args.kwargs["effects_chain"])
                row.status = "failed"
                profile = self.db.query(VoiceProfile).filter_by(id=variant.id).one()
                profile.effects_chain = json.dumps([{"type": "tempo", "params": {"speed": 0.75}}])
                self.db.commit()
                await generations.retry_generation(response.id, self.db)
                self.assertEqual(run.call_args.kwargs["effects_chain"][0]["params"]["speed"], 1.25)
                self.assertEqual(run.call_args.kwargs["effects_chain"][1]["params"]["semitones"], -2)

    async def test_library_emotion_reference_matches_the_natural_preview(self):
        from backend.services.local_inference import reference_for
        builtin = library.ensure_builtin_profile("qwen-ryan", self.db)
        variant = self.variant()
        with patch("backend.database.get_db", side_effect=lambda: iter([self.db])), patch.object(self.db, "close"), patch("backend.services.local_inference.run_worker", new=AsyncMock()) as worker:
            for profile_id in (builtin.id, variant.id):
                reference = await reference_for(profile_id, self.data_dir / "job", {"custom_voice_revision": "old-cache"}, 123)
                self.assertEqual(Path(reference), self.audio)
            self.audio.unlink()
            with self.assertRaisesRegex(ValueError, "自然试听尚未就绪"):
                await reference_for(variant.id, self.data_dir / "job", {}, 123)
            worker.assert_not_awaited()

    async def test_profile_zip_preserves_variant_settings_and_cannot_import_a_builtin(self):
        from backend.services.export_import import export_profile_to_zip, import_profile_from_zip
        variant = self.variant(project_name="角色项目")
        archive = export_profile_to_zip(variant.id, self.db)
        with zipfile.ZipFile(io.BytesIO(archive)) as original:
            manifest = json.loads(original.read("manifest.json"))
            samples = original.read("samples.json")
        self.assertEqual(manifest["profile"]["default_expression"], HAPPY)
        self.assertEqual(manifest["profile"]["project_name"], "角色项目")
        self.assertEqual(json.loads(samples), {})
        manifest["profile"].update(is_builtin=True, id=library.builtin_profile_id("qwen-ryan"),
                                    library_meta={"is_template": True})
        tampered = io.BytesIO()
        with zipfile.ZipFile(tampered, "w") as output:
            output.writestr("manifest.json", json.dumps(manifest))
            output.writestr("samples.json", samples)
        imported = await import_profile_from_zip(tampered.getvalue(), self.db)
        self.assertNotEqual(imported.id, variant.id)
        self.assertNotEqual(imported.id, library.builtin_profile_id("qwen-ryan"))
        self.assertFalse(imported.is_builtin)
        self.assertEqual(imported.default_expression.model_dump(), HAPPY)
        self.assertEqual(imported.project_name, "角色项目")
        self.assertEqual(imported.library_voice_id, "qwen-ryan")
        self.assertEqual(imported.voice_type, "preset")
        self.assertEqual(imported.preset_voice_id, "Ryan")
        self.assertEqual([e.model_dump() for e in imported.effects_chain], [e.model_dump() for e in variant.effects_chain])

    def test_pending_samples_are_not_user_clones_and_existing_clone_preview_is_pinned(self):
        clone = VoiceProfile(id="clone", name="个人克隆", voice_type="cloned", default_engine="qwen")
        self.db.add(clone)
        self.db.add(Generation(id="g", profile_id="clone", text="真实历史试听", language="zh", status="completed",
                               duration=0.1, audio_path=str(self.audio)))
        self.db.add(GenerationVersion(id="v", generation_id="g", label="original", audio_path=str(self.audio), is_default=True))
        self.db.commit()
        result = library.catalog_listing(self.db)
        self.assertEqual(result["voices"][0]["kind"], "builtin")
        self.assertEqual(result["voices"][0]["samples"][1]["status"], "pending")
        self.assertEqual(result["personal_voices"][0]["kind"], "clone")
        self.assertEqual(result["personal_voices"][0]["samples"][0]["audio_url"], "/audio/version/v")

    def test_invalid_variant_effects_fail_without_creating_a_profile(self):
        for effect in ({"type": "tempo", "params": {"speed": 1.6}}, {"type": "pitch", "params": {"semitones": 5}}):
            with self.subTest(effect=effect), self.assertRaises(HTTPException):
                library.create_variant("qwen-ryan", VariantRequest(name="错误参数", effects_chain=[effect]), self.db)
        self.assertEqual(self.db.query(VoiceProfile).count(), 0)


class LibraryMigrationTests(unittest.TestCase):
    def test_old_profile_is_preserved_and_new_column_migration_is_idempotent(self):
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as db:
            db.execute(text("CREATE TABLE profiles (id VARCHAR PRIMARY KEY, name VARCHAR)"))
            db.execute(text("INSERT INTO profiles (id, name) VALUES ('old', '我的声音')"))
        try:
            run_migrations(engine)
            run_migrations(engine)
            self.assertIn("library_meta", {c["name"] for c in inspect(engine).get_columns("profiles")})
            with engine.connect() as db:
                self.assertEqual(db.execute(text("SELECT name, library_meta FROM profiles WHERE id='old'")).one(), ("我的声音", None))
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
