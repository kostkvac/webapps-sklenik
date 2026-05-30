-- =====================================================================
-- Migrace: profily závlahy + plánovač + kalendář + weather cache
-- Datum: 2026-05-30
-- Idempotentní (lze pustit opakovaně).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Rozšíření kapkova_zavlaha_log o duration_s + note (zachová stávající data)
-- ---------------------------------------------------------------------
ALTER TABLE kapkova_zavlaha_log
    ADD COLUMN IF NOT EXISTS duration_s INT NULL AFTER stop_time,
    ADD COLUMN IF NOT EXISTS note VARCHAR(255) NULL AFTER source,
    ADD INDEX IF NOT EXISTS idx_start_time (start_time),
    ADD INDEX IF NOT EXISTS idx_zone (zone);


-- ---------------------------------------------------------------------
-- 2) Profil závlahy (šablona: víc kroků zóna+duration běží atomicky po sobě)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zavlaha_profil (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL UNIQUE,
    note        VARCHAR(255) NULL,
    is_default  TINYINT(1)   NOT NULL DEFAULT 0,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 3) Krok profilu (zóna + doba otevření v sekundách)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zavlaha_profil_krok (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    profil_id   INT NOT NULL,
    krok_order  INT NOT NULL,
    zone        VARCHAR(32) NOT NULL,
    duration_s  INT NOT NULL,
    UNIQUE KEY uniq_profil_order (profil_id, krok_order),
    INDEX idx_profil (profil_id),
    CONSTRAINT fk_krok_profil FOREIGN KEY (profil_id) REFERENCES zavlaha_profil(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 4) Plánovač – cron-based schedule (profil nebo single-zone duration)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(64)  NOT NULL,
    cron_expr       VARCHAR(64)  NOT NULL,
    plan_kind       VARCHAR(16)  NOT NULL DEFAULT 'cron',  -- cron | recurring
    -- Buď profil_id, nebo zone+duration_s
    profil_id       INT NULL,
    zone            VARCHAR(32) NULL,
    duration_s      INT NULL,
    -- Skip podmínky
    skip_if_rain    TINYINT(1)  NOT NULL DEFAULT 1,
    min_temp_c      DECIMAL(4,1) NULL,
    enabled         TINYINT(1)  NOT NULL DEFAULT 1,
    -- Plánovací rámec
    start_date      DATE NULL,
    end_date        DATE NULL,
    max_runs        INT  NULL,
    runs_count      INT  NOT NULL DEFAULT 0,
    -- Stav
    last_run_at     DATETIME NULL,
    last_status     VARCHAR(64) NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_enabled (enabled),
    CONSTRAINT fk_schedule_profil FOREIGN KEY (profil_id) REFERENCES zavlaha_profil(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 5) Kalendářové výjimky (skip / add jednorázový běh)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zavlaha_kalendar_override (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    run_date        DATE NOT NULL,
    run_time        TIME NULL,
    action          ENUM('skip','add') NOT NULL,
    schedule_id     INT NULL,
    profil_id       INT NULL,
    zone            VARCHAR(32) NULL,
    duration_s      INT NULL,
    skip_if_rain    TINYINT(1) NOT NULL DEFAULT 1,
    min_temp_c      DECIMAL(4,1) NULL,
    note            VARCHAR(255) NULL,
    status          VARCHAR(32) NULL,
    executed_at     DATETIME NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_run_date (run_date),
    INDEX idx_action (action),
    CONSTRAINT fk_ov_schedule FOREIGN KEY (schedule_id) REFERENCES schedule(id) ON DELETE CASCADE,
    CONSTRAINT fk_ov_profil   FOREIGN KEY (profil_id)   REFERENCES zavlaha_profil(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 6) Weather cache (lokální cache surové odpovědi z trávník proxy)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weather_cache (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    fetched_at  DATETIME NOT NULL,
    raw_json    LONGTEXT NOT NULL,
    INDEX idx_fetched (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
