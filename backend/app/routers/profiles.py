"""CRUD pro pojmenované profily závlahy (duration-based)."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import ssh_service

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


# ---------- pydantic ----------
class StepIn(BaseModel):
    zone: str
    duration_s: int = Field(ge=ssh_service.STEP_DURATION_MIN,
                            le=ssh_service.STEP_DURATION_MAX)

    @field_validator("zone")
    @classmethod
    def _z(cls, v: str) -> str:
        # 'both' v profilu nedává smysl – profil tvoří jednotlivé kroky
        if v not in ssh_service.ALLOWED_ZONES or v == "both":
            raise ValueError(f"Invalid zone: {v}")
        return v


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    note: Optional[str] = Field(None, max_length=255)
    is_default: bool = False
    steps: list[StepIn] = Field(min_length=1, max_length=10)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        # Pi-script přebírá název přes --profile-name; whitelistovaný regex
        import re
        if not re.match(r"^[a-zA-Z0-9_\-]+$", v):
            raise ValueError("Name může obsahovat jen [A-Za-z0-9_-]")
        return v


# ---------- helpers ----------
def _load_profile(db: Session, prof_id: int) -> dict:
    s = db.execute(text(
        "SELECT id, name, note, is_default, created_at FROM zavlaha_profil WHERE id=:i"
    ), {"i": prof_id}).fetchone()
    if not s:
        raise HTTPException(404, "Profile not found")
    steps = db.execute(text(
        "SELECT id, krok_order, zone, duration_s "
        "FROM zavlaha_profil_krok WHERE profil_id=:i ORDER BY krok_order"
    ), {"i": prof_id}).fetchall()
    return {
        "id": s.id, "name": s.name, "note": s.note,
        "is_default": bool(s.is_default),
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "steps": [
            {"id": k.id, "order": k.krok_order, "zone": k.zone,
             "duration_s": int(k.duration_s)}
            for k in steps
        ],
    }


def _replace_steps(db: Session, prof_id: int, steps: list[StepIn]) -> None:
    db.execute(text("DELETE FROM zavlaha_profil_krok WHERE profil_id=:i"),
               {"i": prof_id})
    for i, st in enumerate(steps, start=1):
        db.execute(text(
            "INSERT INTO zavlaha_profil_krok "
            "(profil_id, krok_order, zone, duration_s) "
            "VALUES (:s, :o, :z, :d)"
        ), {"s": prof_id, "o": i, "z": st.zone, "d": st.duration_s})


def _unset_other_defaults(db: Session, keep_id: Optional[int]) -> None:
    if keep_id is None:
        db.execute(text("UPDATE zavlaha_profil SET is_default=0"))
    else:
        db.execute(text("UPDATE zavlaha_profil SET is_default=0 WHERE id <> :i"),
                   {"i": keep_id})


# ---------- endpoints ----------
@router.get("")
def list_profiles(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(text(
        "SELECT id FROM zavlaha_profil ORDER BY is_default DESC, name"
    )).fetchall()
    return {"profiles": [_load_profile(db, r.id) for r in rows]}


@router.get("/{prof_id}")
def get_profile(prof_id: int, db: Session = Depends(get_db)) -> dict:
    return _load_profile(db, prof_id)


@router.post("")
def create_profile(payload: ProfileIn, db: Session = Depends(get_db)) -> dict:
    exists = db.execute(text("SELECT id FROM zavlaha_profil WHERE name=:n"),
                       {"n": payload.name}).fetchone()
    if exists:
        raise HTTPException(409, f"Profil '{payload.name}' už existuje")
    res = db.execute(text(
        "INSERT INTO zavlaha_profil (name, note, is_default) VALUES (:n, :nt, :d)"
    ), {"n": payload.name, "nt": payload.note,
        "d": 1 if payload.is_default else 0})
    prof_id = res.lastrowid
    _replace_steps(db, prof_id, payload.steps)
    if payload.is_default:
        _unset_other_defaults(db, keep_id=prof_id)
    db.commit()
    return _load_profile(db, prof_id)


@router.put("/{prof_id}")
def update_profile(prof_id: int, payload: ProfileIn,
                   db: Session = Depends(get_db)) -> dict:
    exists = db.execute(text("SELECT id FROM zavlaha_profil WHERE id=:i"),
                        {"i": prof_id}).fetchone()
    if not exists:
        raise HTTPException(404, "Profile not found")
    dup = db.execute(text("SELECT id FROM zavlaha_profil WHERE name=:n AND id<>:i"),
                     {"n": payload.name, "i": prof_id}).fetchone()
    if dup:
        raise HTTPException(409, f"Profil '{payload.name}' už existuje")
    db.execute(text(
        "UPDATE zavlaha_profil SET name=:n, note=:nt, is_default=:d WHERE id=:i"
    ), {"n": payload.name, "nt": payload.note,
        "d": 1 if payload.is_default else 0, "i": prof_id})
    _replace_steps(db, prof_id, payload.steps)
    if payload.is_default:
        _unset_other_defaults(db, keep_id=prof_id)
    db.commit()
    return _load_profile(db, prof_id)


@router.delete("/{prof_id}")
def delete_profile(prof_id: int, db: Session = Depends(get_db)) -> dict:
    res = db.execute(text("DELETE FROM zavlaha_profil WHERE id=:i"), {"i": prof_id})
    db.commit()
    if res.rowcount == 0:
        raise HTTPException(404, "Profile not found")
    return {"ok": True}


@router.post("/{prof_id}/run")
def run_profile_now(prof_id: int, db: Session = Depends(get_db)) -> dict:
    """Ruční spuštění profilu (atomicky po sobě na Pi)."""
    prof = _load_profile(db, prof_id)
    if not prof["steps"]:
        raise HTTPException(400, "Profil nemá kroky")
    running = ssh_service.zavlaha_running()
    if running.get("running"):
        raise HTTPException(409, "Závlaha už běží")
    steps = [{"zone": s["zone"], "duration": int(s["duration_s"])}
             for s in prof["steps"]]
    ssh_service.run_zavlaha_profile(steps, source="profile",
                                    profile_name=prof["name"])
    # Log per-step se start_time posunutým o dobu předchozích kroků (dashboard zobrazí "běží")
    cursor = datetime.now()
    for s in prof["steps"]:
        db.execute(text(
            "INSERT INTO kapkova_zavlaha_log "
            "(zone, start_time, stop_time, source, note) "
            "VALUES (:z, :t, NULL, 'profile', :n)"
        ), {"z": s["zone"], "t": cursor,
            "n": f"prof#{prof_id} {prof['name']}"})
        cursor += timedelta(seconds=int(s["duration_s"]) + 2)
    db.commit()
    return {"ok": True, "profile": prof["name"], "steps": len(prof["steps"])}
