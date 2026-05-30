"""Scheduler CRUD – plánovač závlah (duration-based)."""
from datetime import datetime, timedelta, date, time as dtime
from typing import Optional
from zoneinfo import ZoneInfo

from croniter import croniter
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import scheduler_service, ssh_service
from app.services.cron_humanize import humanize_cron

router = APIRouter(prefix="/api/scheduler", tags=["scheduler"])

_PRAGUE = ZoneInfo("Europe/Prague")


class ScheduleIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    cron_expr: str = Field(..., description="Standard 5-field cron")
    zone: Optional[str] = None
    duration_s: Optional[int] = Field(None, ge=ssh_service.DURATION_MIN,
                                      le=ssh_service.DURATION_MAX)
    profil_id: Optional[int] = None
    skip_if_rain: bool = True
    min_temp_c: Optional[float] = None
    enabled: bool = True
    plan_kind: str = Field(default="cron")
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    max_runs: Optional[int] = Field(None, ge=1, le=10000)

    @field_validator("zone")
    @classmethod
    def _zone_ok(cls, v):
        if v is None:
            return v
        if v not in ssh_service.ALLOWED_ZONES:
            raise ValueError(f"Invalid zone: {v}")
        return v

    @field_validator("cron_expr")
    @classmethod
    def _cron_ok(cls, v: str) -> str:
        if not croniter.is_valid(v):
            raise ValueError(f"Invalid cron expression: {v}")
        return v

    def _check_target(self) -> None:
        if self.profil_id:
            return
        if not self.zone or not self.duration_s:
            raise ValueError("Plán musí mít buď profil_id, nebo zone + duration_s")


def _row_to_dict(r) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "zone": r.zone,
        "duration_s": int(r.duration_s) if r.duration_s is not None else None,
        "cron_expr": r.cron_expr,
        "cron_human": humanize_cron(r.cron_expr),
        "profil_id": r.profil_id,
        "skip_if_rain": bool(r.skip_if_rain),
        "min_temp_c": float(r.min_temp_c) if r.min_temp_c is not None else None,
        "enabled": bool(r.enabled),
        "last_run_at": r.last_run_at.isoformat() if r.last_run_at else None,
        "last_status": r.last_status,
        "plan_kind": r.plan_kind,
        "start_date": r.start_date.isoformat() if r.start_date else None,
        "end_date": r.end_date.isoformat() if r.end_date else None,
        "max_runs": r.max_runs,
        "runs_count": r.runs_count,
    }


