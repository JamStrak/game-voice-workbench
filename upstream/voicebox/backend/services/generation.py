"""
Unified TTS generation orchestration.

Replaces the three near-identical closures (_run_generation, _run_retry,
_run_regenerate) that lived in main.py with a single ``run_generation()``
function parameterized by *mode*.

Mode differences:
  - "generate"   : full pipeline -- save clean version, optionally apply
                    effects and create a processed version.
  - "retry"      : re-runs a failed generation with the same seed.
                    Restores profile effects and preserves original/processed versions.
  - "regenerate" : re-runs with seed=None for variation.  Creates a new
                    version with an auto-incremented "take-N" label.
"""

from __future__ import annotations

import asyncio
import traceback
from typing import Literal, Optional

from .. import config
from . import history, profiles
from ..database import get_db
from ..utils.tasks import get_task_manager


def saved_effects_chain(generation_id, db):
    """Use the selected take, or the initial request if it failed before audio."""
    import json
    from ..database import Generation
    from . import versions
    selected = versions.get_default_version(generation_id, db)
    if selected:
        return [effect.model_dump() for effect in selected.effects_chain or []]
    generation = db.query(Generation).filter_by(id=generation_id).first()
    if generation and generation.effects_chain_snapshot is not None:
        return json.loads(generation.effects_chain_snapshot)
    # Legacy failed rows did not retain request settings.
    return None


async def run_generation(
    *,
    generation_id: str,
    profile_id: str,
    text: str,
    language: str,
    engine: str,
    model_size: str,
    seed: Optional[int],
    normalize: bool = False,
    effects_chain: Optional[list] = None,
    instruct: Optional[str] = None,
    mode: Literal["generate", "retry", "regenerate"],
    max_chunk_chars: Optional[int] = None,
    crossfade_ms: Optional[int] = None,
    version_id: Optional[str] = None,
) -> None:
    """Execute TTS inference and persist the result.

    This is the single entry point for all background generation work.
    It is designed to be enqueued via ``services.task_queue.enqueue_generation``.
    """
    from ..backends import (
        engine_needs_trim,
        engine_retries_runaway,
        get_tts_backend_for_engine,
        load_engine_model,
    )
    from ..utils.chunked_tts import generate_chunked
    from ..utils.audio import has_tts_runaway, normalize_audio, save_audio, trim_tts_output

    task_manager = get_task_manager()
    bg_db = next(get_db())

    try:
        if mode in ("retry", "regenerate") and effects_chain is None:
            effects_chain = saved_effects_chain(generation_id, bg_db)
        from .local_inference import infer
        await history.update_generation_status(generation_id, "loading_model", bg_db)
        audio, sample_rate = await infer(generation_id, profile_id, text, language,
                                        engine, model_size, seed if mode != "regenerate" else None, instruct=instruct)
        # Raw output is always preserved. Gain/tempo belong to effects versions.

        duration = len(audio) / sample_rate

        # --- Persist audio and update status -----------------------------
        if mode in ("generate", "retry"):
            if mode == "retry" and effects_chain is None:
                import json
                from ..database import VoiceProfile
                profile = bg_db.query(VoiceProfile).filter_by(id=profile_id).first()
                if profile and profile.effects_chain:
                    effects_chain = json.loads(profile.effects_chain)
            final_path = _save_generate(
                generation_id=generation_id,
                audio=audio,
                sample_rate=sample_rate,
                effects_chain=effects_chain,
                save_audio=save_audio,
                db=bg_db,
            )
        elif mode == "regenerate":
            final_path = _save_regenerate(
                generation_id=generation_id,
                version_id=version_id,
                audio=audio,
                sample_rate=sample_rate,
                save_audio=save_audio,
                db=bg_db,
                effects_chain=effects_chain,
            )

        import soundfile as sf
        duration = sf.info(str(config.resolve_storage_path(final_path))).duration
        await history.update_generation_status(
            generation_id=generation_id,
            status="completed",
            db=bg_db,
            audio_path=final_path,
            duration=duration,
        )

    except asyncio.CancelledError:
        await history.update_generation_status(
            generation_id=generation_id,
            status="failed",
            db=bg_db,
            error="Generation cancelled",
        )
        _notify_speak_end(generation_id, status="cancelled")
    except Exception as e:
        traceback.print_exc()
        await history.update_generation_status(
            generation_id=generation_id,
            status="failed",
            db=bg_db,
            error=str(e),
        )
        _notify_speak_end(generation_id, status="failed")
    else:
        _notify_speak_end(generation_id, status="completed")
    finally:
        task_manager.complete_generation(generation_id)
        bg_db.close()


def _notify_speak_end(generation_id: str, *, status: str) -> None:
    """Publish a speak-end event; the frontend ignores unknown ids."""
    try:
        from ..mcp_server import events as mcp_events

        mcp_events.publish(
            "speak-end",
            {"generation_id": generation_id, "status": status},
        )
    except Exception:
        # Never let event pub/sub break generation completion.
        pass


