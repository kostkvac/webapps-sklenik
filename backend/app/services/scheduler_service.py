"""APScheduler – naplánované závlahy se rain/cold-aware skipping.

Adaptováno z travnik backendu na duration-based model:
- schedule: cron_expr → buď profil_id nebo zone+duration_s
- profil: posloupnost kroků (zone, duration_s) běží atomicky na Pi
- override: kalendářové výjimky (skip/add)
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, date, time as dtime, timedelta
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import text, bindparam

from app.database import SessionLocal
from app.services import ssh_service, weather_service

logger = logging.getLogger("sklenik.scheduler")

_scheduler: Optional[AsyncIOScheduler] = None
# Serializace: jen 1 plánovaná úloha najednou (jinak by se kroky překryly)
_run_lock = asyncio.Lock()


def get_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = AsyncIOScheduler(timezone="Europe/Prague")
    return _scheduler


# --- Helpers ------------------------------------------------------------------
def _load_profile_steps(db, profil_id: int) -> list[dict]:
    rows = db.execute(text(
        "SELECT zone, duration_s FROM zavlaha_profil_krok "
        "WHERE profil_id = :i ORDER BY krok_order"
    ), {"i": profil_id}).fetchall()
    return [{"zone": r.zone, "duration": int(r.duration_s)} for r in rows]


def _profile_name(db, profil_id: int) -> str:
    row = db.execute(
        text("SELECT name FROM zavlaha_profil WHERE id = :i"), {"i": profil_id}
    ).fetchone()
    return row.name if row else "profil"


def _insert_log_start(db, zone: str, source: str, note: str = "") -> Optional[int]:
    """Vloží start-záznam (kompatibilní s pi-scriptem); finalizace doplní stop_time."""
    res = db.execute(text(
        "INSERT INTO kapkova_zavlaha_log (zone, start_time, source, note) "
        "VALUES (:z, :ts, :src, :n)"
    ), {"z": zone, "ts": datetime.now(), "src": source, "n": note or None})
    return int(res.lastrowid) if res.lastrowid else None


def _insert_skip_log(db, zone: str, reason: str, note: str = "") -> None:
    now = datetime.now()
    db.execute(text(
        "INSERT INTO kapkova_zavlaha_log "
        "(zone, start_time, stop_time, duration_s, source, note) "
        "VALUES (:z, :ts, :ts, 0, 'skipped', :n)"
    ), {"z": zone or "profil", "ts": now,
        "n": f"{reason}: {note}" if note else reason})


# --- Job: cron schedule -------------------------------------------------------
async def _execute_schedule(schedule_id: int) -> None:
    async with _run_lock:
        db = SessionLocal()
        try:
            row = db.execute(text(
                "SELECT id, name, profil_id, zone, duration_s, "
                "       skip_if_rain, min_temp_c, enabled "
                "FROM schedule WHERE id = :id"
            ), {"id": schedule_id}).fetchone()
            if not row:
                logger.warning("Schedule %s not found", schedule_id)
                return
            if not row.enabled:
                logger.info("Schedule %s disabled – skip", schedule_id)
                return

            # Kalendářový override 'skip'?
            today = date.today()
            now_t = datetime.now().strftime("%H:%M")
            ov = db.execute(text(
                "SELECT id FROM zavlaha_kalendar_override "
                "WHERE action='skip' AND schedule_id = :sid AND run_date = :d "
                "  AND (run_time IS NULL OR TIME_FORMAT(run_time,'%H:%i') = :t) "
                "LIMIT 1"
            ), {"sid": schedule_id, "d": today, "t": now_t}).fetchone()
            if ov:
                logger.info("Schedule %s skipped by calendar override #%s", schedule_id, ov.id)
                db.execute(text(
                    "UPDATE zavlaha_kalendar_override "
                    "SET status='skipped_by_user', executed_at=NOW() WHERE id=:i"
                ), {"i": ov.id})
                db.execute(text(
                    "UPDATE schedule SET last_run_at=:ts, last_status='skipped_calendar' WHERE id=:id"
                ), {"ts": datetime.now(), "id": schedule_id})
                db.commit()
                return

            status = "ok"
            try:
                skip, reason = False, ""
                try:
                    forecast = await weather_service.get_forecast(db)
                    skip, reason = weather_service.should_skip(
                        forecast,
                        skip_if_rain=bool(row.skip_if_rain),
                        min_temp_c=float(row.min_temp_c) if row.min_temp_c is not None else None,
                    )
                except Exception as wx_exc:  # noqa: BLE001
                    logger.warning("Schedule %s: weather fetch failed (%s), proceeding anyway",
                                   schedule_id, wx_exc)

                if skip:
                    status = reason
                    logger.info("Schedule %s skipped: %s", schedule_id, reason)
                    _insert_skip_log(db, row.zone or "profil", reason, note=row.name)
                else:
                    running = ssh_service.zavlaha_running()
                    if running.get("running"):
                        status = "skipped_busy"
                        logger.info("Schedule %s: zavlaha already running", schedule_id)
                    elif row.profil_id:
                        steps = _load_profile_steps(db, int(row.profil_id))
                        if not steps:
                            status = "error:empty_profile"
                        else:
                            pname = _profile_name(db, int(row.profil_id))
                            ssh_service.run_zavlaha_profile(
                                steps, source="scheduled", profile_name=pname,
                            )
                            status = "ok"
                    elif row.zone and row.duration_s:
                        ssh_service.run_zavlaha(zone=row.zone, duration=int(row.duration_s))
                        status = "ok"
                    else:
                        status = "error:no_target"
            except Exception as exc:  # noqa: BLE001
                status = f"error:{exc}"[:60]
                logger.exception("Schedule %s execution failed", schedule_id)

            db.execute(text(
                "UPDATE schedule SET last_run_at = :ts, last_status = :st, "
                "runs_count = runs_count + 1 WHERE id = :id"
            ), {"ts": datetime.now(), "st": status, "id": schedule_id})

            check = db.execute(text(
                "SELECT runs_count, max_runs, end_date FROM schedule WHERE id = :id"
            ), {"id": schedule_id}).fetchone()
            if check:
                expired = False
                if check.max_runs and check.runs_count >= check.max_runs:
                    expired = True
                    logger.info("Schedule %s deactivated: max_runs %d reached",
                                schedule_id, check.max_runs)
                elif check.end_date and date.today() >= check.end_date:
                    expired = True
                    logger.info("Schedule %s deactivated: end_date %s reached",
                                schedule_id, check.end_date)
                if expired:
                    db.execute(text("UPDATE schedule SET enabled = 0 WHERE id = :id"),
                               {"id": schedule_id})
            db.commit()
        finally:
            db.close()


# --- Job: one-off override 'add' ---------------------------------------------
async def _execute_override_add(override_id: int) -> None:
    async with _run_lock:
        db = SessionLocal()
        try:
            row = db.execute(text(
                "SELECT id, zone, duration_s, profil_id, note, "
                "       skip_if_rain, min_temp_c "
                "FROM zavlaha_kalendar_override WHERE id = :i"
            ), {"i": override_id}).fetchone()
            if not row:
                logger.warning("Override %s missing", override_id)
                return
            if not row.profil_id and not row.zone:
                logger.warning("Override %s missing zone/profil", override_id)
                return

            status = "ok"
            try:
                skip, reason = False, ""
                try:
                    forecast = await weather_service.get_forecast(db)
                    skip, reason = weather_service.should_skip(
                        forecast,
                        skip_if_rain=bool(row.skip_if_rain),
                        min_temp_c=float(row.min_temp_c) if row.min_temp_c is not None else None,
                    )
                except Exception as wx_exc:  # noqa: BLE001
                    logger.warning("Override %s: weather fetch failed (%s)", override_id, wx_exc)

                if skip:
                    status = reason
                    _insert_skip_log(db, row.zone or "profil", reason, note=row.note or "")
                else:
                    running = ssh_service.zavlaha_running()
                    if running.get("running"):
                        status = "skipped_busy"
                    elif row.profil_id:
                        steps = _load_profile_steps(db, int(row.profil_id))
                        if not steps:
                            status = "error:empty_profile"
                        else:
                            pname = _profile_name(db, int(row.profil_id))
                            ssh_service.run_zavlaha_profile(
                                steps, source="calendar", profile_name=pname,
                            )
                    elif row.zone and row.duration_s:
                        ssh_service.run_zavlaha(zone=row.zone, duration=int(row.duration_s))
                    else:
                        status = "error:no_target"
            except Exception as exc:  # noqa: BLE001
                status = f"error:{exc}"[:60]
                logger.exception("Override %s exec failed", override_id)

            db.execute(text(
                "UPDATE zavlaha_kalendar_override "
                "SET status=:s, executed_at=NOW() WHERE id=:i"
            ), {"s": status, "i": override_id})
            db.commit()
        finally:
            db.close()


# --- Job loading --------------------------------------------------------------
def _load_jobs() -> None:
    sched = get_scheduler()
    sched.remove_all_jobs()
    db = SessionLocal()
    try:
        rows = db.execute(text(
            "SELECT id, name, cron_expr, enabled, start_date, end_date, max_runs, runs_count "
            "FROM schedule WHERE enabled = 1 "
            "  AND (start_date IS NULL OR start_date <= CURDATE()) "
            "  AND (end_date IS NULL OR end_date >= CURDATE()) "
            "  AND (max_runs IS NULL OR runs_count < max_runs)"
        )).fetchall()
        for r in rows:
            try:
                trigger = CronTrigger.from_crontab(r.cron_expr, timezone="Europe/Prague")
            except Exception as exc:  # noqa: BLE001
                logger.error("Invalid cron '%s' for schedule %s: %s", r.cron_expr, r.id, exc)
                continue
            sched.add_job(
                _execute_schedule, trigger=trigger, args=[r.id],
                id=f"sched-{r.id}", name=r.name, replace_existing=True,
                misfire_grace_time=300, coalesce=True, max_instances=1,
            )
        logger.info("Loaded %d enabled schedule(s)", len(rows))

        ov_rows = db.execute(text(
            "SELECT id, run_date, run_time, note, zone FROM zavlaha_kalendar_override "
            "WHERE action='add' AND executed_at IS NULL "
            "  AND (run_date > CURDATE() OR (run_date = CURDATE() AND run_time > CURTIME())) "
            "ORDER BY run_date, run_time"
        )).fetchall()
        for ov in ov_rows:
            rd = ov.run_date if isinstance(ov.run_date, date) else date.fromisoformat(str(ov.run_date))
            if isinstance(ov.run_time, timedelta):
                total = int(ov.run_time.total_seconds())
                rt = dtime(hour=total // 3600, minute=(total % 3600) // 60)
            elif isinstance(ov.run_time, dtime):
                rt = ov.run_time
            else:
                continue
            run_dt = datetime.combine(rd, rt)
            if run_dt <= datetime.now():
                continue
            ov_name = (ov.note or "").strip() or "Jednorázový běh"
            sched.add_job(
                _execute_override_add,
                trigger=DateTrigger(run_date=run_dt, timezone="Europe/Prague"),
                args=[ov.id],
                id=f"override-add-{ov.id}", name=ov_name,
                replace_existing=True, misfire_grace_time=300,
            )
        logger.info("Loaded %d one-off override(s)", len(ov_rows))
    finally:
        db.close()


# --- Background helpers -------------------------------------------------------
def _finalize_zavlaha_jobs() -> None:
    """Doplní stop_time u řádků v kapkova_zavlaha_log, kde už závlaha neběží."""
    db = SessionLocal()
    try:
        db.rollback()
        open_rows = db.execute(text(
            "SELECT id FROM kapkova_zavlaha_log WHERE stop_time IS NULL"
        )).fetchall()
        if not open_rows:
            return

        # Stale fallback (záznam > 1h bez stop)
        db.execute(text(
            "UPDATE kapkova_zavlaha_log SET stop_time = start_time + INTERVAL 600 SECOND "
            "WHERE stop_time IS NULL AND start_time < NOW() - INTERVAL 1 HOUR"
        ))
        db.commit()

        try:
            running = ssh_service.zavlaha_running().get("running")
        except ssh_service.SSHError as exc:
            logger.warning("finalize: SSH check failed: %s", exc)
            return
        if running:
            return
        # Pi-script si stop_time zapisuje sám; toto je jen fallback pro restart serveru atd.
        res = db.execute(text(
            "UPDATE kapkova_zavlaha_log SET stop_time = NOW(), "
            "duration_s = TIMESTAMPDIFF(SECOND, start_time, NOW()) "
            "WHERE stop_time IS NULL"
        ))
        db.commit()
        if res.rowcount:
            logger.info("Finalized %d kapkova_zavlaha_log row(s)", res.rowcount)
    finally:
        db.close()


def _expire_schedules() -> None:
    db = SessionLocal()
    try:
        db.rollback()
        res = db.execute(text(
            "UPDATE schedule SET enabled = 0 "
            "WHERE enabled = 1 AND ("
            "  (end_date IS NOT NULL AND end_date < CURDATE()) OR "
            "  (max_runs IS NOT NULL AND runs_count >= max_runs)"
            ")"
        ))
        db.commit()
        if res.rowcount:
            logger.info("Auto-deactivated %d expired schedule(s)", res.rowcount)
            _load_jobs()
    finally:
        db.close()


def start() -> None:
    sched = get_scheduler()
    _load_jobs()
    sched.add_job(
        _finalize_zavlaha_jobs, trigger=IntervalTrigger(seconds=60),
        id="finalize-zavlaha", name="finalize-zavlaha",
        replace_existing=True, max_instances=1,
    )
    sched.add_job(
        _expire_schedules, trigger=CronTrigger(hour=0, minute=5, timezone="Europe/Prague"),
        id="expire-schedules", name="expire-schedules",
        replace_existing=True, max_instances=1,
    )
    sched.start()
    logger.info("Scheduler started")


def reload_jobs() -> None:
    _load_jobs()
    sched = get_scheduler()
    job_ids = {j.id for j in sched.get_jobs()}
    if "finalize-zavlaha" not in job_ids:
        sched.add_job(_finalize_zavlaha_jobs, trigger=IntervalTrigger(seconds=60),
                      id="finalize-zavlaha", name="finalize-zavlaha",
                      replace_existing=True, max_instances=1)
    if "expire-schedules" not in job_ids:
        sched.add_job(_expire_schedules,
                      trigger=CronTrigger(hour=0, minute=5, timezone="Europe/Prague"),
                      id="expire-schedules", name="expire-schedules",
                      replace_existing=True, max_instances=1)


def shutdown() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
    _scheduler = None


def list_jobs() -> list[dict]:
    sched = get_scheduler()
    jobs = [
        {"id": j.id, "name": j.name,
         "next_run_time": j.next_run_time.isoformat() if j.next_run_time else None}
        for j in sched.get_jobs()
    ]
    ov_ids = [int(j["id"].split("-")[-1]) for j in jobs if j["id"].startswith("override-add-")]
    if ov_ids:
        db = SessionLocal()
        try:
            rows = db.execute(text(
                "SELECT o.id, o.zone, o.profil_id, s.name AS profil_name "
                "FROM zavlaha_kalendar_override o "
                "LEFT JOIN zavlaha_profil s ON s.id = o.profil_id "
                "WHERE o.id IN :ids"
            ).bindparams(bindparam("ids", expanding=True)), {"ids": ov_ids}).fetchall()
            meta = {int(r.id): {"zone": r.zone, "profil_id": r.profil_id,
                                "profil_name": r.profil_name} for r in rows}
            for j in jobs:
                if j["id"].startswith("override-add-"):
                    oid = int(j["id"].split("-")[-1])
                    m = meta.get(oid, {})
                    j["zone"] = m.get("zone")
                    j["profil_id"] = m.get("profil_id")
                    j["profil_name"] = m.get("profil_name")
        finally:
            db.close()
    return jobs
