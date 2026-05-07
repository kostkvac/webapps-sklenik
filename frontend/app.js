// Sklenik frontend – vanilla JS

const API = "/api";

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("cs-CZ");
}

function ageMinutes(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const id = "tab-" + btn.dataset.tab;
    document.getElementById(id).classList.add("active");
    onTabChange(btn.dataset.tab);
  });
});

function onTabChange(name) {
  if (name === "config") loadConfig();
  if (name === "monitoring") { loadAvailableLogs(); refreshMonitoring(); }
  if (name === "grafy") populateChartTables();
  if (name === "scripts") loadScriptList();
  if (name === "dashboard") refreshDashboard();
}

// ---------- API status ----------
async function checkApi() {
  const pill = document.getElementById("api-status");
  try {
    const j = await api("/health");
    pill.textContent = "API: " + j.status;
    pill.className = "status-pill ok";
  } catch (e) {
    pill.textContent = "API: chyba";
    pill.className = "status-pill error";
  }
}

// ---------- Dashboard ----------
const SENSOR_LABELS = {
  teplota_dolni: "Teplota dolní (°C)",
  teplota_horni: "Teplota horní (°C)",
  teplota_venkovni: "Teplota venkovní (°C)",
  vlhkost_pudy_sadba: "Vlhkost půdy – sadba (%)",
  prutok: "Průtok (l/min)",
};

async function refreshDashboard() {
  try {
    const data = await api("/dashboard/latest");
    const cards = document.getElementById("latest-cards");
    const items = [];
    for (const [k, v] of Object.entries(data.teploty)) items.push([k, v]);
    for (const [k, v] of Object.entries(data.vlhkost)) items.push([k, v]);
    items.push(["prutok", data.prutok]);
    cards.innerHTML = items.map(([key, rec]) => renderCard(key, rec)).join("");
  } catch (e) {
    document.getElementById("latest-cards").textContent = "Chyba: " + e.message;
  }
  refreshMonitoringPill();
  loadVentilatorLog();
}

function renderCard(key, rec) {
  if (!rec || rec.value === null) {
    return `<div class="card empty"><div class="label">${SENSOR_LABELS[key] || key}</div>
              <div class="value">—</div><div class="ts">žádná data</div></div>`;
  }
  const stale = ageMinutes(rec.timestamp) > 30;
  return `<div class="card${stale ? " stale" : ""}">
            <div class="label">${SENSOR_LABELS[key] || key}</div>
            <div class="value">${Number(rec.value).toFixed(1)}</div>
            <div class="ts">${fmtTs(rec.timestamp)}</div>
          </div>`;
}

async function refreshMonitoringPill() {
  const pill = document.getElementById("monitoring-pill");
  try {
    const j = await api("/dashboard/monitoring-status");
    if (j.running) {
      pill.textContent = "Běží (PID: " + j.pids.join(", ") + ")";
      pill.className = "status-pill ok";
    } else {
      pill.textContent = "Neběží";
      pill.className = "status-pill warn";
    }
  } catch (e) {
    pill.textContent = "SSH chyba: " + e.message;
    pill.className = "status-pill error";
  }
}

async function loadVentilatorLog() {
  try {
    const j = await api("/dashboard/ventilator-log?limit=20");
    const tbody = document.querySelector("#vent-table tbody");
    tbody.innerHTML = j.rows.map(r => `<tr>
      <td>${fmtTs(r.start)}</td><td>${fmtTs(r.stop)}</td>
      <td>${r.duration_s ?? "—"}</td></tr>`).join("");
  } catch (e) { /* ignore */ }
}

// ---------- Zavlaha ----------
document.getElementById("zavlaha-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const zone = fd.get("zone");
  const duration = parseInt(fd.get("duration"));
  const out = document.getElementById("zavlaha-output");
  out.textContent = "Spouštím…";
  const submit = e.target.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    if (zone === "both") {
      const r1 = await api("/ssh/zavlaha", {
        method: "POST", body: JSON.stringify({ zone: "kapkova_a", duration }),
      });
      const r2 = await api("/ssh/zavlaha", {
        method: "POST", body: JSON.stringify({ zone: "kapkova_b", duration }),
      });
      out.textContent = "=== kapkova_a ===\n" + (r1.stdout || "") + (r1.stderr || "")
        + "\n\n=== kapkova_b ===\n" + (r2.stdout || "") + (r2.stderr || "");
    } else {
      const r = await api("/ssh/zavlaha", {
        method: "POST", body: JSON.stringify({ zone, duration }),
      });
      out.textContent = (r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "");
    }
  } catch (err) {
    out.textContent = "Chyba: " + err.message;
  } finally {
    submit.disabled = false;
  }
});

