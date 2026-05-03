-- Schema reference for db `sklenik` on dsm.local
-- Tables already exist on the Pi side; this file documents structure used by the webapp.

-- Active sensor tables (used by dashboard / charts)
CREATE TABLE IF NOT EXISTS teplota_dolni (
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
    teplota   DECIMAL(3,1) NULL
);

CREATE TABLE IF NOT EXISTS teplota_horni (
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
    teplota   DECIMAL(3,1) NULL
);

CREATE TABLE IF NOT EXISTS teplota_venkovni (
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
    teplota   DECIMAL(3,1) NULL
);

CREATE TABLE IF NOT EXISTS vlhkost_pudy_sadba (
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
    vlhkost   DECIMAL(4,1) NULL
);

CREATE TABLE IF NOT EXISTS prutok (
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP PRIMARY KEY,
    prutok    DECIMAL(3,1) NULL
);

CREATE TABLE IF NOT EXISTS ventilator_log (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    start_time  DATETIME NOT NULL,
    stop_time   DATETIME NULL,
    duration_seconds INT GENERATED ALWAYS AS (TIMESTAMPDIFF(SECOND, start_time, stop_time)) STORED,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
