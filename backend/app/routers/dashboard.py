"""Dashboard router – latest sensor readings + monitoring status."""
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import ssh_service

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

# Active sensors only (per prompt)
TEMP_TABLES = ["teplota_dolni", "teplota_horni", "teplota_venkovni"]
HUMIDITY_TABLES = ["vlhkost_pudy_sadba", "vlhkost_pudy_zahon"]
HISTORY_TABLES = TEMP_TABLES + HUMIDITY_TABLES + ["prutok"]


def _latest_value(db: Session, table: str, value_col: str) -> Optional[dict]:
    row = db.execute(
        text(f"SELECT timestamp, {value_col} AS value FROM {table} "
             f"ORDER BY timestamp DESC LIMIT 1")
    ).fetchone()
    if row is None:
        return None
    return {"timestamp": row.timestamp.isoformat() if row.timestamp else None,
            "value": float(row.value) if row.value is not None else None}


@router.get("/latest")
def latest_readings(db: Session = Depends(get_db)) -> dict:
    """Latest reading from each active sensor table."""
    teploty = {t: _latest_value(db, t, "teplota") for t in TEMP_TABLES}
    vlhkost = {t: _latest_value(db, t, "vlhkost") for t in HUMIDITY_TABLES}
    prutok = _latest_value(db, "prutok", "prutok")
    return {
        "teploty": teploty,
        "vlhkost": vlhkost,
        "prutok": prutok,
    }


@router.get("/monitoring-status")
def monitoring_status() -> dict:
    try:
        return ssh_service.monitoring_status()
    except ssh_service.SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/history")
def history(
    table: str = Query(..., description="Table name"),
    hours: int = Query(24, ge=1, le=24 * 30),
    db: Session = Depends(get_db),
) -> dict:
    if table not in HISTORY_TABLES:
        raise HTTPException(status_code=400, detail=f"Unknown table: {table}")
    value_col = "prutok" if table == "prutok" else (
        "vlhkost" if table.startswith("vlhkost") else "teplota"
    )
    since = datetime.now() - timedelta(hours=hours)
    rows = db.execute(
        text(f"SELECT timestamp, {value_col} AS value FROM {table} "
             f"WHERE timestamp >= :since ORDER BY timestamp ASC"),
        {"since": since},
    ).fetchall()
    return {
        "table": table,
        "hours": hours,
        "points": [
            {"t": r.timestamp.isoformat() if r.timestamp else None,
             "v": float(r.value) if r.value is not None else None}
            for r in rows
        ],
    }


@router.get("/ventilator-log")
def ventilator_log(limit: int = Query(20, ge=1, le=200), db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        text("SELECT id, start_time, stop_time, duration_seconds "
             "FROM ventilator_log ORDER BY start_time DESC LIMIT :lim"),
        {"lim": limit},
    ).fetchall()
    return {
        "rows": [
            {
                "id": r.id,
                "start": r.start_time.isoformat() if r.start_time else None,
                "stop": r.stop_time.isoformat() if r.stop_time else None,
                "duration_s": r.duration_seconds,
            }
            for r in rows
        ]
    }


@router.get("/activity")
def activity(
    hours: int = Query(48, ge=1, le=24 * 30),
    db: Session = Depends(get_db),
) -> dict:
    """Unified chronological activity feed from all event log tables."""
    since = datetime.now() - timedelta(hours=hours)
    rows = db.execute(
        text("""
            SELECT 'tepelny_ventilator' AS type,
                   'Tepelný ventilátor' AS label,
                   start_time, stop_time, NULL AS zone, NULL AS source
            FROM ventilator_log WHERE start_time >= :since
            UNION ALL
            SELECT 'kapkova_zavlaha',
                   CONCAT('Závlaha – ', zone),
                   start_time, stop_time, zone, source
            FROM kapkova_zavlaha_log WHERE start_time >= :since
            UNION ALL
            SELECT 'vetrak',
                   'Větráček (ochlazování)',
                   start_time, stop_time, NULL, NULL
            FROM vetrak_log WHERE start_time >= :since
            ORDER BY start_time DESC
            LIMIT 200
        """),
        {"since": since},
    ).fetchall()

    def _fmt(dt) -> str | None:
        return dt.isoformat() if dt else None

    def _dur(start, stop) -> int | None:
        if start and stop:
            return int((stop - start).total_seconds())
        return None

    return {
        "hours": hours,
        "events": [
            {
                "type": r.type,
                "label": r.label,
                "start": _fmt(r.start_time),
                "stop": _fmt(r.stop_time),
                "duration_s": _dur(r.start_time, r.stop_time),
                "zone": r.zone,
                "source": r.source,
            }
            for r in rows
        ],
    }