// ---------- Config ----------
let currentConfig = null;

async function loadConfig() {
  const status = document.getElementById("config-status");
  status.textContent = "Načítám…";
  try {
    const j = await api("/config");
    currentConfig = j.config;
    fillConfigForm(currentConfig);
    status.textContent = "OK";
  } catch (e) {
    status.textContent = "Chyba: " + e.message;
  }
}

function fillConfigForm(cfg) {
  const form = document.getElementById("config-form");
  for (const key of ["tep_vent_low_temp", "tep_vent_high_temp", "vetrak_low_temp", "kapkova_zavlaha_min_temp"]) {
    if (form[key]) form[key].value = cfg[key] ?? "";
  }
  const params = (cfg.params || []).join(" ").split(/\s+/);
  form.mod_teplota.checked = params.includes("teplota");
  form.mod_vlhkost_pudy.checked = params.includes("vlhkost_pudy");
  form.mod_prutok.checked = params.includes("prutok");
  form.mod_tepelny_ventilator.checked = params.includes("tepelny_ventilator");
  form.mod_vetrak.checked = params.includes("vetrak");
  form.mod_kapkova_zavlaha.checked = params.includes("kapkova_zavlaha");

  form.hodiny.value = (cfg.kapkova_zavlaha_hodiny || []).join(",");

  const zonesDiv = document.getElementById("zones-editor");
  zonesDiv.innerHTML = (cfg.kapkova_zavlaha_zones || []).map((z, i) => `
    <div class="zone-row" data-i="${i}">
      <span class="name">${z.name}</span>
      pin: <input type="number" data-k="pin" value="${z.pin}">
      duration: <input type="number" data-k="duration" min="10" max="600" value="${z.duration}">
    </div>`).join("");

  const sensorsDiv = document.getElementById("sensors-editor");
  const existing = cfg.vlhkost_pudy_senzory || [];
  const sensors = ["A0", "A1", "A2", "A3"].map(p =>
    existing.find(s => s.port === p) || { port: p, table: "", nazev: "", enabled: false }
  );
  sensorsDiv.innerHTML = sensors.map(s => `
    <div class="sensor-row" data-port="${s.port}">
      <span class="port">${s.port}</span>
      <label><input type="checkbox" data-k="enabled" ${s.enabled ? "checked" : ""}> aktivní</label>
      tabulka: <input type="text" data-k="table" placeholder="vlhkost_pudy_*" value="${s.table || ""}">
      název: <input type="text" data-k="nazev" placeholder="popis (volitelné)" value="${s.nazev || ""}">
    </div>`).join("");
}

document.getElementById("config-reload").addEventListener("click", loadConfig);

