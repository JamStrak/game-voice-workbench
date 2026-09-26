"""Emotion intent must survive routing, retries, and exported take selection."""
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "upstream/voicebox"))

from fastapi import FastAPI, HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import models
from backend.database import Generation, VoiceProfile
from backend.database.models import Base
from backend.routes import generations, local_workbench
from backend.services import local_expression as expression

READY = {"ready": True, "analyzer_ready": True, "reason": None}
MANUAL = {"mode": "manual", "emotion": "angry", "intensity": "strong", "instruction": ""}
AUTO = {"mode": "auto", "emotion": "calm", "intensity": "medium", "instruction": "压着怒气"}


class ExpressionSchemaTests(unittest.TestCase):
    def test_manual_choice_overrides_stale_auto_description(self):
        selected = models.ExpressionConfig(mode="manual", emotion="sad", instruction="开心地说")
        self.assertEqual(selected.emotion, "sad")
        self.assertEqual(selected.instruction, "")
        self.assertEqual(models.ExpressionConfig(mode="auto", instruction="  压着怒气  ").instruction, "压着怒气")

    def test_only_supported_modes_emotions_intensities_and_short_description(self):
        for value in ({"mode": "guess"}, {"emotion": "unknown"}, {"intensity": "extreme"}, {"instruction": "a" * 201}):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                models.ExpressionConfig(**value)

    def test_saved_envelope_round_trips_and_legacy_text_is_not_reinterpreted(self):
        result = {"resolved_emotion": "angry", "vector": [0, 1, 0, 0, 0, 0, 0, 0], "analyzer": "manual"}
        encoded = expression.encode_expression(MANUAL, result)
        self.assertEqual(expression.decode_expression(encoded), (MANUAL, result))
        for legacy in (None, "", "愤怒地说", "{broken", "[]", '{"expression":"happy"}',
                       '{"expression":{}}', '{"expression":{"mode":"bogus"}}',
                       '{"expression":{"mode":"auto"},"prompt":"old prompt"}'):
            with self.subTest(legacy=legacy):
                self.assertEqual(expression.decode_expression(legacy), (None, None))

    def test_unavailable_emotion_cannot_silently_become_natural(self):
        unavailable = {"ready": False, "analyzer_ready": False, "reason": "尚未验证"}
        with patch.object(expression, "expression_capabilities", return_value=unavailable):
            self.assertEqual(expression.validate_expression(None)["mode"], "natural")
            for config in (MANUAL, AUTO):
                with self.assertRaisesRegex(ValueError, "尚未验证"):
                    expression.validate_expression(config)
        with patch.object(expression, "expression_capabilities", return_value={**READY, "analyzer_ready": False, "reason": "分析未就绪"}):
            self.assertEqual(expression.validate_expression(MANUAL), MANUAL)
            with self.assertRaisesRegex(ValueError, "分析未就绪"):
                expression.validate_expression(AUTO)
        with self.assertRaisesRegex(ValueError, "支持"):
            expression.validate_expression(MANUAL, "de")

    def test_capability_requires_validation_flags_and_every_model_component(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model = root / "models/indextts-2.5"
            for name in expression.CORE_FILES + ("gpt.pth", "codec.pth", "s2mel.pth", "qwen0.6bemo4-merge/model.safetensors", "qwen0.6bemo4-merge/config.json", "qwen0.6bemo4-merge/tokenizer.json"):
                path = model / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x")
            python = root / ".venv-emotion/Scripts/python.exe"
            python.parent.mkdir(parents=True)
            python.write_bytes(b"x")
            config = root / "local_config.json"
            config.write_text("{}")
            with patch.object(expression, "ROOT", root), patch.object(expression, "CORE_WEIGHTS", {key: 1 for key in expression.CORE_WEIGHTS}), patch.object(expression, "ANALYZER_WEIGHT_BYTES", 1):
                self.assertFalse(expression.expression_capabilities()["ready"])
                config.write_text(json.dumps({"emotion_ready": True, "emotion_analyzer_ready": True}))
                self.assertEqual(expression.expression_capabilities(), READY)
                (model / "qwen0.6bemo4-merge/model.safetensors").unlink()
                capability = expression.expression_capabilities()
                self.assertTrue(capability["ready"])
                self.assertFalse(capability["analyzer_ready"])
                (model / "hf_cache/campplus_cn_common.bin").unlink()
                self.assertFalse(expression.expression_capabilities()["ready"])

    def test_manual_routes_presets_and_clones_to_index_with_no_model_size(self):
        for profile in (SimpleNamespace(voice_type="preset", preset_engine="qwen_custom_voice", preset_voice_id="Ryan"),
                        SimpleNamespace(voice_type="cloned")):
            request = models.GenerationRequest(profile_id="p", text="台词", expression=MANUAL, language="zh")
            with patch.object(expression, "expression_capabilities", return_value=READY):
                engine, size, instruct = generations.prepare_generation(request, profile)
            self.assertEqual(engine, "indextts")
            self.assertIsNone(size)
            self.assertEqual(expression.decode_expression(instruct)[0], MANUAL)

    def test_natural_qwen_rejects_an_instruction_it_cannot_execute(self):
        request = models.GenerationRequest(profile_id="p", text="台词", instruct="愤怒地说", language="zh")
        with self.assertRaisesRegex(HTTPException, "不支持语气指令"):
            generations.prepare_generation(request, SimpleNamespace(voice_type="cloned"))

    def test_explicit_natural_keeps_qwen_instruction_empty(self):
        request = models.GenerationRequest(profile_id="p", text="台词", expression={"mode": "natural"}, language="zh")
        engine, size, instruct = generations.prepare_generation(request, SimpleNamespace(voice_type="cloned"))
        self.assertEqual((engine, size, instruct), ("qwen", "0.6B", None))

    def test_emotion_text_limit_does_not_reduce_natural_text_limit(self):
        profile = SimpleNamespace(voice_type="cloned")
        with patch.object(expression, "expression_capabilities", return_value=READY):
            with self.assertRaisesRegex(HTTPException, "2000"):
                generations.prepare_generation(models.GenerationRequest(profile_id="p", text="字" * 2001, expression=MANUAL), profile)
            self.assertEqual(generations.prepare_generation(models.GenerationRequest(profile_id="p", text="字" * 2001), profile)[0], "qwen")


class ExpressionPersistenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.profile = VoiceProfile(id="voice", name="Emotion regression", voice_type="preset",
                                    preset_engine="qwen_custom_voice", preset_voice_id="Ryan", language="zh")
        self.db.add(self.profile)
        self.db.commit()
        self.app = FastAPI()
        local_workbench.register_local_routes(self.app)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def route(self, path, method="GET"):
        return next(route.endpoint for route in self.app.routes if route.path == path and method in route.methods)

    def line(self, number, selected=None):
        return dict(number=number, role="角色", profile_id="voice", text="你怎么能这样！", expression=selected or {"mode": "natural"})

    async def test_batch_checks_later_unsupported_emotion_before_first_enqueue(self):
        batch = local_workbench.Batch(lines=[self.line("A001"), self.line("A002", MANUAL)])
        with patch.object(expression, "expression_capabilities", return_value={"ready": False, "analyzer_ready": False, "reason": "模型未就绪"}), patch.object(local_workbench, "enqueue", new=AsyncMock()) as enqueue:
            with self.assertRaises(HTTPException):
                await self.route("/local/batches", "POST")(batch, self.db)
            enqueue.assert_not_awaited()
            self.assertEqual(self.db.query(Generation).count(), 0)

    async def test_analysis_rejects_manual_and_unavailable_auto_before_worker(self):
        with patch("backend.services.local_inference.analyze_expression", new=AsyncMock()) as worker:
            for mode in ("manual", "natural"):
                with self.assertRaises(HTTPException):
                    await self.route("/local/expression/analyze", "POST")(models.ExpressionAnalysisRequest(text="台词", expression={"mode": mode}))
            with patch.object(expression, "expression_capabilities", return_value={"ready": True, "analyzer_ready": False, "reason": "分析未就绪"}):
                with self.assertRaises(HTTPException):
                    await self.route("/local/expression/analyze", "POST")(models.ExpressionAnalysisRequest(text="台词"))
            worker.assert_not_awaited()

    async def test_generation_stores_manual_intent_and_retry_retains_none_size(self):
        request = models.GenerationRequest(profile_id="voice", text="台词", language="zh", expression=MANUAL)
        captured = []

        def accept(_id, coroutine):
            captured.append(coroutine)
            coroutine.close()

        with patch.object(expression, "expression_capabilities", return_value=READY), patch.object(generations, "enqueue_generation", side_effect=accept), patch.object(generations, "get_task_manager", return_value=Mock()), patch.object(generations, "run_generation", new=AsyncMock()) as run:
            response = await generations.generate_speech(request, self.db)
            gen = self.db.query(Generation).filter_by(id=response.id).one()
            self.assertEqual(gen.expression, MANUAL)
            self.assertEqual(response.expression.model_dump(), MANUAL)
            self.assertEqual(gen.engine, "indextts")
            self.assertIsNone(gen.model_size)
            gen.status = "failed"
            self.db.commit()
            await generations.retry_generation(gen.id, self.db)
            self.assertIsNone(run.call_args.kwargs["model_size"])
            self.assertEqual(expression.decode_expression(run.call_args.kwargs["instruct"])[0], MANUAL)

    async def test_retry_unavailable_engine_leaves_failed_record_unchanged(self):
        gen = Generation(id="failed", profile_id="voice", text="台词", language="zh", status="failed",
                         engine="indextts", instruct=expression.encode_expression(MANUAL), error="保留错误")
        self.db.add(gen)
        self.db.commit()
        with patch.object(expression, "expression_capabilities", return_value={"ready": False, "analyzer_ready": False, "reason": "未就绪"}), patch.object(generations, "enqueue_generation") as enqueue:
            with self.assertRaises(HTTPException):
                await generations.retry_generation(gen.id, self.db)
            enqueue.assert_not_called()
            self.assertEqual(gen.status, "failed")
            self.assertEqual(gen.error, "保留错误")

    async def test_single_history_response_preserves_saved_expression_and_analysis(self):
        # Load the app first because this route imports its disposition helper.
        from backend.app import app
        from backend.routes.history import get_generation

        result = {"resolved_emotion": "happy", "summary": "开心", "vector": [1, 0, 0, 0, 0, 0, 0, 0],
                  "applied_vector": [0.5625, 0, 0, 0, 0, 0, 0, 0], "analyzer": "IndexTTS-QwenEmotion"}
        for record_id, selected, saved_result in (("history-auto", AUTO, result), ("history-manual", MANUAL, None)):
            with self.subTest(record_id=record_id):
                instruct = expression.encode_expression(selected, saved_result)
                self.db.add(Generation(id=record_id, profile_id="voice", text="历史台词", language="zh",
                                       engine="indextts", status="completed", instruct=instruct))
                self.db.commit()
                response = (await get_generation(record_id, self.db)).model_dump(mode="json")
                self.assertEqual(response["expression"], selected)
                self.assertEqual(response["expression_result"], saved_result)
                self.assertEqual(response["instruct"], instruct)
                self.assertEqual(response["profile_name"], self.profile.name)

        self.db.add(Generation(id="history-legacy", profile_id="voice", text="旧台词", language="zh",
                               status="completed", instruct="旧版语气说明"))
        self.db.commit()
        legacy = (await get_generation("history-legacy", self.db)).model_dump(mode="json")
        self.assertIsNone(legacy["expression"])
        self.assertIsNone(legacy["expression_result"])
        self.assertEqual(legacy["instruct"], "旧版语气说明")

    async def test_selected_take_export_uses_its_own_expression_not_latest_line_setting(self):
        result = {"resolved_emotion": "angry", "summary": "愤怒", "vector": [0, 1, 0, 0, 0, 0, 0, 0], "analyzer": "manual"}
        gen = Generation(id="selected", profile_id="voice", text="旧台词", language="zh", status="completed",
                         audio_path="selected.wav", engine="indextts", instruct=expression.encode_expression(MANUAL, result))
        self.db.add(gen)
        self.db.commit()
        batch = dict(id="batch", lines=[dict(number="A001", role="角色", text="新台词", expression=AUTO,
                                             generations=["selected"], preferred_generation_id="selected")])
        with tempfile.TemporaryDirectory() as folder:
            audio = Path(folder) / "selected.wav"
            audio.write_bytes(b"test wav bytes")
            with patch.object(local_workbench, "read_batch", return_value=batch), patch.object(local_workbench.config, "resolve_storage_path", return_value=audio):
                response = await self.route("/local/batches/{batch_id}/export")("batch", self.db)
                content = b"".join([chunk async for chunk in response.body_iterator])
                takes = (await self.route("/local/batches/{batch_id}")("batch", self.db))["lines"][0]["takes"]
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                manifest = json.loads(archive.read("台词清单.json"))[0]
            self.assertEqual(manifest["expression"], MANUAL)
            self.assertEqual(manifest["expression_result"], result)
            self.assertEqual(manifest["text"], "旧台词")
            self.assertEqual(manifest["engine"], "indextts")
            self.assertEqual(takes[0]["expression"], MANUAL)
            self.assertEqual(takes[0]["expression_result"], result)

    def test_old_plain_instruction_has_no_synthetic_expression_metadata(self):
        gen = Generation(id="legacy", profile_id="voice", text="旧台词", language="zh", status="completed", instruct="开心地说")
        self.db.add(gen)
        self.db.commit()
        response = models.GenerationResponse.model_validate(gen)
        self.assertIsNone(response.expression)
        self.assertIsNone(response.expression_result)
        self.assertEqual(response.instruct, "开心地说")


if __name__ == "__main__":
    unittest.main()
