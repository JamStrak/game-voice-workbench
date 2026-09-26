"""Local voice-library catalog and copy-on-customize endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..services import local_voice_library as library
from .audio import audio_file_response

router = APIRouter(prefix="/local/voice-library")


class VariantRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    project_name: str | None = Field(default=None, max_length=100)
    language: str = Field(default="zh", pattern="^(zh|en|ja|ko|de|fr|ru|pt|es|it)$")
    expression: models.ExpressionConfig = Field(default_factory=models.ExpressionConfig)
    effects_chain: list[models.EffectConfig] = Field(default_factory=list, max_length=10)


@router.get("")
def list_library(db: Session = Depends(get_db)):
    return library.catalog_listing(db)


@router.get("/{voice_id}/samples/{sample_id}/audio")
async def get_library_audio(voice_id: str, sample_id: str):
    return await run_in_threadpool(_library_audio_response, voice_id, sample_id)


def _library_audio_response(voice_id: str, sample_id: str):
    voice = library.get_voice(voice_id)
    sample = next((s for s in voice.get("samples", []) if s["id"] == sample_id), None)
    path = library.sample_path(sample) if sample else None
    if path is None:
        raise HTTPException(404, "这条试听尚未完成或文件不存在。")
    return audio_file_response(path, f"{voice_id}-{sample_id}.wav")


@router.post("/{voice_id}/use", response_model=models.VoiceProfileResponse)
async def use_voice(voice_id: str, db: Session = Depends(get_db)):
    return library.ensure_builtin_profile(voice_id, db)


@router.post("/{voice_id}/variants", response_model=models.VoiceProfileResponse)
async def create_variant(voice_id: str, data: VariantRequest, db: Session = Depends(get_db)):
    return library.create_variant(voice_id, data, db)