document.getElementById("config-save").addEventListener("click", async () => {
  if (!currentConfig) { alert("Nejprve načti konfiguraci."); return; }
  const status = document.getElementById("config-status");
  const form = document.getElementById("config-form");

  const newCfg = { ...currentConfig };
  for (const key of ["tep_vent_low_temp", "tep_vent_high_temp", "vetrak_low_temp", "kapkova_zavlaha_min_temp"]) {
    const v = form[key].value;
    if (v !== "") newCfg[key] = parseFloat(v);
  }
  // params – use single space-separated string for backward compatibility
  const mods = [];
  if (form.mod_teplota.checked) mods.push("teplota");
  if (form.mod_vlhkost_pudy.checked) mods.push("vlhkost_pudy");
  if (form.mod_prutok.checked) mods.push("prutok");
  if (form.mod_tepelny_ventilator.checked) mods.push("tepelny_ventilator");
  if (form.mod_vetrak.checked) mods.push("vetrak");
  if (form.mod_kapkova_zavlaha.checked) mods.push("kapkova_zavlaha");
  newCfg.params = [mods.join(" ")];

  newCfg.kapkova_zavlaha_hodiny = form.hodiny.value
    .split(",").map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n));

  newCfg.kapkova_zavlaha_zones = Array.from(document.querySelectorAll("#zones-editor .zone-row")).map((row, i) => {
    const z = { ...currentConfig.kapkova_zavlaha_zones[i] };
    z.pin = parseInt(row.querySelector('[data-k=pin]').value);
    z.duration = parseInt(row.querySelector('[data-k=duration]').value);
    return z;
  });

  newCfg.vlhkost_pudy_senzory = Array.from(document.querySelectorAll("#sensors-editor .sensor-row")).map(row => ({
    port: row.dataset.port,
    enabled: row.querySelector('[data-k=enabled]').checked,
    table: row.querySelector('[data-k=table]').value.trim(),
    nazev: row.querySelector('[data-k=nazev]').value.trim(),
  }));

  status.textContent = "Ukládám…";
  try {
    await api("/config", { method: "PUT", body: JSON.stringify({ config: newCfg }) });
    status.textContent = "Uloženo";
    currentConfig = newCfg;
    if (confirm("Konfigurace uložena. Restartovat monitoring nyní?")) {
      const r = await api("/ssh/monitoring", { method: "POST", body: JSON.stringify({ action: "restart" }) });
      alert("Monitoring restart:\n" + (r.stdout || "") + (r.stderr || ""));
    }
  } catch (e) {
    status.textContent = "Chyba: " + e.message;
  }
});

// ---------- Monitoring ----------
document.querySelectorAll("#tab-monitoring .btn-row button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const out = document.getElementById("monitoring-output");
    out.textContent = "…";
    try {
      const r = await api("/ssh/monitoring", {
        method: "POST", body: JSON.stringify({ action: btn.dataset.action }),
      });
      out.textContent = (r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "")
        + `\n[exit ${r.exit_code}]`;
      refreshMonitoring();
    } catch (e) {
      out.textContent = "Chyba: " + e.message;
    }
  });
});

async function loadAvailableLogs() {
  try {
    const j = await api("/logs/available");
    const sel = document.getElementById("log-select");
    sel.innerHTML = j.logs.map(l => `<option>${l}</option>`).join("");
  } catch {}
}

document.getElementById("log-load").addEventListener("click", async () => {
  const log = document.getElementById("log-select").value;
  const lines = parseInt(document.getElementById("log-lines").value) || 50;
  const out = document.getElementById("log-output");
  out.textContent = "…";
  try {
    const j = await api(`/logs/${encodeURIComponent(log)}?lines=${lines}`);
    out.textContent = j.content || "(prázdný log)";
  } catch (e) {
    out.textContent = "Chyba: " + e.message;
  }
});

async function refreshMonitoring() {
  try {
    const j = await api("/dashboard/monitoring-status");
    document.getElementById("monitoring-output").textContent =
      j.running ? "Monitoring běží, PIDy: " + j.pids.join(", ") : "Monitoring NEBĚŽÍ";
  } catch (e) {
    document.getElementById("monitoring-output").textContent = "SSH: " + e.message;
  }
}

// ---------- Grafy ----------
const CHART_TABLES = [
  "teplota_dolni", "teplota_horni", "teplota_venkovni",
  "vlhkost_pudy_sadba", "vlhkost_pudy_zahon", "prutok",
];
let chartInstance = null;
let tempChartInstance = null;

// --- Přehled teplot + prahy ---
document.getElementById("temp-load").addEventListener("click", () => {
  const hours = parseInt(document.getElementById("temp-hours").value) || 24;
  drawTempOverview(hours);
});

