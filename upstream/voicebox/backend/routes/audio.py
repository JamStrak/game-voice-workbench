"""Audio file serving endpoints."""

import mimetypes
import hashlib
import stat
from email.utils import parsedate_to_datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from starlette.datastructures import Headers
from sqlalchemy.orm import Session

from .. import config
from ..database import Generation, GenerationVersion, ProfileSample, get_db

router = APIRouter()


class CachedAudioResponse(FileResponse):
    """Keep Starlette's streaming/Range support and honor cache validators."""

    async def __call__(self, scope, receive, send):
        headers = Headers(scope=scope)
        etag = headers.get("if-none-match")
        not_modified = False
        if etag is not None:
            not_modified = any(value.strip().removeprefix("W/") in ("*", self.headers["etag"])
                               for value in etag.split(","))
        # A mutable default pointer can switch to an older file. Its timestamp
        # alone cannot identify the selected audio; require an ETag there.
        elif "immutable" in self.headers["cache-control"] and (modified_since := headers.get("if-modified-since")):
            try:
                since = parsedate_to_datetime(modified_since)
                not_modified = int(self.stat_result.st_mtime) <= since.timestamp()
            except (ValueError, TypeError, OverflowError):
                pass
        if not_modified and scope.get("method") in ("GET", "HEAD"):
            response = Response(status_code=304, headers={
                key: self.headers[key] for key in ("etag", "last-modified", "cache-control")
            })
            return await response(scope, receive, send)
        return await super().__call__(scope, receive, send)


def audio_file_response(path: Path, filename: str, *, immutable: bool = False):
    """Stat once; default pointers and catalog assets must always revalidate."""
    try:
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            raise FileNotFoundError()
    except OSError as exc:
        raise HTTPException(status_code=404, detail="Audio file not found") from exc
    identity = f"{path}:{info.st_mtime_ns}:{info.st_ctime_ns}:{info.st_size}:{info.st_ino}"
    etag = '"' + hashlib.blake2b(identity.encode(), digest_size=16).hexdigest() + '"'
    return CachedAudioResponse(
        path, media_type=_audio_media_type(path), filename=filename, stat_result=info,
        headers={"etag": etag, "cache-control": "private, max-age=31536000, immutable" if immutable else "private, no-cache"},
    )


def _audio_media_type(path: Path) -> str:
    """Derive the Content-Type from the file extension.

    Imported audio retains its source format (.mp3, .m4a, .ogg, …) so a
    blanket ``audio/wav`` would mislead strict clients trying to decode
    via the response header instead of sniffing the bytes."""
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "audio/wav"


@router.get("/audio/version/{version_id}")
def get_version_audio(version_id: str, db: Session = Depends(get_db)):
    """Serve audio for a specific version."""
    version = db.query(GenerationVersion.audio_path, GenerationVersion.generation_id, GenerationVersion.label).filter_by(id=version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    audio_path = config.resolve_storage_path(version.audio_path)
    if audio_path is None:
        raise HTTPException(status_code=404, detail="Audio file not found")

    return audio_file_response(
        audio_path, f"generation_{version.generation_id}_{version.label}{audio_path.suffix}", immutable=True,
    )


@router.get("/audio/{generation_id}")
def get_audio(generation_id: str, db: Session = Depends(get_db)):
    """Serve generated audio file (serves the default version)."""
    generation = db.query(Generation.audio_path, Generation.status).filter_by(id=generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")

    audio_path = config.resolve_storage_path(generation.audio_path)
    if audio_path is None:
        detail = (
            "Generation failed; no audio available"
            if generation.status == "failed"
            else "Audio file not found"
        )
        raise HTTPException(status_code=404, detail=detail)

    return audio_file_response(audio_path, f"generation_{generation_id}{audio_path.suffix}")


@router.get("/samples/{sample_id}")
def get_sample_audio(sample_id: str, db: Session = Depends(get_db)):
    """Serve profile sample audio file."""
    sample = db.query(ProfileSample.audio_path).filter_by(id=sample_id).first()
    if not sample:
        raise HTTPException(status_code=404, detail="Sample not found")

    audio_path = config.resolve_storage_path(sample.audio_path)
    if audio_path is None:
        raise HTTPException(status_code=404, detail="Audio file not found")

    return audio_file_response(audio_path, f"sample_{sample_id}{audio_path.suffix}")