@router.get("")
def list_schedules(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(text(
        "SELECT id, name, zone, duration_s, cron_expr, profil_id, "
        "       skip_if_rain, min_temp_c, enabled, last_run_at, last_status, "
        "       plan_kind, start_date, end_date, max_runs, runs_count "
        "FROM schedule ORDER BY id"
    )).fetchall()
    return {
        "schedules": [_row_to_dict(r) for r in rows],
        "active_jobs": scheduler_service.list_jobs(),
    }


@router.post("")
def create_schedule(payload: ScheduleIn, db: Session = Depends(get_db)) -> dict:
    try:
        payload._check_target()
    except ValueError as e:
        raise HTTPException(400, str(e))
    res = db.execute(text(
        "INSERT INTO schedule "
        "(name, zone, duration_s, cron_expr, profil_id, skip_if_rain, min_temp_c, "
        " enabled, plan_kind, start_date, end_date, max_runs) "
        "VALUES (:name, :zone, :dur, :cron, :prf, :rain, :tmin, :en, "
        " :kind, :sd, :ed, :mr)"
    ), {
        "name": payload.name, "zone": payload.zone, "dur": payload.duration_s,
        "cron": payload.cron_expr, "prf": payload.profil_id,
        "rain": 1 if payload.skip_if_rain else 0,
        "tmin": payload.min_temp_c, "en": 1 if payload.enabled else 0,
        "kind": payload.plan_kind if payload.plan_kind in ("cron", "recurring") else "cron",
        "sd": payload.start_date, "ed": payload.end_date, "mr": payload.max_runs,
    })
    db.commit()
    scheduler_service.reload_jobs()
    return {"ok": True, "id": res.lastrowid}


@router.put("/{schedule_id}")
def update_schedule(schedule_id: int, payload: ScheduleIn,
                    db: Session = Depends(get_db)) -> dict:
    try:
        payload._check_target()
    except ValueError as e:
        raise HTTPException(400, str(e))
    res = db.execute(text(
        "UPDATE schedule SET name=:name, zone=:zone, duration_s=:dur, cron_expr=:cron, "
        "profil_id=:prf, skip_if_rain=:rain, min_temp_c=:tmin, enabled=:en, "
        "plan_kind=:kind, start_date=:sd, end_date=:ed, max_runs=:mr "
        "WHERE id=:id"
    ), {
        "name": payload.name, "zone": payload.zone, "dur": payload.duration_s,
        "cron": payload.cron_expr, "prf": payload.profil_id,
        "rain": 1 if payload.skip_if_rain else 0,
        "tmin": payload.min_temp_c, "en": 1 if payload.enabled else 0,
        "kind": payload.plan_kind if payload.plan_kind in ("cron", "recurring") else "cron",
        "sd": payload.start_date, "ed": payload.end_date, "mr": payload.max_runs,
        "id": schedule_id,
    })
    if res.rowcount == 0:
        raise HTTPException(404, "Schedule not found")
    db.commit()
    scheduler_service.reload_jobs()
    return {"ok": True}


@router.delete("/{schedule_id}")
def delete_schedule(schedule_id: int, db: Session = Depends(get_db)) -> dict:
    res = db.execute(text("DELETE FROM schedule WHERE id=:id"), {"id": schedule_id})
    if res.rowcount == 0:
        raise HTTPException(404, "Schedule not found")
    db.commit()
    scheduler_service.reload_jobs()
    return {"ok": True}


@router.post("/reload")
def reload_jobs() -> dict:
    scheduler_service.reload_jobs()
    return {"ok": True, "active_jobs": scheduler_service.list_jobs()}


@router.get("/upcoming")
def upcoming_schedules(
    hours: int = Query(48, ge=1, le=168),
    db: Session = Depends(get_db),
) -> dict:
    rows = db.execute(text(
        "SELECT id, name, cron_expr, start_date, end_date, max_runs, runs_count "
        "FROM schedule WHERE enabled = 1"
    )).fetchall()
    now = datetime.now(tz=_PRAGUE)
    today = now.date()
    end = now + timedelta(hours=hours)
    events: list[dict] = []
    for r in rows:
        if r.start_date and today < r.start_date:
            continue
        if r.end_date and today > r.end_date:
            continue
        if r.max_runs and r.runs_count >= r.max_runs:
            continue
        try:
            cron = croniter(r.cron_expr, now - timedelta(seconds=1))
            while True:
                nxt = cron.get_next(datetime)
                if nxt.tzinfo is None:
                    nxt = nxt.replace(tzinfo=_PRAGUE)
                if nxt > end:
                    break
                if r.end_date and nxt.date() > r.end_date:
                    break
                events.append({"time": nxt.isoformat(), "name": r.name, "id": r.id})
        except Exception:  # noqa: BLE001
            continue

    ov_rows = db.execute(text(
        "SELECT id, run_date, run_time, note FROM zavlaha_kalendar_override "
        "WHERE action='add' AND executed_at IS NULL "
        "  AND run_date BETWEEN :a AND :b"
    ), {"a": today, "b": end.date()}).fetchall()
    for ov in ov_rows:
        rt = ov.run_time
        if isinstance(rt, timedelta):
            total = int(rt.total_seconds())
            rt_obj = dtime(hour=total // 3600, minute=(total % 3600) // 60)
        elif isinstance(rt, dtime):
            rt_obj = rt
        else:
            continue
        run_dt = datetime.combine(ov.run_date, rt_obj).replace(tzinfo=_PRAGUE)
        if run_dt <= now or run_dt > end:
            continue
        events.append({
            "time": run_dt.isoformat(),
            "name": ov.note or "Jednorázový běh",
            "id": f"ov-{ov.id}",
            "kind": "override",
        })

    events.sort(key=lambda e: e["time"])
    return {"events": events}
