"""Config editor router – read/write /usr/local/bin/config.json on Pi."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import ssh_service

router = APIRouter(prefix="/api/config", tags=["config"])


class ConfigPayload(BaseModel):
    config: dict


@router.get("")
def get_config():
    try:
        return {"config": ssh_service.read_config()}
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.put("")
def put_config(payload: ConfigPayload):
    try:
        ssh_service.write_config(payload.config)
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}
