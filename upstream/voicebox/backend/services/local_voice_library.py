"""Immutable curated voice cards, real previews, and independent user variants."""
import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
import re
import stat
import uuid
import wave

from fastapi import HTTPException
from sqlalchemy import and_, func

from .. import config, models
from ..database import Generation, GenerationVersion, VoiceProfile
from . import profiles
from .local_expression import normalize_expression
from ..utils.effects import validate_effects_chain

SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SPEAKERS = {"Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"}


def library_dir():
    return config.get_data_dir() / "voice-library"


def builtin_profile_id(voice_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "voice-workbench-library:" + voice_id))


def read_catalog():
    path = library_dir() / "catalog.json"
    try:
        info = path.stat()
    except FileNotFoundError:
        return {"schema_version": 1, "voices": []}
    return deepcopy(_read_catalog(str(path), _file_signature(info)))


def _file_signature(info):
    return info.st_mtime_ns, info.st_ctime_ns, info.st_size, info.st_ino


@lru_cache(maxsize=4)
def _read_catalog(path, signature):
    try:
        catalog = json.loads(Path(path).read_text(encoding="utf-8"))
        if catalog.get("schema_version") != 1 or not isinstance(catalog.get("voices"), list):
            raise ValueError("unsupported schema")
        seen = set()
        for voice in catalog["voices"]:
            key = voice["id"]
            if not isinstance(key, str) or not SAFE_ID.fullmatch(key) or key in seen or voice["speaker"] not in SPEAKERS:
                raise ValueError("invalid voice identity")
            if key != "qwen-" + voice["speaker"].lower().replace("_", "-"):
                raise ValueError("speaker identity mismatch")
            seen.add(key)
            if not isinstance(voice["name"], str) or not voice["name"].strip():
                raise ValueError("missing voice name")
            sample_ids = set()
            for sample in voice.get("samples", []):
                if not SAFE_ID.fullmatch(sample["id"]) or sample["id"] in sample_ids:
                    raise ValueError("invalid preview identity")
                sample_ids.add(sample["id"])
        return catalog
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        raise HTTPException(503, "声音库清单格式异常，请检查本地 catalog.json。") from exc


def get_voice(voice_id):
    voice = next((v for v in read_catalog()["voices"] if v["id"] == voice_id), None)
    if voice is None:
        raise HTTPException(404, "声音库中没有这个音色。")
    return voice


def sample_path(sample):
    """A catalog may only expose its own completed WAV assets."""
    if sample.get("status") != "ready" or not isinstance(sample.get("audio_path"), str):
        return None
    try:
        root = (library_dir() / "audio").resolve()
        path = (root / sample["audio_path"]).resolve()
        if not path.is_relative_to(root) or path.suffix.lower() != ".wav":
            return None
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            return None
        return path if _valid_wav(str(path), _file_signature(info)) else None
    except (OSError, ValueError, wave.Error, EOFError):
        return None


@lru_cache(maxsize=512)
def _valid_wav(path, signature):
    # Revalidate after replacement/edit; never retain audio bytes in RAM.
    try:
        with wave.open(path, "rb") as audio:
            return audio.getnframes() > 0 and audio.getframerate() > 0
    except (OSError, ValueError, wave.Error, EOFError):
        return False


def sample_response(voice_id, sample):
    output = dict(sample)
    path = sample_path(sample)
    output["audio_url"] = f"/local/voice-library/{voice_id}/samples/{sample['id']}/audio" if path else None
    if sample.get("status") == "ready" and path is None:
        output.update(status="failed", error="试听文件缺失或未完成。")
    return output


def _personal_samples_by_profile(profile_ids, db):
    output = {profile_id: [] for profile_id in profile_ids}
    if not profile_ids:
        return output
    # Preserve the last-30-per-profile bound in one query, including its
    # currently selected version. A library with N profiles no longer makes
    # N history queries plus one query per candidate recording.
    ranked = (db.query(Generation.id.label("id"), func.row_number().over(
        partition_by=Generation.profile_id, order_by=Generation.created_at.desc()).label("position"))
        .filter(Generation.profile_id.in_(profile_ids), Generation.status == "completed").subquery())
    rows = (db.query(Generation, GenerationVersion)
            .join(ranked, ranked.c.id == Generation.id)
            .outerjoin(GenerationVersion, and_(GenerationVersion.generation_id == Generation.id,
                                               GenerationVersion.is_default == True))
            .filter(ranked.c.position <= 30, Generation.duration > 0, Generation.duration <= 20)
            .order_by(Generation.created_at.desc()).all())
    for gen, version in rows:
        previews = output[gen.profile_id]
        if len(previews) == 3:
            continue
        path = config.resolve_storage_path(version.audio_path if version else gen.audio_path)
        if path is None or not path.is_file():
            continue
        expression = gen.expression or normalize_expression()
        previews.append(dict(id=gen.id, label="已有试听", text=gen.text, language=gen.language,
                           expression=expression, expression_result=gen.expression_result,
                           duration=gen.duration, status="ready", engine=gen.engine, model_size=gen.model_size,
                           generation_id=gen.id, version_id=version.id if version else None,
                           audio_url=f"/audio/version/{version.id}" if version else f"/audio/{gen.id}"))
    return output


