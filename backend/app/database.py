"""MariaDB connection for sklenik (read-only)."""
from typing import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import sklenik_settings

DATABASE_URL = (
    f"mysql+pymysql://{sklenik_settings.DB_USER}:{sklenik_settings.DB_PASSWORD}"
    f"@{sklenik_settings.DB_HOST}:{sklenik_settings.DB_PORT}/{sklenik_settings.DB_NAME}"
    f"?charset=utf8mb4"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5, max_overflow=10)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def test_connection() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
