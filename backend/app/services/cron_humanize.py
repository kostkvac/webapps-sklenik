"""Lidsky čitelný popis cron výrazu (5 polí)."""
from __future__ import annotations

_DAYS_CZ = ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"]
_DAYS_FULL = ["Neděle", "Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek", "Sobota"]


def _parse_field(field: str, lo: int, hi: int) -> list[int]:
    """Rozparsuje cron field na seznam celých čísel; vrátí [] pro '*'."""
    if field == "*":
        return []
    out: set[int] = set()
    for part in field.split(","):
        if "/" in part:
            base, step_s = part.split("/", 1)
            step = int(step_s)
            if base == "*":
                rng = range(lo, hi + 1, step)
            elif "-" in base:
                a, b = base.split("-", 1)
                rng = range(int(a), int(b) + 1, step)
            else:
                rng = range(int(base), hi + 1, step)
            out.update(rng)
        elif "-" in part:
            a, b = part.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(part))
    return sorted(out)


def _fmt_days(days: list[int]) -> str:
    if not days:
        return "denně"
    # Po-Pá = [1,2,3,4,5]
    if days == [1, 2, 3, 4, 5]:
        return "po pracovní dny (Po–Pá)"
    if days == [0, 6]:
        return "o víkendu (So–Ne)"
    if len(days) == 7 or set(days) == set(range(7)):
        return "denně"
    # Souvislý interval (např. 3-0 = St-Ne) — nejen kontinuální
    return "ve dnech " + ", ".join(_DAYS_CZ[d] for d in days)


def humanize_cron(expr: str) -> str:
    """Převede 5-pole cron na lidský popis. Při chybě vrátí samotný výraz."""
    try:
        parts = expr.split()
        if len(parts) != 5:
            return expr
        minute, hour, dom, mon, dow = parts

        minutes = _parse_field(minute, 0, 59)
        hours = _parse_field(hour, 0, 23)
        days_week = _parse_field(dow, 0, 6)

        # Sestavit časy
        if minutes and hours:
            times = []
            for h in hours:
                for m in minutes:
                    times.append(f"{h:02d}:{m:02d}")
        elif hours and not minutes:
            times = [f"{h:02d}:00" for h in hours]
        elif not hours and minutes:
            times = [f"každou hodinu v :{m:02d}" for m in minutes]
        else:
            times = ["každou minutu"]

        # Dny v měsíci (zatím podporujeme jen *)
        dom_part = ""
        if dom != "*":
            dom_days = _parse_field(dom, 1, 31)
            dom_part = " (dny v měsíci: " + ",".join(str(d) for d in dom_days) + ")"

        # Měsíce
        mon_part = ""
        if mon != "*":
            mons = _parse_field(mon, 1, 12)
            mon_part = " (měsíce: " + ",".join(str(m) for m in mons) + ")"

        days_str = _fmt_days(days_week)
        times_str = ", ".join(times)
        return f"{days_str} v {times_str}{dom_part}{mon_part}"
    except Exception:  # noqa: BLE001
        return expr
