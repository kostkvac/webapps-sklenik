"""SSH control router – manual zavlaha + monitoring control."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import ssh_service

router = APIRouter(prefix="/api/ssh", tags=["ssh"])


class ZavlahaRequest(BaseModel):
    zone: str = Field(..., description="kapkova_a | kapkova_b")
    duration: int = Field(..., ge=10, le=600, description="Seconds 10–600")


class MonitoringActionRequest(BaseModel):
    action: str = Field(..., description="start | stop | restart")


def _result_to_dict(res: ssh_service.SSHResult) -> dict:
    return {"ok": res.ok, "exit_code": res.exit_code,
            "stdout": res.stdout, "stderr": res.stderr}


@router.get("/zavlaha/running")
def zavlaha_running():
    try:
        return ssh_service.zavlaha_running()
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/zavlaha")
def run_zavlaha(req: ZavlahaRequest):
    try:
        res = ssh_service.run_zavlaha(req.zone, req.duration)
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _result_to_dict(res)


@router.post("/monitoring")
def monitoring_action(req: MonitoringActionRequest):
    try:
        res = ssh_service.monitoring_action(req.action)
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return _result_to_dict(res)
