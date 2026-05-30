"""Kalendářové plánování (duration-based) – cron expanze + overrides + počasí."""
from __future__ import annotations

from datetime import date, datetime, time as dtime, timedelta
from typing import Optional

from croniter import croniter
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import scheduler_service, ssh_service, weather_service

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


# ---------- pydantic ----------
class OverrideIn(BaseModel):
    run_date: date
    run_time: Optional[str] = None  # HH:MM
    action: str  # 'skip' | 'add'
    schedule_id: Optional[int] = None
    profil_id: Optional[int] = None
    zone: Optional[str] = None
    duration_s: Optional[int] = Field(None, ge=ssh_service.DURATION_MIN,
                                      le=ssh_service.DURATION_MAX)
    skip_if_rain: bool = True
    min_temp_c: Optional[float] = None
    note: Optional[str] = Field(None, max_length=255)

    @field_validator("action")
    @classmethod
    def _act(cls, v: str) -> str:
        if v not in ("skip", "add"):
            raise ValueError("action must be 'skip' or 'add'")
        return v

    @field_validator("zone")
    @classmethod
    def _zone(cls, v):
        if v is not None and v not in ssh_service.ALLOWED_ZONES:
            raise ValueError(f"Invalid zone: {v}")
        return v


# ---------- helpers ----------
def _parse_time(s: Optional[str]) -> Optional[dtime]:
    if not s:
        return None
    try:
        h, m = s.split(":")
        return dtime(int(h), int(m))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid time '{s}': {e}")


def _expand_cron(cron_expr: str, start: datetime, end: datetime) -> list[datetime]:
    out: list[datetime] = []
    try:
        it = croniter(cron_expr, start - timedelta(seconds=1))
    except Exception:
        return out
    while True:
        nxt = it.get_next(datetime)
        if nxt > end:
            break
        out.append(nxt)
    return out


def _weather_by_day(forecast: dict) -> dict[str, dict]:
    daily = (forecast or {}).get("raw", {}).get("daily", {}) or {}
    times = daily.get("time", []) or []
    tmin  = daily.get("temperature_2m_min", []) or []
    tmax  = daily.get("temperature_2m_max", []) or []
    prec  = daily.get("precipitation_sum", []) or []
    wind  = daily.get("wind_speed_10m_max", []) or []
    out: dict[str, dict] = {}
    for i, d in enumerate(times):
        out[d] = {
            "tmin_c":       tmin[i] if i < len(tmin) else None,
            "tmax_c":       tmax[i] if i < len(tmax) else None,
            "precip_mm":    prec[i] if i < len(prec) else None,
            "wind_kmh_max": wind[i] if i < len(wind) else None,
        }
    return out


def _ov_row(r) -> dict:
    rt = r.run_time
    if isinstance(rt, timedelta):
        total = int(rt.total_seconds())
        rt_str = f"{total // 3600:02d}:{(total % 3600) // 60:02d}"
    elif isinstance(rt, dtime):
        rt_str = rt.strftime("%H:%M")
    else:
        rt_str = None
    return {
        "id": r.id,
        "run_date": r.run_date.isoformat(),
        "run_time": rt_str,
        "action": r.action,
        "schedule_id": r.schedule_id,
        "profil_id": r.profil_id,
        "zone": r.zone,
        "duration_s": int(r.duration_s) if r.duration_s is not None else None,
        "skip_if_rain": bool(r.skip_if_rain),
        "min_temp_c": float(r.min_temp_c) if r.min_temp_c is not None else None,
        "note": r.note,
        "status": r.status,
        "executed_at": r.executed_at.isoformat() if r.executed_at else None,
    }


