"""Bounded status snapshots leave HTTP/1 connections available for audio."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import Generation, get_db

router = APIRouter()


class StatusRequest(BaseModel):
    ids: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(max_length=100)


@router.post('/generations/status')
def generation_status_snapshot(
    data: StatusRequest, response: Response, db: Session = Depends(get_db),
):
    # One short, read-only query instead of a stream and DB session per task.
    response.headers['Cache-Control'] = 'no-store'
    ids = list(dict.fromkeys(data.ids))
    if not ids:
        return []
    rows = db.query(
        Generation.id, Generation.status, Generation.duration,
        Generation.error, Generation.source,
    ).filter(Generation.id.in_(ids)).all()
    found = {row.id: row for row in rows}
    return [
        {
            'id': item,
            'status': (found[item].status or 'completed') if item in found else 'not_found',
            'duration': found[item].duration if item in found else None,
            'error': found[item].error if item in found else None,
            'source': found[item].source if item in found else None,
        }
        for item in ids
    ]