async function drawTempOverview(hours) {
  const btn = document.getElementById("temp-load");
  btn.disabled = true;
  btn.textContent = "Načítám…";
  try {
    const [d, h, v, cfgResp] = await Promise.all([
      api(`/dashboard/history?table=teplota_dolni&hours=${hours}`),
      api(`/dashboard/history?table=teplota_horni&hours=${hours}`),
      api(`/dashboard/history?table=teplota_venkovni&hours=${hours}`),
      api("/config"),
    ]);
    const cfg = cfgResp.config;
    const labels = d.points.map(p => fmtTs(p.t));
    const n = labels.length;

    const threshold = (label, value, color) => ({
      label: `${label} (${value}°C)`,
      data: Array(n).fill(value),
      borderColor: color,
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0,
      order: 10,
    });

    const datasets = [
      { label: "Dolní", data: d.points.map(p => p.v), borderColor: "#e63946", backgroundColor: "rgba(230,57,70,0.08)", fill: false, tension: 0.2, pointRadius: 0 },
      { label: "Horní", data: h.points.map(p => p.v), borderColor: "#ff9f1c", fill: false, tension: 0.2, pointRadius: 0 },
      { label: "Venkovní", data: v.points.map(p => p.v), borderColor: "#457b9d", fill: false, tension: 0.2, pointRadius: 0 },
      threshold("Tep.vent. zapnout pod", cfg.tep_vent_low_temp, "#52b788"),
      threshold("Tep.vent. vypnout nad", cfg.tep_vent_high_temp, "#1d3557"),
      threshold("Větrák zapnout nad", cfg.vetrak_low_temp, "#e9c46a"),
    ];

    const ctx = document.getElementById("temp-canvas").getContext("2d");
    if (tempChartInstance) tempChartInstance.destroy();
    tempChartInstance = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 10 } },
          y: { title: { display: true, text: "°C" } },
        },
        plugins: {
          legend: { position: "bottom" },
        },
      },
    });
  } catch (e) {
    alert("Chyba: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Vykreslit";
  }
}

function populateChartTables() {
  const sel = document.getElementById("chart-table");
  if (sel.options.length === 0) {
    sel.innerHTML = CHART_TABLES.map(t => `<option>${t}</option>`).join("");
  }
}

document.getElementById("chart-load").addEventListener("click", async () => {
  const table = document.getElementById("chart-table").value;
  const hours = parseInt(document.getElementById("chart-hours").value) || 24;
  try {
    const j = await api(`/dashboard/history?table=${encodeURIComponent(table)}&hours=${hours}`);
    drawChart(table, j.points);
  } catch (e) {
    alert("Chyba: " + e.message);
  }
});

function drawChart(table, points) {
  const ctx = document.getElementById("chart-canvas").getContext("2d");
  const labels = points.map(p => fmtTs(p.t));
  const values = points.map(p => p.v);
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: table, data: values, borderColor: "#2d6a4f",
      backgroundColor: "rgba(45,106,79,0.1)", fill: true, tension: 0.2, pointRadius: 0 }] },
    options: { responsive: true, scales: { x: { ticks: { maxTicksLimit: 10 } } } },
  });
}

// ---------- Scripts ----------
async function loadScriptList() {
  try {
    const j = await api("/scripts");
    const sel = document.getElementById("script-select");
    if (sel.options.length === 0 || sel.options.length !== j.scripts.length) {
      sel.innerHTML = j.scripts.map(s => `<option>${s}</option>`).join("");
    }
  } catch (e) {
    document.getElementById("script-status").textContent = "Chyba: " + e.message;
  }
}

document.getElementById("script-load").addEventListener("click", async () => {
  const name = document.getElementById("script-select").value;
  const status = document.getElementById("script-status");
  status.textContent = "Načítám…";
  try {
    const j = await api(`/scripts/${encodeURIComponent(name)}`);
    document.getElementById("script-editor").value = j.content;
    status.textContent = "OK";
  } catch (e) {
    status.textContent = "Chyba: " + e.message;
  }
});

document.getElementById("script-save").addEventListener("click", async () => {
  const name = document.getElementById("script-select").value;
  const content = document.getElementById("script-editor").value;
  const status = document.getElementById("script-status");
  if (!confirm(`Opravdu uložit ${name}?`)) return;
  status.textContent = "Ukládám…";
  try {
    await api(`/scripts/${encodeURIComponent(name)}`, {
      method: "PUT", body: JSON.stringify({ content }),
    });
    status.textContent = "Uloženo";
  } catch (e) {
    status.textContent = "Chyba: " + e.message;
  }
});

// ---------- init ----------
checkApi();
refreshDashboard();
setInterval(refreshDashboard, 30000);
setInterval(checkApi, 60000);