# ---------- GET /api/calendar ----------
@router.get("")
async def get_calendar(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
) -> dict:
    if to_date < from_date:
        raise HTTPException(400, "to < from")
    if (to_date - from_date).days > 92:
        raise HTTPException(400, "rozsah max 92 dní")

    try:
        forecast = await weather_service.get_forecast(db)
    except Exception:
        forecast = {"raw": {}}
    wbd = _weather_by_day(forecast)

    schedules = db.execute(text(
        "SELECT id, name, zone, cron_expr, duration_s, profil_id, "
        "       skip_if_rain, min_temp_c, enabled "
        "FROM schedule"
    )).fetchall()
    sched_map = {s.id: {"id": s.id, "name": s.name, "zone": s.zone,
                        "duration_s": int(s.duration_s) if s.duration_s is not None else None,
                        "profil_id": s.profil_id,
                        "enabled": bool(s.enabled)}
                 for s in schedules}

    ov_rows = db.execute(text(
        "SELECT * FROM zavlaha_kalendar_override "
        "WHERE run_date BETWEEN :a AND :b ORDER BY run_date, run_time"
    ), {"a": from_date, "b": to_date}).fetchall()
    overrides = [_ov_row(r) for r in ov_rows]

    seq_rows = db.execute(text("SELECT id, name FROM zavlaha_profil")).fetchall()
    seq_name_by_id = {int(s.id): s.name for s in seq_rows}

    skip_lookup_time: dict[tuple[int, str, str], int] = {}
    skip_lookup_day:  dict[tuple[int, str], int] = {}
    for o in overrides:
        if o["action"] != "skip" or o["schedule_id"] is None:
            continue
        if o["run_time"]:
            skip_lookup_time[(o["schedule_id"], o["run_date"], o["run_time"])] = o["id"]
        else:
            skip_lookup_day[(o["schedule_id"], o["run_date"])] = o["id"]

    # past běhy z kapkova_zavlaha_log
    past_rows = db.execute(text(
        "SELECT id, zone, start_time, stop_time, duration_s, source, note "
        "FROM kapkova_zavlaha_log "
        "WHERE start_time >= :a AND start_time < :b_next "
        "ORDER BY start_time"
    ), {"a": datetime.combine(from_date, dtime.min),
        "b_next": datetime.combine(to_date + timedelta(days=1), dtime.min)}).fetchall()
    past_by_day: dict[str, list[dict]] = {}
    for p in past_rows:
        d = p.start_time.date().isoformat()
        past_by_day.setdefault(d, []).append({
            "id": p.id, "zone": p.zone,
            "start": p.start_time.isoformat(),
            "stop": p.stop_time.isoformat() if p.stop_time else None,
            "duration_s": int(p.duration_s) if p.duration_s is not None else None,
            "source": p.source,
            "note": p.note or "",
        })

    days: list[dict] = []
    cur = from_date
    range_start_dt = datetime.combine(from_date, dtime.min)
    range_end_dt   = datetime.combine(to_date,   dtime.max)
    cron_runs: dict[str, list[dict]] = {}
    for s in schedules:
        if not s.enabled:
            continue
        for run_dt in _expand_cron(s.cron_expr, range_start_dt, range_end_dt):
            d_iso = run_dt.date().isoformat()
            t_iso = run_dt.strftime("%H:%M")
            skipped_id = (skip_lookup_time.get((s.id, d_iso, t_iso))
                          or skip_lookup_day.get((s.id, d_iso)))
            cron_runs.setdefault(d_iso, []).append({
                "kind": "cron",
                "schedule_id": s.id,
                "name": s.name,
                "zone": s.zone,
                "time": t_iso,
                "duration_s": int(s.duration_s) if s.duration_s is not None else None,
                "profil_id": s.profil_id,
                "profil_name": seq_name_by_id.get(int(s.profil_id)) if s.profil_id else None,
                "skipped_override_id": skipped_id,
            })

    add_runs: dict[str, list[dict]] = {}
    for o in overrides:
        if o["action"] != "add":
            continue
        add_runs.setdefault(o["run_date"], []).append({
            "kind": "add",
            "override_id": o["id"],
            "name": o["note"] or "Jednorázový běh",
            "zone": o["zone"],
            "profil_id": o["profil_id"],
            "profil_name": seq_name_by_id.get(o["profil_id"]) if o["profil_id"] else None,
            "time": o["run_time"],
            "duration_s": o["duration_s"],
            "status": o["status"],
            "executed_at": o["executed_at"],
        })

    today_iso = date.today().isoformat()
    while cur <= to_date:
        d_iso = cur.isoformat()
        runs = sorted(
            cron_runs.get(d_iso, []) + add_runs.get(d_iso, []),
            key=lambda r: r.get("time") or "",
        )
        days.append({
            "date": d_iso,
            "is_today": d_iso == today_iso,
            "weekday": cur.weekday(),
            "weather": wbd.get(d_iso),
            "planned": runs,
            "past": past_by_day.get(d_iso, []),
            "failed_overrides": [
                {
                    "override_id": o["id"],
                    "name": o["note"] or "Jednorázový běh",
                    "time": o["run_time"],
                    "profil_id": o["profil_id"],
                    "profil_name": seq_name_by_id.get(o["profil_id"]) if o["profil_id"] else None,
                    "zone": o["zone"],
                    "status": o["status"],
                    "executed_at": o["executed_at"],
                }
                for o in overrides
                if o["run_date"] == d_iso
                   and o["action"] == "add"
                   and o["executed_at"] is not None
                   and o.get("status", "") not in ("ok", "skipped_rain", "skipped_cold", "skipped_busy", "")
            ],
        })
        cur += timedelta(days=1)

    return {
        "from": from_date.isoformat(),
        "to":   to_date.isoformat(),
        "days": days,
        "schedules": list(sched_map.values()),
        "overrides": overrides,
    }


# ---------- override CRUD ----------
@router.post("/override")
def create_override(payload: OverrideIn, db: Session = Depends(get_db)) -> dict:
    rt = _parse_time(payload.run_time)
    if payload.action == "skip" and payload.schedule_id is None:
        raise HTTPException(400, "skip vyžaduje schedule_id")
    if payload.action == "add":
        if rt is None:
            raise HTTPException(400, "add vyžaduje run_time")
        if payload.profil_id is None:
            if not payload.zone or not payload.duration_s:
                raise HTTPException(400, "add vyžaduje buď profil_id, nebo zone + duration_s")

    res = db.execute(text(
        "INSERT INTO zavlaha_kalendar_override "
        "(run_date, run_time, action, schedule_id, profil_id, zone, duration_s, "
        " skip_if_rain, min_temp_c, note) "
        "VALUES (:d, :t, :a, :sid, :prof, :z, :dur, :rain, :tmin, :n)"
    ), {
        "d": payload.run_date, "t": rt, "a": payload.action,
        "sid": payload.schedule_id, "prof": payload.profil_id,
        "z": payload.zone, "dur": payload.duration_s,
        "rain": 1 if payload.skip_if_rain else 0, "tmin": payload.min_temp_c,
        "n": payload.note,
    })
    db.commit()
    scheduler_service.reload_jobs()
    return {"ok": True, "id": res.lastrowid}


@router.delete("/override/{ov_id}")
def delete_override(ov_id: int, db: Session = Depends(get_db)) -> dict:
    res = db.execute(text("DELETE FROM zavlaha_kalendar_override WHERE id = :i"),
                     {"i": ov_id})
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, "Override not found")
    scheduler_service.reload_jobs()
    return {"ok": True}
