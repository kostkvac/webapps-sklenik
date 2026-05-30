"""SSH service – paramiko wrapper with strict whitelist for sklenik Pi."""
from __future__ import annotations

import io
import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

import paramiko

from app.config import sklenik_settings

logger = logging.getLogger("sklenik.ssh")

# --- Whitelists ---------------------------------------------------------------
ALLOWED_ZONES = {"kapkova_a", "kapkova_b", "both"}
ALLOWED_LOGS = {"monitoring", "tepelny_ventilator", "kapkova_zavlaha", "teplota", "vlhkost_pudy", "prutok"}
ALLOWED_MONITORING_ACTIONS = {"start", "stop", "restart", "status"}
ALLOWED_MODULES = {"teplota", "vlhkost_pudy", "tepelny_ventilator", "vetrak", "kapkova_zavlaha", "prutok"}
ALLOWED_SOURCES = {"manual", "scheduled", "calendar", "profile"}
DURATION_MIN, DURATION_MAX = 10, 600
STEP_DURATION_MIN, STEP_DURATION_MAX = 1, 3600
PROFILE_NAME_RE = re.compile(r"^[a-zA-Z0-9_\-]+$")

CONFIG_PATH = "/usr/local/bin/config.json"
SCRIPTS_DIR = "/usr/local/bin"
LOGS_DIR = "/usr/local/bin/logs"

_SCRIPT_NAME_RE = re.compile(r"^[a-zA-Z0-9_]+\.py$")


@dataclass
class SSHResult:
    stdout: str
    stderr: str
    exit_code: int

    @property
    def ok(self) -> bool:
        return self.exit_code == 0


class SSHError(Exception):
    pass


# --- Connection helper --------------------------------------------------------
def _client() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=sklenik_settings.SSH_HOST,
            port=sklenik_settings.SSH_PORT,
            username=sklenik_settings.SSH_USER,
            key_filename=sklenik_settings.SSH_KEY_PATH,
            timeout=sklenik_settings.SSH_TIMEOUT,
            allow_agent=False,
            look_for_keys=False,
        )
    except Exception as exc:
        raise SSHError(f"SSH connect failed: {exc}") from exc
    return client


def _exec(cmd: str, timeout: int = 30) -> SSHResult:
    """Execute a single command. cmd MUST be a fully built whitelisted string."""
    logger.info("SSH exec: %s", cmd)
    client = _client()
    try:
        _stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        rc = stdout.channel.recv_exit_status()
        return SSHResult(stdout=out, stderr=err, exit_code=rc)
    finally:
        client.close()


# --- Public API ---------------------------------------------------------------
def monitoring_status() -> dict:
    res = _exec("pgrep -f monitoring.py")
    pids = [p for p in res.stdout.strip().splitlines() if p.strip()]
    return {"running": bool(pids), "pids": pids, "stderr": res.stderr}


def monitoring_action(action: str) -> SSHResult:
    if action not in ALLOWED_MONITORING_ACTIONS:
        raise SSHError(f"Invalid monitoring action: {action}")
    return _exec(f"python /usr/local/bin/monitoring_control.py {action}", timeout=60)


ZAVLAHA_LOCK = "/tmp/kapkova_zavlaha.lock"


def run_zavlaha(zone: str, duration: int) -> SSHResult:
    if zone not in ALLOWED_ZONES:
        raise SSHError(f"Invalid zone: {zone}")
    if not isinstance(duration, int) or not DURATION_MIN <= duration <= DURATION_MAX:
        raise SSHError(f"Invalid duration: {duration}")
    log = f"{LOGS_DIR}/kapkova_zavlaha.log"
    base = "python /usr/local/bin/kapkova_zavlaha.py --manual"
    if zone == "both":
        # Chain both zones sequentially in a single background process
        inner = (f"{base} --zone kapkova_a --duration {duration} && "
                 f"{base} --zone kapkova_b --duration {duration}")
        cmd = f"nohup sh -c '{inner}' >>{log} 2>&1 </dev/null &"
    else:
        cmd = f"nohup {base} --zone {zone} --duration {duration} >>{log} 2>&1 </dev/null &"
    return _exec(cmd, timeout=15)


def run_zavlaha_profile(steps: list[dict], source: str = "profile",
                        profile_name: str = "profil") -> SSHResult:
    """Spustí profil = sekvenci kroků atomicky pod jedním lockem.

    steps: list of {"zone": str, "duration": int}
    """
    if source not in ALLOWED_SOURCES:
        raise SSHError(f"Invalid source: {source}")
    if not PROFILE_NAME_RE.match(profile_name or "profil"):
        raise SSHError(f"Invalid profile_name: {profile_name}")
    if not steps:
        raise SSHError("Empty profile steps")
    parts = []
    for i, st in enumerate(steps):
        zname = st.get("zone")
        dur = st.get("duration")
        if zname not in ALLOWED_ZONES or zname == "both":
            raise SSHError(f"step {i}: invalid zone {zname!r}")
        if not isinstance(dur, int) or not STEP_DURATION_MIN <= dur <= STEP_DURATION_MAX:
            raise SSHError(f"step {i}: invalid duration {dur!r}")
        parts.append(f"{zname}:{dur}")
    steps_arg = ",".join(parts)
    log = f"{LOGS_DIR}/kapkova_zavlaha.log"
    cmd = (f"nohup python /usr/local/bin/kapkova_zavlaha.py "
           f"--profile-steps {steps_arg} "
           f"--profile-name {profile_name} "
           f"--source {source} "
           f">>{log} 2>&1 </dev/null &")
    return _exec(cmd, timeout=15)


