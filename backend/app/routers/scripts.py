"""Scripts router – list/read/write Python scripts on Pi (optional editor)."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import ssh_service

router = APIRouter(prefix="/api/scripts", tags=["scripts"])


class ScriptPayload(BaseModel):
    content: str


@router.get("")
def list_scripts():
    try:
        return {"scripts": ssh_service.list_scripts()}
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/{name}")
def read_script(name: str):
    try:
        return {"name": name, "content": ssh_service.read_script(name)}
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/{name}")
def write_script(name: str, payload: ScriptPayload):
    try:
        ssh_service.write_script(name, payload.content)
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}
