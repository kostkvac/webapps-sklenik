# Sklenik – webová aplikace pro řízení skleníku

Webové UI pro vzdálené řízení Raspberry Pi (`sklenik` @ 192.168.0.122) přes SSH.
Data se čtou přímo z MariaDB `sklenik` na `dsm.local`.

## Struktura
- `backend/` – FastAPI (port 8005), paramiko SSH, SQLAlchemy
- `frontend/` – Vanilla JS + Chart.js
- `nginx_sklenik.local.conf` – nginx konfigurace
- `sklenik-backend.service` – systemd unit
- `DB_objects/Tables/` – referenční SQL schéma

## Funkce
- **Dashboard** – aktuální teploty/vlhkost/průtok, stav monitoringu, log ventilátoru
- **Ruční závlaha** – `kapkova_a` / `kapkova_b` / obě
- **Konfigurace** – read/write `/usr/local/bin/config.json` (přes SFTP)
- **Monitoring** – start/stop/restart + tail logů
- **Grafy** – historická data z DB
- **Editor skriptů** – read/write `.py` na Pi (whitelist)

## Aktivace

```bash
ln -sf /opt/webapps/sklenik/nginx_sklenik.local.conf /etc/nginx/sites-enabled/
ln -sf /opt/webapps/sklenik/sklenik-backend.service /etc/systemd/system/
nginx -t && systemctl reload nginx
systemctl daemon-reload
systemctl enable --now sklenik-backend.service
```

## Bezpečnost
- SSH příkazy přes whitelist v `app/services/ssh_service.py`
- Validace `zone ∈ {kapkova_a, kapkova_b}`, `duration ∈ [10,600]`, `log_name ∈ ALLOWED_LOGS`
- Zápis souborů přes SFTP (paramiko), nikoli shell redirect
- Hesla a klíče v `.env`