def zavlaha_running() -> dict:
    """Check if irrigation is currently running via lock file."""
    res = _exec(
        f"if [ -f {ZAVLAHA_LOCK} ]; then "
        f"  pid=$(cat {ZAVLAHA_LOCK}); "
        f"  if kill -0 $pid 2>/dev/null; then echo running $pid; "
        f"  else echo idle; fi; "
        f"else echo idle; fi"
    )
    parts = res.stdout.strip().split()
    running = bool(parts) and parts[0] == "running"
    pid = int(parts[1]) if running and len(parts) > 1 else None
    return {"running": running, "pid": pid}


def tail_log(log_name: str, lines: int = 50) -> str:
    if log_name not in ALLOWED_LOGS:
        raise SSHError(f"Invalid log: {log_name}")
    if not isinstance(lines, int) or not 1 <= lines <= 500:
        raise SSHError(f"Invalid lines: {lines}")
    res = _exec(f"tail -n {lines} {LOGS_DIR}/{log_name}.log")
    if not res.ok and not res.stdout:
        raise SSHError(f"tail failed: {res.stderr}")
    return res.stdout


def read_config() -> dict:
    res = _exec(f"cat {CONFIG_PATH}")
    if not res.ok:
        raise SSHError(f"cat config failed: {res.stderr}")
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError as exc:
        raise SSHError(f"Invalid JSON in config.json: {exc}") from exc


def write_config(config: dict) -> None:
    """Write config.json via SFTP (no shell redirect)."""
    _validate_config(config)
    payload = json.dumps(config, indent=4, ensure_ascii=False)
    client = _client()
    try:
        sftp = client.open_sftp()
        try:
            with sftp.file(CONFIG_PATH, "w") as fh:
                fh.write(payload)
        finally:
            sftp.close()
    finally:
        client.close()


def list_scripts() -> list[str]:
    res = _exec(f"ls {SCRIPTS_DIR}/*.py")
    if not res.ok:
        raise SSHError(f"ls failed: {res.stderr}")
    names = []
    for line in res.stdout.strip().splitlines():
        name = line.rsplit("/", 1)[-1]
        if _SCRIPT_NAME_RE.match(name):
            names.append(name)
    return sorted(names)


def read_script(script_name: str) -> str:
    if not _SCRIPT_NAME_RE.match(script_name):
        raise SSHError(f"Invalid script name: {script_name}")
    if script_name not in list_scripts():
        raise SSHError(f"Script not in whitelist: {script_name}")
    res = _exec(f"cat {SCRIPTS_DIR}/{script_name}")
    if not res.ok:
        raise SSHError(f"cat failed: {res.stderr}")
    return res.stdout


def write_script(script_name: str, content: str) -> None:
    if not _SCRIPT_NAME_RE.match(script_name):
        raise SSHError(f"Invalid script name: {script_name}")
    if script_name not in list_scripts():
        raise SSHError(f"Script not in whitelist: {script_name}")
    client = _client()
    try:
        sftp = client.open_sftp()
        try:
            with sftp.file(f"{SCRIPTS_DIR}/{script_name}", "w") as fh:
                fh.write(content)
        finally:
            sftp.close()
    finally:
        client.close()


# --- Validation ---------------------------------------------------------------
def _validate_config(cfg: dict) -> None:
    if not isinstance(cfg, dict):
        raise SSHError("config must be an object")

    params = cfg.get("params")
    if not isinstance(params, list):
        raise SSHError("params must be a list")
    for p in params:
        # historical format: space-separated string of modules
        if not isinstance(p, str):
            raise SSHError("params items must be strings")
        for mod in p.split():
            if mod not in ALLOWED_MODULES:
                raise SSHError(f"Unknown module in params: {mod}")

    for key in ("tep_vent_low_temp", "tep_vent_high_temp", "vetrak_low_temp",
                "kapkova_zavlaha_min_temp"):
        if key in cfg and not isinstance(cfg[key], (int, float)):
            raise SSHError(f"{key} must be number")

    zones = cfg.get("kapkova_zavlaha_zones", [])
    if not isinstance(zones, list):
        raise SSHError("kapkova_zavlaha_zones must be a list")
    for z in zones:
        if not isinstance(z, dict):
            raise SSHError("zone must be object")
        if z.get("name") not in ALLOWED_ZONES:
            raise SSHError(f"Invalid zone name: {z.get('name')}")
        if not isinstance(z.get("pin"), int):
            raise SSHError("zone.pin must be int")
        dur = z.get("duration")
        if not isinstance(dur, int) or not DURATION_MIN <= dur <= DURATION_MAX:
            raise SSHError(f"zone.duration out of range: {dur}")
        zone_hours = z.get("hodiny", [])
        if not isinstance(zone_hours, list):
            raise SSHError(f"zone.hodiny must be a list (zone: {z.get('name')})")
        for h in zone_hours:
            if not isinstance(h, int) or not 0 <= h <= 23:
                raise SSHError(f"Invalid hour in zone {z.get('name')}: {h}")

    sensors = cfg.get("vlhkost_pudy_senzory", [])
    if not isinstance(sensors, list):
        raise SSHError("vlhkost_pudy_senzory must be a list")
    allowed_ports = {"A0", "A1", "A2", "A3"}
    for s in sensors:
        if not isinstance(s, dict):
            raise SSHError("sensor must be object")
        if s.get("port") not in allowed_ports:
            raise SSHError(f"Invalid sensor port: {s.get('port')}")
        table = s.get("table", "")
        if not isinstance(table, str):
            raise SSHError("sensor.table must be string")
        if table and not re.match(r"^vlhkost_pudy_[a-z0-9_]+$", table):
            raise SSHError(f"Invalid sensor.table name: {table}")
        if not isinstance(s.get("enabled", False), bool):
            raise SSHError("sensor.enabled must be bool")