def _save_generate(
    *,
    generation_id: str,
    audio,
    sample_rate: int,
    effects_chain: Optional[list],
    save_audio,
    db,
) -> str:
    """Save clean version and optionally an effects-processed version.

    Returns the final audio path (processed if effects were applied,
    otherwise clean).
    """
    from . import versions as versions_mod

    clean_audio_path = config.get_generations_dir() / f"{generation_id}.wav"
    if clean_audio_path.exists():
        import uuid
        clean_audio_path = config.get_generations_dir() / f"{generation_id}_{uuid.uuid4().hex[:8]}.wav"
    save_audio(audio, str(clean_audio_path), sample_rate)

    has_effects = effects_chain and any(e.get("enabled", True) for e in effects_chain)

    versions_mod.create_version(
        generation_id=generation_id,
        label="original",
        audio_path=config.to_storage_path(clean_audio_path),
        db=db,
        effects_chain=None,
        is_default=not has_effects,
    )

    final_audio_path = str(clean_audio_path)

    if has_effects:
        from ..utils.effects import apply_effects, validate_effects_chain

        assert effects_chain is not None

        error_msg = validate_effects_chain(effects_chain)
        if error_msg:
            import logging
            logging.getLogger(__name__).warning("invalid effects chain, skipping: %s", error_msg)
            versions_mod.set_default_version(
                versions_mod.list_versions(generation_id, db)[0].id, db
            )
        else:
            processed_audio = apply_effects(audio, sample_rate, effects_chain)
            processed_path = clean_audio_path.with_stem(clean_audio_path.stem + '_processed')
            save_audio(processed_audio, str(processed_path), sample_rate)
            final_audio_path = str(processed_path)
            versions_mod.create_version(
                generation_id=generation_id,
                label="version-2",
                audio_path=config.to_storage_path(processed_path),
                db=db,
                effects_chain=effects_chain,
                is_default=True,
            )

    return config.to_storage_path(final_audio_path)


def _save_retry(
    *,
    generation_id: str,
    audio,
    sample_rate: int,
    save_audio,
) -> str:
    """Save retry output -- single file, no versions.

    Returns the audio path.
    """
    audio_path = config.get_generations_dir() / f"{generation_id}.wav"
    save_audio(audio, str(audio_path), sample_rate)
    return config.to_storage_path(audio_path)


async def generate_audio_sync(
    *,
    profile_id: str,
    text: str,
    language: str,
    engine: str,
    model_size: str,
    seed: Optional[int] = None,
    instruct: Optional[str] = None,
    normalize: bool = True,
    max_chunk_chars: Optional[int] = None,
    crossfade_ms: Optional[int] = None,
) -> bytes:
    """Run a TTS generation synchronously and return the resulting wav bytes.

    Unlike :func:`run_generation`, this path does not touch the
    ``generations`` table, enqueue work, or write anything to the
    generations directory. It's used by ``POST /profiles/{id}/speak``
    when the caller passes ``persist=false`` — they just want the audio
    back in the HTTP response without polluting their history.

    Loads the engine model on demand, runs ``generate_chunked``, optional
    normalize, then encodes in-memory via :func:`tts.audio_to_wav_bytes`
    (same helper ``/generate/stream`` uses).
    """
    from ..backends import (
        engine_needs_trim,
        engine_retries_runaway,
        get_tts_backend_for_engine,
        load_engine_model,
    )
    from ..utils.chunked_tts import generate_chunked
    from ..utils.audio import has_tts_runaway, normalize_audio, trim_tts_output
    from . import tts

    bg_db = next(get_db())
    try:
        tts_model = get_tts_backend_for_engine(engine)
        await load_engine_model(engine, model_size)

        voice_prompt = await profiles.create_voice_prompt_for_profile(
            profile_id,
            bg_db,
            use_cache=True,
            engine=engine,
        )
    finally:
        bg_db.close()

    trim_fn = trim_tts_output if engine_needs_trim(engine) else None
    runaway_detector = has_tts_runaway if engine_retries_runaway(engine) else None

    gen_kwargs: dict = dict(
        language=language,
        seed=seed,
        instruct=instruct,
        trim_fn=trim_fn,
        runaway_detector=runaway_detector,
    )
    if max_chunk_chars is not None:
        gen_kwargs["max_chunk_chars"] = max_chunk_chars
    if crossfade_ms is not None:
        gen_kwargs["crossfade_ms"] = crossfade_ms

    audio, sample_rate = await generate_chunked(
        tts_model, text, voice_prompt, **gen_kwargs
    )

    if normalize:
        audio = normalize_audio(audio)

    return tts.audio_to_wav_bytes(audio, sample_rate)


def _save_regenerate(
    *,
    generation_id: str,
    version_id: Optional[str],
    audio,
    sample_rate: int,
    save_audio,
    db,
    effects_chain: Optional[list] = None,
) -> str:
    """Save regeneration output as a new version with auto-label.

    Returns the audio path.
    """
    from . import versions as versions_mod
    from ..utils.effects import apply_effects, validate_effects_chain

    if effects_chain:
        error = validate_effects_chain(effects_chain)
        if error:
            raise ValueError(error)

    import uuid as _uuid

    suffix = _uuid.uuid4().hex[:8]
    audio_path = config.get_generations_dir() / f"{generation_id}_{suffix}.wav"
    save_audio(audio, str(audio_path), sample_rate)

    # Count via DB query rather than list length to avoid TOCTOU race
    from ..database import GenerationVersion as DBGenerationVersion

    count = db.query(DBGenerationVersion).filter_by(generation_id=generation_id).count()
    label = f"take-{count + 1}"

    has_effects = effects_chain and any(effect.get("enabled", True) for effect in effects_chain)
    original = versions_mod.create_version(
        generation_id=generation_id,
        label=label,
        audio_path=config.to_storage_path(audio_path),
        db=db,
        effects_chain=None,
        is_default=not has_effects,
    )
    if has_effects:
        processed = apply_effects(audio, sample_rate, effects_chain)
        processed_path = audio_path.with_stem(audio_path.stem + "_processed")
        save_audio(processed, str(processed_path), sample_rate)
        versions_mod.create_version(generation_id=generation_id, label=label + " · 后期",
                                    audio_path=config.to_storage_path(processed_path), db=db,
                                    effects_chain=effects_chain, source_version_id=original.id, is_default=True)
        return config.to_storage_path(processed_path)
    return config.to_storage_path(audio_path)
