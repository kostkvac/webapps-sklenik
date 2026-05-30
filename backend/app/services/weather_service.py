"""Weather service – proxy na travnik backend s lokální cache.

Skleník nevolá Open-Meteo přímo, ale sdílí cache s travnik backendem
(stejná lokalita). Lokální tabulka weather_cache slouží jako fallback
pokud travnik backend není dostupný.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from typing import Optional

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import sklenik_settings

logger = logging.getLogger("sklenik.weather")


async def _fetch_from_proxy(force: bool = False) -> dict:
    """Stáhne forecast z travnik proxy backendu."""
    url = sklenik_settings.WEATHER_PROXY_URL
    params = {"force": "true"} if force else {}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        return r.json()


def _cache_get_fresh(db: Session) -> Optional[dict]:
    threshold = datetime.now() - timedelta(minutes=sklenik_settings.WEATHER_CACHE_MINUTES)
    row = db.execute(
        text(
            "SELECT fetched_at, raw_json FROM weather_cache "
            "WHERE fetched_at >= :since ORDER BY fetched_at DESC LIMIT 1"
        ),
        {"since": threshold},
    ).fetchone()
    if not row:
        return None
    try:
        data = json.loads(row.raw_json)
    except Exception:
        return None
    data["from_cache"] = True
    return data


def _cache_get_any(db: Session) -> Optional[dict]:
    """Fallback: vrátí jakkoliv starou cache, když proxy selže."""
    row = db.execute(
        text("SELECT fetched_at, raw_json FROM weather_cache "
             "ORDER BY fetched_at DESC LIMIT 1")
    ).fetchone()
    if not row:
        return None
    try:
        data = json.loads(row.raw_json)
    except Exception:
        return None
    data["from_cache"] = True
    data["stale"] = True
    return data


async def get_forecast(db: Session, force: bool = False) -> dict:
    """Vrátí předpověď – z lokální cache, pokud čerstvá; jinak z proxy."""
    if not force:
        cached = _cache_get_fresh(db)
        if cached:
            return cached

    try:
        data = await _fetch_from_proxy(force=force)
    except Exception as exc:
        logger.warning("Weather proxy fetch failed (%s); using stale cache", exc)
        stale = _cache_get_any(db)
        if stale:
            return stale
        raise

    db.execute(
        text("INSERT INTO weather_cache (fetched_at, raw_json) VALUES (:ts, :raw)"),
        {"ts": datetime.now(), "raw": json.dumps(data, ensure_ascii=False)},
    )
    db.commit()
    data["from_cache"] = False
    return data


def should_skip(forecast: dict, *, skip_if_rain: bool,
                min_temp_c: Optional[float],
                rain_threshold_mm: float = 1.0) -> tuple[bool, str]:
    """Rozhodne, zda naplánovaná závlaha má být přeskočena (déšť/zima)."""
    precip = forecast.get("precip_mm")
    tmin = forecast.get("temp_min_c")
    if skip_if_rain and precip is not None and precip >= rain_threshold_mm:
        return True, f"skipped_rain ({precip:.1f}mm)"
    if min_temp_c is not None and tmin is not None and tmin < min_temp_c:
        return True, f"skipped_cold ({tmin:.1f}°C < {min_temp_c:.1f}°C)"
    return False, "ok"
