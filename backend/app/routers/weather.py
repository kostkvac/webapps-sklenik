"""Weather router – Open-Meteo proxy s cache."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import weather_service

router = APIRouter(prefix="/api/weather", tags=["weather"])


@router.get("")
async def get_weather(
    force: bool = Query(False, description="Force re-fetch (ignore cache)"),
    db: Session = Depends(get_db),
) -> dict:
    try:
        return await weather_service.get_forecast(db, force=force)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Weather fetch failed: {exc}")