def catalog_listing(db):
    catalog = read_catalog()
    all_profiles = db.query(VoiceProfile).order_by(VoiceProfile.created_at.desc()).all()
    existing = {profile.id: profile for profile in all_profiles}
    voices = []
    for voice in catalog["voices"]:
        pid = builtin_profile_id(voice["id"])
        samples = [sample_response(voice["id"], sample) for sample in voice.get("samples", [])]
        voices.append(dict(voice, kind="builtin", is_builtin=True,
                           profile_id=pid if pid in existing else None, template_profile_id=pid,
                           default_expression=normalize_expression(), samples=samples,
                           ready_samples=sum(s["status"] == "ready" for s in samples), total_samples=len(samples)))
    personal = []
    personal_samples = _personal_samples_by_profile([p.id for p in all_profiles if not p.is_builtin], db)
    for profile in all_profiles:
        if profile.is_builtin:
            continue
        response = profiles._profile_to_response(profile).model_dump(mode="json")
        response.update(kind="variant" if profile.library_voice_id else "clone" if profile.voice_type == "cloned" else "personal",
                        samples=personal_samples[profile.id])
        personal.append(response)
    return dict(catalog, voices=voices, personal_voices=personal)


def ensure_builtin_profile(voice_id, db):
    """POST-only materialization; never relabel or take ownership of user rows."""
    voice = get_voice(voice_id)
    pid = builtin_profile_id(voice_id)
    profile = db.query(VoiceProfile).filter_by(id=pid).first()
    if profile is not None:
        if not profile.is_builtin or profile.library_voice_id != voice_id or profile.preset_voice_id != voice["speaker"]:
            raise HTTPException(409, "声音库档案标识冲突，现有个人档案未被修改。")
        return profiles._profile_to_response(profile)
    name = ("内置 · " + voice["name"])[:100]
    if db.query(VoiceProfile).filter_by(name=name).first():
        name = name[:90] + " · " + pid[:6]
    profile = VoiceProfile(id=pid, name=name, description=voice.get("description"), language="zh",
                           voice_type="preset", preset_engine="qwen_custom_voice", preset_voice_id=voice["speaker"],
                           default_engine="qwen_custom_voice", effects_chain=None,
                           library_meta=json.dumps(dict(source_voice_id=voice_id, is_template=True,
                                                        default_expression=normalize_expression()), ensure_ascii=False))
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profiles._profile_to_response(profile)


def create_variant(voice_id, data, db):
    voice = get_voice(voice_id)
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "请给个人角色填写名称。")
    if db.query(VoiceProfile).filter_by(name=name).first():
        raise HTTPException(409, "这个角色名称已存在，请换一个名称。")
    effects = [item.model_dump() for item in data.effects_chain]
    error = validate_effects_chain(effects)
    if error:
        raise HTTPException(400, error)
    for effect in effects:
        if effect["type"] == "tempo" and not 0.75 <= effect["params"].get("speed", 1) <= 1.5:
            raise HTTPException(400, "角色变体的语速范围是 0.75–1.5 倍。")
    profile = VoiceProfile(id=str(uuid.uuid4()), name=name, description=data.description,
                           language=data.language, voice_type="preset", preset_engine="qwen_custom_voice",
                           preset_voice_id=voice["speaker"], default_engine="qwen_custom_voice",
                           effects_chain=json.dumps(effects, ensure_ascii=False),
                           library_meta=json.dumps(dict(source_voice_id=voice_id, is_template=False,
                                                        default_expression=data.expression.model_dump(),
                                                        project_name=data.project_name), ensure_ascii=False))
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profiles._profile_to_response(profile)
