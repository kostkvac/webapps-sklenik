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
  if (name === "config")   { loadConfig(); loadProfilesTable(); }
  if (name === "zavlaha")  { refreshProfilePickers(); }
  if (name === "planovac") { loadSchedules(); refreshProfilePickers(); }
  if (name === "kalendar") loadCalendar();
  if (name === "meteo") loadMeteo(false);
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
  const hours = parseInt(document.getElementById("activity-hours")?.value || "48");
  loadActivity(hours);
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

const ACTIVITY_ICONS = {
  tepelny_ventilator: { icon: "🔥", cls: "act-tepelny" },
  vetrak:             { icon: "💨", cls: "act-vetrak" },
  kapkova_zavlaha:    { icon: "💧", cls: "act-zavlaha" },
};

function fmtDur(s) {
  if (s == null) return "—";
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}

async function loadActivity(hours) {
  const feed = document.getElementById("activity-feed");
  try {
    const j = await api(`/dashboard/activity?hours=${hours}`);
    if (!j.events.length) { feed.innerHTML = "<p style='color:#888'>Žádné události.</p>"; return; }
    feed.innerHTML = j.events.map(ev => {
      const meta = ACTIVITY_ICONS[ev.type] || { icon: "📌", cls: "" };
      const start = fmtTs(ev.start);
      const stop  = ev.stop ? fmtTs(ev.stop) : "probíhá…";
      const dur   = fmtDur(ev.duration_s);
      const badge = ev.source === "manual"
        ? `<span class="act-badge act-manual">ruční</span>`
        : ev.source === "scheduled"
          ? `<span class="act-badge act-sched">auto</span>`
          : "";
      return `<div class="act-row ${meta.cls}">
        <span class="act-icon">${meta.icon}</span>
        <div class="act-body">
          <span class="act-label">${ev.label}</span>${badge}
          <span class="act-time">${start} → ${stop} <em>(${dur})</em></span>
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    feed.innerHTML = `<p style='color:#c00'>Chyba: ${e.message}</p>`;
  }
}

// ---------- Zavlaha ----------
let _zavlahaPoller = null;

function startZavlahaPolling(out, submit) {
  if (_zavlahaPoller) clearInterval(_zavlahaPoller);
  _zavlahaPoller = setInterval(async () => {
    try {
      const s = await api("/ssh/zavlaha/running");
      if (!s.running) {
        clearInterval(_zavlahaPoller);
        _zavlahaPoller = null;
        out.textContent += "\n✓ Dokončeno.";
        submit.disabled = false;
      }
    } catch {
      clearInterval(_zavlahaPoller);
      _zavlahaPoller = null;
      submit.disabled = false;
    }
  }, 3000);
}

document.getElementById("zavlaha-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const zone = fd.get("zone");
  const duration = parseInt(fd.get("duration"));
  const out = document.getElementById("zavlaha-output");
  const submit = e.target.querySelector("button[type=submit]");
  out.textContent = "Spouštím…";
  submit.disabled = true;
  try {
    await api("/ssh/zavlaha", {
      method: "POST", body: JSON.stringify({ zone, duration }),
    });
    const label = zone === "both" ? "kapkova_a + kapkova_b" : zone;
    out.textContent = `Závlaha spuštěna (${label}, ${duration}s).\nČekám na dokončení…`;
    startZavlahaPolling(out, submit);
  } catch (err) {
    out.textContent = "Chyba: " + err.message;
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

  form.hodiny_placeholder = null; // removed – hodiny are per zone

  const zonesDiv = document.getElementById("zones-editor");
  zonesDiv.innerHTML = (cfg.kapkova_zavlaha_zones || []).map((z, i) => `
    <div class="zone-row" data-i="${i}">
      <span class="name">${z.name}</span>
      <label>pin <input type="number" data-k="pin" value="${z.pin}"></label>
      <label>duration (s) <input type="number" data-k="duration" min="10" max="600" value="${z.duration}"></label>
      <label>hodiny <input type="text" data-k="hodiny" placeholder="8,20" value="${(z.hodiny || []).join(",")}" style="width:12em"></label>
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

  delete newCfg.kapkova_zavlaha_hodiny; // přesunuto do per-zóna hodiny

  newCfg.kapkova_zavlaha_zones = Array.from(document.querySelectorAll("#zones-editor .zone-row")).map((row, i) => {
    const z = { ...currentConfig.kapkova_zavlaha_zones[i] };
    z.pin = parseInt(row.querySelector('[data-k=pin]').value);
    z.duration = parseInt(row.querySelector('[data-k=duration]').value);
    z.hodiny = row.querySelector('[data-k=hodiny]').value
      .split(",").map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n) && n >= 0 && n <= 23);
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

document.getElementById("activity-hours")?.addEventListener("change", (e) => {
  loadActivity(parseInt(e.target.value));
});

// ============================================================
// Profily závlahy (zavlaha_profil)
// ============================================================
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function fmtZone(z) {
  if (z === "kapkova_a") return "větev A";
  if (z === "kapkova_b") return "větev B";
  if (z === "both") return "obě";
  return z || "—";
}
function fmtDur(s) {
  if (s == null) return "—";
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

let _profiles = [];

async function fetchProfiles() {
  try {
    const j = await api("/profiles");
    _profiles = j.profiles || [];
  } catch (e) {
    console.warn("profiles load failed:", e.message);
    _profiles = [];
  }
  return _profiles;
}

function populateProfileSelect(sel, selectedId = "", placeholder = "— vyber profil —") {
  if (!sel) return;
  const opts = [`<option value="">${placeholder}</option>`]
    .concat(_profiles.map(p =>
      `<option value="${p.id}">${escapeHtml(p.name)} (${p.steps.length} kroků)${p.is_default ? " ★" : ""}</option>`));
  sel.innerHTML = opts.join("");
  sel.value = selectedId || "";
}

async function refreshProfilePickers() {
  await fetchProfiles();
  populateProfileSelect(document.getElementById("seq-run-select"),
    (_profiles.find(p => p.is_default)?.id || ""), "— vyber profil —");
  populateProfileSelect(document.getElementById("sched-sekvence"),
    "", "— jednoduchý běh (1 větev) —");
}

async function loadProfilesTable() {
  await fetchProfiles();
  const tbody = document.querySelector("#seq-table tbody");
  if (!tbody) return;
  if (!_profiles.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:#888">Žádné profily.</td></tr>';
    return;
  }
  tbody.innerHTML = _profiles.map(p => {
    const steps = p.steps.map(k => `${fmtZone(k.zone)} ${fmtDur(k.duration_s)}`).join(" → ");
    return `<tr>
      <td><b>${escapeHtml(p.name)}</b></td>
      <td>${escapeHtml(steps)}</td>
      <td>${escapeHtml(p.note || "")}</td>
      <td>${p.is_default ? "★" : ""}</td>
      <td>
        <button data-act="edit" data-id="${p.id}">Upravit</button>
        <button data-act="del" data-id="${p.id}" class="danger">Smazat</button>
      </td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      const id = Number(b.dataset.id);
      if (b.dataset.act === "edit") showSeqForm(_profiles.find(p => p.id === id));
      else if (b.dataset.act === "del") deleteProfile(id);
    });
  });
}

function renderStepRow(step = {}) {
  const z = step.zone || "kapkova_a";
  return `<div class="seq-step">
    <select data-f="zone">
      <option value="kapkova_a"${z==="kapkova_a"?" selected":""}>větev A</option>
      <option value="kapkova_b"${z==="kapkova_b"?" selected":""}>větev B</option>
      <option value="both"${z==="both"?" selected":""}>obě</option>
    </select>
    <input type="number" data-f="duration_s" min="1" max="3600" value="${step.duration_s ?? 60}" placeholder="sekund">
    <button type="button" class="danger" data-act="rm-step">×</button>
  </div>`;
}

function showSeqForm(data) {
  const wrap = document.getElementById("seq-form-wrap");
  const f = document.getElementById("seq-form");
  document.getElementById("seq-form-title").textContent = data?.id ? "Upravit profil" : "Nový profil";
  f.id.value = data?.id || "";
  f.name.value = data?.name || "";
  f.note.value = data?.note || "";
  f.is_default.checked = !!data?.is_default;
  const steps = data?.steps?.length ? data.steps : [{}];
  document.getElementById("seq-steps").innerHTML = steps.map(renderStepRow).join("");
  wrap.style.display = "";
  wireStepRemove();
}

function wireStepRemove() {
  document.querySelectorAll("#seq-steps button[data-act='rm-step']").forEach(b => {
    b.onclick = () => {
      if (document.querySelectorAll("#seq-steps .seq-step").length > 1) {
        b.closest(".seq-step").remove();
      } else {
        alert("Profil musí mít aspoň 1 krok.");
      }
    };
  });
}

document.getElementById("seq-new")?.addEventListener("click", () => showSeqForm(null));
document.getElementById("seq-reload")?.addEventListener("click", () => {
  loadProfilesTable(); refreshProfilePickers();
});
document.getElementById("seq-cancel")?.addEventListener("click", () => {
  document.getElementById("seq-form-wrap").style.display = "none";
});
document.getElementById("seq-add-step")?.addEventListener("click", () => {
  document.getElementById("seq-steps").insertAdjacentHTML("beforeend", renderStepRow());
  wireStepRemove();
});

document.getElementById("seq-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const steps = Array.from(document.querySelectorAll("#seq-steps .seq-step")).map(row => ({
    zone: row.querySelector("[data-f='zone']").value,
    duration_s: Number(row.querySelector("[data-f='duration_s']").value),
  }));
  const payload = {
    name: f.name.value.trim(),
    note: f.note.value || null,
    is_default: f.is_default.checked,
    steps,
  };
  try {
    if (f.id.value) {
      await api("/profiles/" + f.id.value, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/profiles", { method: "POST", body: JSON.stringify(payload) });
    }
    document.getElementById("seq-form-wrap").style.display = "none";
    await loadProfilesTable();
    await refreshProfilePickers();
  } catch (err) { alert("Chyba: " + err.message); }
});

async function deleteProfile(id) {
  if (!confirm("Smazat profil?")) return;
  try {
    await api("/profiles/" + id, { method: "DELETE" });
    await loadProfilesTable();
    await refreshProfilePickers();
  } catch (e) { alert("Chyba: " + e.message); }
}

// --- ruční spuštění profilu v záložce Závlaha ---
document.getElementById("seq-run-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = document.getElementById("seq-run-output");
  const sel = document.getElementById("seq-run-select");
  if (!sel.value) { alert("Vyber profil."); return; }
  out.textContent = "Spouštím…";
  try {
    const j = await api(`/profiles/${sel.value}/run`, { method: "POST" });
    out.textContent = `OK – ${j.profile}, ${j.steps} kroků spuštěno.`;
  } catch (err) { out.textContent = "Chyba: " + err.message; }
});


// ============================================================
// Plánovač (schedule)
// ============================================================
function fmtValidity(s) {
  const parts = [];
  if (s.start_date) {
    const sd = new Date(s.start_date + "T00:00:00");
    if (sd > new Date()) parts.push("od " + s.start_date);
  }
  if (s.end_date) {
    const ed = new Date(s.end_date + "T23:59:59");
    const days = Math.ceil((ed - new Date()) / (86400 * 1000));
    if (days < 0) parts.push("<span style='color:#c00'>vypršelo " + s.end_date + "</span>");
    else parts.push("do " + s.end_date + ` <small>(${days}d)</small>`);
  }
  if (s.max_runs) parts.push(`${s.runs_count}/${s.max_runs}× `);
  return parts.length ? parts.join("<br>") : "<small>bez omezení</small>";
}

// Rozpoznání cronu pro recurring UI
function parseCronToRecurring(cron) {
  const p = (cron || "").split(/\s+/);
  if (p.length !== 5) return null;
  const [mF, hF, dom, mon, dowF] = p;
  if (dom !== "*" || mon !== "*") return null;
  const parseList = (s) => {
    if (s === "*") return null;
    if (!/^[\d,]+$/.test(s)) return null;
    return s.split(",").map(Number);
  };
  const mins = parseList(mF);
  const hrs  = parseList(hF);
  if (!mins || !hrs || mins.length !== 1) return null;
  const times = hrs.map(h => `${String(h).padStart(2,"0")}:${String(mins[0]).padStart(2,"0")}`);
  let dow = [], rec_kind = "daily";
  if (dowF === "*") rec_kind = "daily";
  else if (dowF === "1-5") { rec_kind = "weekdays"; dow = [1,2,3,4,5]; }
  else if (dowF === "0,6" || dowF === "6,0") { rec_kind = "weekend"; dow = [0,6]; }
  else if (/^[\d,-]+$/.test(dowF)) {
    rec_kind = "custom";
    dowF.split(",").forEach(part => {
      if (part.includes("-")) {
        const [a,b] = part.split("-").map(Number);
        for (let i=a; i<=b; i++) dow.push(i);
      } else dow.push(Number(part));
    });
  } else return null;
  return { times, dow, rec_kind };
}

function buildCronFromRecurring(times, rec_kind, custom_dow) {
  if (!times || !times.length) return null;
  const mins = new Set(times.map(t => parseInt(t.split(":")[1])));
  if (mins.size > 1) throw new Error("Všechny časy musí mít stejnou minutu.");
  const minute = [...mins][0];
  const hours = [...new Set(times.map(t => parseInt(t.split(":")[0])))].sort((a,b)=>a-b);
  let dow = "*";
  if (rec_kind === "weekdays") dow = "1-5";
  else if (rec_kind === "weekend") dow = "0,6";
  else if (rec_kind === "custom") {
    if (!custom_dow?.length) throw new Error("Vyber alespoň jeden den.");
    dow = [...new Set(custom_dow)].sort((a,b)=>a-b).join(",");
  }
  return `${minute} ${hours.join(",")} * * ${dow}`;
}

async function loadSchedules() {
  try {
    await fetchProfiles();
    const j = await api("/scheduler");
    const profById = Object.fromEntries(_profiles.map(p => [p.id, p]));
    const tbody = document.querySelector("#sched-table tbody");
    if (!j.schedules.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="color:#888">Žádné plány.</td></tr>';
    } else {
      tbody.innerHTML = j.schedules.map(s => {
        const prof = s.profil_id ? profById[s.profil_id] : null;
        const targetCell = prof ? `🔗 ${escapeHtml(prof.name)}` : fmtZone(s.zone);
        const durCell = prof
          ? prof.steps.map(k => `${fmtZone(k.zone)} ${fmtDur(k.duration_s)}`).join(" → ")
          : fmtDur(s.duration_s);
        const planCell = `${escapeHtml(s.cron_human || s.cron_expr)}<br><small><code>${s.cron_expr}</code></small>`;
        return `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${targetCell}</td>
          <td>${planCell}</td>
          <td>${fmtValidity(s)}</td>
          <td>${durCell}</td>
          <td>${s.skip_if_rain ? "ano" : "ne"}</td>
          <td>${s.min_temp_c ?? "—"}</td>
          <td>${s.enabled ? "✓" : "—"}</td>
          <td>${s.last_run_at ? fmtTs(s.last_run_at) + "<br><small>" + (s.last_status||"") + "</small>" : "—"}</td>
          <td>
            <button data-edit="${s.id}">Upravit</button>
            <button class="danger" data-del="${s.id}">Smazat</button>
          </td>
        </tr>`;
      }).join("");
      tbody.querySelectorAll("[data-edit]").forEach(b =>
        b.addEventListener("click", () => showSchedForm(j.schedules.find(x => x.id == b.dataset.edit))));
      tbody.querySelectorAll("[data-del]").forEach(b =>
        b.addEventListener("click", () => deleteSchedule(parseInt(b.dataset.del))));
    }
    const userJobs = (j.active_jobs || []).filter(jb => jb.id.startsWith("sched-"));
    document.getElementById("sched-jobs").textContent =
      userJobs.map(jb => `${jb.id} | next: ${fmtTs(jb.next_run_time)}`).join("\n") || "—";
  } catch (e) {
    alert("Chyba: " + e.message);
  }
}

function applySchedSeqToggle() {
  const seqSel = document.getElementById("sched-sekvence");
  const form = document.getElementById("sched-form");
  if (!seqSel || !form) return;
  const useSeq = !!seqSel.value;
  ["zone", "duration_s"].forEach(n => {
    const el = form.elements[n];
    if (!el) return;
    el.disabled = useSeq;
    const lab = el.closest("label");
    if (lab) lab.style.opacity = useSeq ? "0.4" : "1";
  });
}

function applySchedKindToggle() {
  const kind = document.querySelector('input[name="plan_kind"]:checked')?.value || "recurring";
  document.getElementById("sched-once-block").style.display = (kind === "once") ? "" : "none";
  document.getElementById("sched-recurring-block").style.display = (kind === "recurring") ? "" : "none";
  document.getElementById("sched-cron-block").style.display = (kind === "cron") ? "" : "none";
  if (kind === "once") {
    const dEl = document.getElementById("sched-once-date");
    if (!dEl.value) dEl.value = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  }
}

function addTimeChip(t) {
  const list = document.getElementById("sched-times-list");
  if ([...list.querySelectorAll(".time-chip")].some(c => c.dataset.t === t)) return;
  const span = document.createElement("span");
  span.className = "time-chip";
  span.dataset.t = t;
  span.innerHTML = `${t} <button type="button" class="time-chip-x">×</button>`;
  span.querySelector(".time-chip-x").addEventListener("click", () => { span.remove(); updateSchedPreview(); });
  list.appendChild(span);
  updateSchedPreview();
}
function getSelectedTimes() {
  return [...document.querySelectorAll("#sched-times-list .time-chip")].map(c => c.dataset.t).sort();
}
function getSelectedDow() {
  return [...document.querySelectorAll("#sched-dow-chips .dow:checked")].map(cb => Number(cb.value));
}
function updateSchedPreview() {
  const preview = document.getElementById("sched-preview");
  if (!preview) return;
  try {
    const times = getSelectedTimes();
    if (!times.length) { preview.textContent = "— vyber alespoň jeden čas —"; return; }
    const rec_kind = document.querySelector('input[name="rec_kind"]:checked')?.value || "daily";
    const dow = getSelectedDow();
    const cron = buildCronFromRecurring(times, rec_kind, dow);
    const dowLabel = { daily: "denně", weekdays: "Po–Pá", weekend: "So–Ne",
                       custom: "ve dnech " + dow.sort().map(d => ["Ne","Po","Út","St","Čt","Pá","So"][d]).join(", ") };
    const end = document.querySelector('input[name="end_date"]').value;
    const maxR = document.querySelector('input[name="max_runs"]').value;
    let exp = "";
    if (end) exp = ` · do ${end}`;
    else if (maxR) exp = ` · ${maxR}×`;
    preview.innerHTML = `Náhled: <b>${dowLabel[rec_kind]} v ${times.join(", ")}</b>${exp}<br><small>cron: <code>${cron}</code></small>`;
  } catch (e) {
    preview.innerHTML = `<span style="color:#c00">${e.message}</span>`;
  }
}

function showSchedForm(data) {
  const wrap = document.getElementById("sched-form-wrap");
  const f = document.getElementById("sched-form");
  document.getElementById("sched-form-title").textContent = data?.id ? "Upravit plán" : "Nový plán";
  f.id.value = data?.id || "";
  f.name.value = data?.name || "";
  f.zone.value = data?.zone || "kapkova_a";
  f.duration_s.value = data?.duration_s ?? 60;
  f.skip_if_rain.checked = data?.skip_if_rain ?? true;
  f.min_temp_c.value = data?.min_temp_c ?? "";
  f.enabled.checked = data?.enabled ?? true;
  f.start_date.value = data?.start_date || "";
  f.end_date.value = data?.end_date || "";
  f.max_runs.value = data?.max_runs ?? "";
  populateProfileSelect(document.getElementById("sched-sekvence"), data?.profil_id || "",
                        "— jednoduchý běh (1 větev) —");
  applySchedSeqToggle();

  document.getElementById("sched-times-list").innerHTML = "";
  document.querySelectorAll("#sched-dow-chips .dow").forEach(cb => cb.checked = false);
  document.querySelector('input[name="rec_kind"][value="daily"]').checked = true;
  document.querySelector('input[name="cron_expr_raw"]').value = data?.cron_expr || "0 6 * * *";

  let kind = "recurring";
  if (data?.id) {
    const parsed = data.cron_expr ? parseCronToRecurring(data.cron_expr) : null;
    if (data.plan_kind === "cron" || !parsed) {
      kind = "cron";
    } else {
      parsed.times.forEach(t => addTimeChip(t));
      document.querySelector(`input[name="rec_kind"][value="${parsed.rec_kind}"]`).checked = true;
      if (parsed.rec_kind === "custom") {
        parsed.dow.forEach(d => {
          const cb = document.querySelector(`#sched-dow-chips .dow[value="${d}"]`);
          if (cb) cb.checked = true;
        });
      }
    }
  } else {
    addTimeChip("06:00");
  }
  document.querySelector(`input[name="plan_kind"][value="${kind}"]`).checked = true;
  applySchedKindToggle();
  updateSchedPreview();

  if (!data?.id && !f.start_date.value) {
    f.start_date.value = new Date().toISOString().slice(0,10);
  }
  wrap.style.display = "";
  wrap.scrollIntoView({ behavior: "smooth" });
}

async function deleteSchedule(id) {
  if (!confirm("Smazat plán #" + id + "?")) return;
  try {
    await api("/scheduler/" + id, { method: "DELETE" });
    loadSchedules();
  } catch (e) { alert("Chyba: " + e.message); }
}

document.getElementById("sched-new")?.addEventListener("click", () => showSchedForm(null));
document.getElementById("sched-reload")?.addEventListener("click", loadSchedules);
document.getElementById("sched-cancel")?.addEventListener("click", () => {
  document.getElementById("sched-form-wrap").style.display = "none";
});
document.getElementById("sched-sekvence")?.addEventListener("change", applySchedSeqToggle);
document.getElementById("sched-time-add-btn")?.addEventListener("click", () => {
  const t = document.getElementById("sched-time-add").value;
  if (t) addTimeChip(t);
});
document.addEventListener("change", (e) => {
  if (e.target.matches('input[name="plan_kind"]')) applySchedKindToggle();
  if (e.target.matches('input[name="rec_kind"], #sched-dow-chips .dow, input[name="end_date"], input[name="max_runs"]')) {
    updateSchedPreview();
  }
});

document.getElementById("sched-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const seqVal = f.profil_id?.value || "";
  const useSeq = !!seqVal;
  const kind = document.querySelector('input[name="plan_kind"]:checked')?.value || "recurring";

  // jednorázový → calendar override 'add'
  if (kind === "once") {
    const date = document.getElementById("sched-once-date").value;
    const time = document.getElementById("sched-once-time").value;
    if (!date || !time) { alert("Vyplň datum a čas."); return; }
    const ovPayload = {
      run_date: date, run_time: time, action: "add",
      zone: useSeq ? null : f.zone.value,
      profil_id: useSeq ? Number(seqVal) : null,
      duration_s: (useSeq || !f.duration_s.value) ? null : parseInt(f.duration_s.value),
      skip_if_rain: f.skip_if_rain.checked,
      min_temp_c: f.min_temp_c.value === "" ? null : parseFloat(f.min_temp_c.value),
      note: f.name.value.trim() || "Jednorázový běh",
    };
    try {
      await api("/calendar/override", { method: "POST", body: JSON.stringify(ovPayload) });
      document.getElementById("sched-form-wrap").style.display = "none";
      alert(`Jednorázový plán vytvořen na ${date} ${time}.`);
      loadSchedules();
    } catch (err) { alert("Chyba: " + err.message); }
    return;
  }

  let cron_expr;
  if (kind === "recurring") {
    try {
      const times = getSelectedTimes();
      if (!times.length) throw new Error("Přidej alespoň jeden čas.");
      const rec_kind = document.querySelector('input[name="rec_kind"]:checked')?.value || "daily";
      cron_expr = buildCronFromRecurring(times, rec_kind, getSelectedDow());
    } catch (err) { alert("Chyba: " + err.message); return; }
  } else {
    cron_expr = (f.cron_expr_raw?.value || "").trim();
    if (!cron_expr) { alert("Vyplň cron výraz."); return; }
  }

  const payload = {
    name: f.name.value.trim(),
    cron_expr,
    profil_id: useSeq ? Number(seqVal) : null,
    zone: useSeq ? null : f.zone.value,
    duration_s: (useSeq || !f.duration_s.value) ? null : parseInt(f.duration_s.value),
    skip_if_rain: f.skip_if_rain.checked,
    min_temp_c: f.min_temp_c.value === "" ? null : parseFloat(f.min_temp_c.value),
    enabled: f.enabled.checked,
    plan_kind: kind,
    start_date: f.start_date.value || null,
    end_date: f.end_date.value || null,
    max_runs: f.max_runs.value ? parseInt(f.max_runs.value) : null,
  };
  try {
    if (f.id.value) {
      await api("/scheduler/" + f.id.value, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/scheduler", { method: "POST", body: JSON.stringify(payload) });
    }
    document.getElementById("sched-form-wrap").style.display = "none";
    loadSchedules();
  } catch (err) { alert("Chyba: " + err.message); }
});

// ============================================================
// Kalendář
// ============================================================
const CAL_DAY_NAMES = ["Po","Út","St","Čt","Pá","So","Ne"];
const CAL_MONTH_NAMES = ["leden","únor","březen","duben","květen","červen",
                         "červenec","srpen","září","říjen","listopad","prosinec"];
let _calMode = "center";
let _calAnchor = new Date();
let _calData = null;

function calIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function calStartOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}
function calRange(mode, anchor) {
  if (mode === "center") {
    const today = new Date(); today.setHours(0,0,0,0);
    const from = new Date(today); from.setDate(from.getDate()-3);
    const to   = new Date(today); to.setDate(to.getDate()+3);
    return [from, to];
  }
  if (mode === "week") {
    const from = calStartOfWeek(anchor);
    const to = new Date(from); to.setDate(to.getDate()+6);
    return [from, to];
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last  = new Date(anchor.getFullYear(), anchor.getMonth()+1, 0);
  const from = calStartOfWeek(first);
  const to   = calStartOfWeek(last); to.setDate(to.getDate()+6);
  return [from, to];
}

async function loadCalendar() {
  const grid = document.getElementById("cal-grid");
  if (!grid) return;
  await fetchProfiles();
  const modeSel = document.getElementById("cal-mode");
  _calMode = modeSel ? modeSel.value : "center";
  const [from, to] = calRange(_calMode, _calAnchor);
  const title = document.getElementById("cal-title");
  if (_calMode === "month") {
    title.textContent = `${CAL_MONTH_NAMES[_calAnchor.getMonth()]} ${_calAnchor.getFullYear()}`;
  } else {
    title.textContent = `${calIsoDate(from)} – ${calIsoDate(to)}`;
  }
  grid.innerHTML = '<em style="color:#888">Načítám…</em>';
  try {
    const j = await api(`/calendar?from=${calIsoDate(from)}&to=${calIsoDate(to)}`);
    _calData = j;
    renderCalendar(j, from, to);
  } catch (e) {
    grid.innerHTML = `<span style="color:#c00">${e.message}</span>`;
  }
}

function renderCalendar(j, from, to) {
  const grid = document.getElementById("cal-grid");
  const isLinear = _calMode === "center" || _calMode === "week";
  grid.className = "cal-grid " + (isLinear ? "week" : "month");
  const byDate = Object.fromEntries(j.days.map(d => [d.date, d]));
  const curMonth = _calAnchor.getMonth();
  let html = "";
  if (_calMode === "center") {
    html += '<div class="cal-row">';
    const cur = new Date(from);
    while (cur <= to) {
      const iso = calIsoDate(cur);
      html += renderDayCell(iso, byDate[iso], false);
      cur.setDate(cur.getDate()+1);
    }
    html += '</div>';
  } else {
    html += '<div class="cal-row cal-head">' +
      CAL_DAY_NAMES.map(n => `<div class="cal-h">${n}</div>`).join("") + "</div>";
    const cur = new Date(from);
    while (cur <= to) {
      html += '<div class="cal-row">';
      for (let i=0; i<7; i++) {
        const iso = calIsoDate(cur);
        const d = byDate[iso];
        const otherMonth = _calMode === "month" && cur.getMonth() !== curMonth;
        html += renderDayCell(iso, d, otherMonth);
        cur.setDate(cur.getDate()+1);
      }
      html += "</div>";
    }
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".cal-day").forEach(el => {
    el.addEventListener("click", () => openDayModal(el.dataset.date));
  });
}

function renderDayCell(iso, d, otherMonth) {
  const cls = ["cal-day"];
  if (otherMonth) cls.push("other-month");
  if (d && d.is_today) cls.push("today");
  const today = new Date(); today.setHours(0,0,0,0);
  const cellDate = new Date(iso + "T00:00:00");
  const isPast  = cellDate < today;
  const isToday = cellDate.getTime() === today.getTime();
  const pastRuns = d?.past || [];
  if ((isPast || isToday) && pastRuns.length) cls.push("done");

  const w = d?.weather;
  const dayN = parseInt(iso.split("-")[2], 10);
  let weatherHtml = '<div class="cal-weather muted">—</div>';
  if (w && w.tmax_c != null) {
    const rain = w.precip_mm ?? 0;
    const rainCls = rain >= 5 ? "wet" : rain >= 1 ? "humid" : "";
    weatherHtml = `<div class="cal-weather ${rainCls}">
      <span title="min/max">${Math.round(w.tmin_c)}/${Math.round(w.tmax_c)}°</span>
      <span title="srážky">💧${rain.toFixed(1)}</span>
      <span title="vítr">💨${Math.round(w.wind_kmh_max ?? 0)}</span>
    </div>`;
  }

  const allChips = [];
  if (isPast || isToday) {
    for (const p of pastRuns) {
      if (p.source === "skipped") {
        const [reason, ...nameParts] = (p.note || "skipped").split(": ");
        const name = nameParts.join(": ") || "";
        const icon = reason === "skipped_rain" ? "☔" : reason === "skipped_cold" ? "🌡️" : "⛔";
        const t = new Date(p.start).toTimeString().slice(0,5);
        const zoneStr = (p.zone && p.zone !== "profil") ? ` · ${fmtZone(p.zone)}` : "";
        allChips.push({ sortKey: t, html: `<span class="cal-chip skipped-auto" title="Přeskočeno: ${escapeHtml(name)}">${icon} ${t} ${escapeHtml(name || "přeskočeno")}${zoneStr}</span>` });
      } else {
        const t = new Date(p.start).toTimeString().slice(0,5);
        const nameStr = p.note ? escapeHtml(p.note) + " · " : "";
        allChips.push({ sortKey: t, html: `<span class="cal-chip done" title="${fmtZone(p.zone)} · ${fmtDur(p.duration_s)}">✓ ${t} ${nameStr}${escapeHtml(fmtZone(p.zone))} <em>${fmtDur(p.duration_s)}</em></span>` });
      }
    }
    for (const f of (d?.failed_overrides || [])) {
      const target = f.profil_name ? "🔗 " + escapeHtml(f.profil_name) : escapeHtml(fmtZone(f.zone));
      const reason = (f.status || "").replace(/^error:/, "") || "chyba";
      allChips.push({ sortKey: f.time || "99:99", html: `<span class="cal-chip failed" title="Chyba: ${escapeHtml(f.status||"")}">✕ ${f.time || "—"} ${escapeHtml(f.name)} · ${target} <em>${escapeHtml(reason)}</em></span>` });
    }
  }
  if (!isPast) {
    const nowTime = isToday ? new Date().toTimeString().slice(0,5) : "00:00";
    for (const r of (d?.planned || [])) {
      if (isToday && (r.time || "99:99") <= nowTime) continue;
      const isAdd = r.kind === "add";
      const skipped = !!r.skipped_override_id;
      const chipCls = "cal-chip " + (skipped ? "skipped" : isAdd ? "added" : "run");
      const nameStr = r.name ? escapeHtml(r.name) + " · " : "";
      const target = r.profil_name ? "🔗 " + escapeHtml(r.profil_name) : escapeHtml(fmtZone(r.zone));
      const dur = r.duration_s ? ` <em>${fmtDur(r.duration_s)}</em>` : "";
      allChips.push({ sortKey: r.time || "99:99", html: `<span class="${chipCls}">${r.time || "—"} ${nameStr}${target}${dur}</span>` });
    }
  }
  allChips.sort((a,b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
  return `<div class="${cls.join(" ")}" data-date="${iso}">
    <div class="cal-date">${dayN}</div>
    ${weatherHtml}
    <div class="cal-chips">${allChips.map(c => c.html).join("")}</div>
  </div>`;
}

// --- modal ---
function applyDayAddSeqToggle() {
  const seqSel = document.getElementById("day-add-sekvence");
  if (!seqSel) return;
  const useSeq = !!seqSel.value;
  ["day-add-zone", "day-add-duration"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = useSeq;
    const lab = el.closest("label");
    if (lab) lab.style.opacity = useSeq ? "0.4" : "1";
  });
}

function openDayModal(iso) {
  const d = (_calData?.days || []).find(x => x.date === iso);
  if (!d) return;
  const modal = document.getElementById("day-modal");
  document.getElementById("day-modal-title").textContent = `Den ${iso}`;
  const w = d.weather;
  document.getElementById("day-modal-weather").innerHTML = w ? `<div class="muted">
    min/max: <b>${w.tmin_c ?? "?"}/${w.tmax_c ?? "?"}°C</b> ·
    srážky: <b>${(w.precip_mm ?? 0).toFixed(1)} mm</b> ·
    vítr max: <b>${Math.round(w.wind_kmh_max ?? 0)} km/h</b>
  </div>` : '<div class="muted">Bez předpovědi.</div>';

  const runsEl = document.getElementById("day-modal-runs");
  if (!d.planned.length) {
    runsEl.innerHTML = '<em class="muted">Žádné naplánované běhy.</em>';
  } else {
    runsEl.innerHTML = d.planned.map(r => {
      const isAdd = r.kind === "add";
      const skipped = !!r.skipped_override_id;
      const target = r.profil_name ? `🔗 ${r.profil_name}` : fmtZone(r.zone);
      const dur = r.duration_s ? ` · ${fmtDur(r.duration_s)}` : "";
      const label = `${r.time || "—"} · ${r.name || ""} · ${target}${dur}` + (skipped ? " (přeskočeno)" : "");
      if (isAdd) {
        return `<div class="run-row added"><span>📅 ${escapeHtml(label)}</span>
          <button data-act="del-add" data-id="${r.override_id}">Zrušit</button></div>`;
      }
      if (skipped) {
        return `<div class="run-row skipped"><span>${escapeHtml(label)}</span>
          <button data-act="del-skip" data-id="${r.skipped_override_id}">Obnovit</button></div>`;
      }
      return `<div class="run-row"><span>${escapeHtml(label)}</span>
        <button data-act="skip" data-sid="${r.schedule_id}" data-time="${r.time}">Přeskočit</button></div>`;
    }).join("");
  }
  runsEl.querySelectorAll("button").forEach(b => {
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      try {
        if (act === "skip") {
          await api("/calendar/override", { method: "POST", body: JSON.stringify({
            run_date: iso, run_time: b.dataset.time, action: "skip",
            schedule_id: Number(b.dataset.sid),
          })});
        } else if (act === "del-add" || act === "del-skip") {
          await api("/calendar/override/" + b.dataset.id, { method: "DELETE" });
        }
        await loadCalendar();
        openDayModal(iso);
      } catch (e) { alert("Chyba: " + e.message); }
    });
  });

  populateProfileSelect(document.getElementById("day-add-sekvence"), "", "— jednoduchý běh —");
  applyDayAddSeqToggle();

  const pastEl = document.getElementById("day-modal-past");
  const pastRec = d.past || [];
  const failedOv = d.failed_overrides || [];
  if (!pastRec.length && !failedOv.length) {
    pastEl.innerHTML = '<em class="muted">Žádné záznamy.</em>';
  } else {
    const okRows = pastRec.filter(p => p.source !== "skipped").map(p => {
      const t = new Date(p.start).toLocaleTimeString("cs-CZ", { hour:"2-digit", minute:"2-digit" });
      const te = p.stop ? " – " + new Date(p.stop).toLocaleTimeString("cs-CZ", { hour:"2-digit", minute:"2-digit" }) : "";
      const nameStr = p.note ? `<b>${escapeHtml(p.note)}</b> · ` : "";
      return `<div class="run-row" style="color:#1a5c2e">✓ ${t}${te} · ${nameStr}${escapeHtml(fmtZone(p.zone))} · ${fmtDur(p.duration_s)}</div>`;
    });
    const skipRows = pastRec.filter(p => p.source === "skipped").map(p => {
      const t = new Date(p.start).toLocaleTimeString("cs-CZ", { hour:"2-digit", minute:"2-digit" });
      const [reason, ...nameParts] = (p.note || "skipped").split(": ");
      const name = nameParts.join(": ") || "";
      const reasonLabel = { skipped_rain: "déšť ☔", skipped_cold: "nízká teplota 🌡️" }[reason] || reason;
      return `<div class="run-row run-row-skip">⛔ ${t} · <b>${escapeHtml(name)}</b> přeskočeno<br><small>Důvod: ${escapeHtml(reasonLabel)}</small></div>`;
    });
    const errRows = failedOv.map(f => {
      const target = f.profil_name ? `🔗 ${escapeHtml(f.profil_name)}` : escapeHtml(fmtZone(f.zone));
      const reason = (f.status || "").replace(/^error:/, "") || "neznámá chyba";
      return `<div class="run-row run-row-error">✕ ${f.time || "—"} · <b>${escapeHtml(f.name)}</b> · ${target}<br><small style="color:#b91c1c">Chyba: ${escapeHtml(reason)}</small></div>`;
    });
    pastEl.innerHTML = [...okRows, ...skipRows, ...errRows].join("");
  }

  modal.style.display = "flex";
  modal.dataset.date = iso;
}

document.getElementById("day-add-sekvence")?.addEventListener("change", applyDayAddSeqToggle);
document.getElementById("day-modal-close")?.addEventListener("click", () => {
  document.getElementById("day-modal").style.display = "none";
});
document.getElementById("day-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "day-modal") e.target.style.display = "none";
});

document.getElementById("day-add-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const modal = document.getElementById("day-modal");
  const iso = modal.dataset.date;
  const f = e.target;
  const fd = new FormData(f);
  const seqVal = fd.get("profil_id");
  const useSeq = !!seqVal;
  const payload = {
    run_date: iso,
    run_time: fd.get("time"),
    action: "add",
    profil_id: useSeq ? Number(seqVal) : null,
    zone: useSeq ? null : fd.get("zone"),
    duration_s: useSeq ? null : (fd.get("duration_s") ? parseInt(fd.get("duration_s")) : null),
    skip_if_rain: fd.get("skip_if_rain") === "on",
    note: fd.get("note") || null,
  };
  try {
    await api("/calendar/override", { method: "POST", body: JSON.stringify(payload) });
    f.reset();
    await loadCalendar();
    openDayModal(iso);
  } catch (err) { alert("Chyba: " + err.message); }
});

document.getElementById("cal-prev")?.addEventListener("click", () => {
  if (_calMode === "week" || _calMode === "center") _calAnchor.setDate(_calAnchor.getDate() - 7);
  else _calAnchor.setMonth(_calAnchor.getMonth() - 1);
  loadCalendar();
});
document.getElementById("cal-next")?.addEventListener("click", () => {
  if (_calMode === "week" || _calMode === "center") _calAnchor.setDate(_calAnchor.getDate() + 7);
  else _calAnchor.setMonth(_calAnchor.getMonth() + 1);
  loadCalendar();
});
document.getElementById("cal-today")?.addEventListener("click", () => {
  _calAnchor = new Date();
  loadCalendar();
});
document.getElementById("cal-mode")?.addEventListener("change", () => loadCalendar());

// ============================================================
// Meteo
// ============================================================
let meteoChart = null;
async function loadMeteo(force) {
  const sum = document.getElementById("meteo-summary");
  if (!sum) return;
  sum.innerHTML = "Načítám…";
  try {
    const j = await api("/weather" + (force ? "?force=true" : ""));
    sum.innerHTML = `
      <div class="m-cell"><div class="lbl">Tmin dnes</div><div class="val">${j.temp_min_c ?? "—"} °C</div></div>
      <div class="m-cell"><div class="lbl">Tmax dnes</div><div class="val">${j.temp_max_c ?? "—"} °C</div></div>
      <div class="m-cell"><div class="lbl">Srážky dnes</div><div class="val">${j.precip_mm ?? "—"} mm</div></div>
      <div class="m-cell"><div class="lbl">Vítr max dnes</div><div class="val">${j.wind_kmh_max ?? "—"} km/h</div></div>
      <div class="m-cell"><div class="lbl">Načteno</div><div class="val" style="font-size:.9rem">${fmtTs(j.fetched_at)}<br><small>${j.from_cache ? "z cache" : "čerstvé"}</small></div></div>`;

    const hourly = j.raw?.hourly;
    if (!hourly?.time?.length) return;
    const now = new Date();
    const allTimes = hourly.time;
    let nowFullIdx = 0, bestDiff = Infinity;
    allTimes.forEach((t, i) => {
      const diff = Math.abs(new Date(t) - now);
      if (diff < bestDiff) { bestDiff = diff; nowFullIdx = i; }
    });
    const winStart = Math.max(0, nowFullIdx - 6);
    const winEnd   = winStart + 48;
    const labels = allTimes.slice(winStart, winEnd);
    const temps  = (hourly.temperature_2m || []).slice(winStart, winEnd);
    const prec   = (hourly.precipitation || []).slice(winStart, winEnd);
    const wind   = (hourly.wind_speed_10m || []).slice(winStart, winEnd);
    const nowIdx = nowFullIdx - winStart;

    const WIND_WARN = 20, TEMP_WARN = 30;
    const warningZonesPlugin = {
      id: "warningZones",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea: { top, bottom, right }, scales } = chart;
        const xScale = scales.x;
        const n = labels.length;
        const drawBands = (flags, fillColor, labelText) => {
          let inBand = false, bandStart = 0;
          const flush = (end) => {
            const x0 = xScale.getPixelForValue(bandStart);
            const x1 = (end + 1 < n) ? xScale.getPixelForValue(end + 1) : right;
            ctx.save();
            ctx.fillStyle = fillColor;
            ctx.fillRect(x0, top, x1 - x0, bottom - top);
            ctx.fillStyle = fillColor.replace(/[\d.]+\)$/, "1)");
            ctx.font = "bold 9px sans-serif";
            ctx.fillText(labelText, x0 + 2, top + 9);
            ctx.restore();
          };
          flags.forEach((bad, i) => {
            if (bad && !inBand) { inBand = true; bandStart = i; }
            if (!bad && inBand) { flush(i - 1); inBand = false; }
          });
          if (inBand) flush(n - 1);
        };
        drawBands(wind.map(w => w > WIND_WARN),
                  "rgba(251,146,60,0.35)", `💨 vítr >${WIND_WARN} km/h`);
        drawBands(temps.map(t => t > TEMP_WARN),
                  "rgba(220,38,38,0.28)", `🌡️ >${TEMP_WARN}°C`);
      },
    };

    const nowLinePlugin = {
      id: "nowLine",
      afterDatasetsDraw(chart) {
        if (nowIdx < 0) return;
        const { top, bottom } = chart.chartArea;
        const ctx = chart.ctx;
        const x = chart.scales.x.getPixelForValue(nowIdx);
        ctx.save();
        ctx.strokeStyle = "#d62828";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#d62828";
        ctx.font = "bold 11px sans-serif";
        ctx.fillText("Teď " + now.toLocaleString("cs-CZ", { day:"numeric", month:"numeric", hour:"2-digit", minute:"2-digit" }), x + 4, top + 12);
        ctx.restore();
      },
    };

    const ctx = document.getElementById("meteo-canvas").getContext("2d");
    if (meteoChart) meteoChart.destroy();
    meteoChart = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          { type: "line", label: "Teplota (°C)", data: temps, yAxisID: "y",  borderColor: "#e63946", pointRadius: 0, tension: 0.2 },
          { type: "line", label: "Vítr (km/h)",  data: wind,  yAxisID: "y2", borderColor: "#588157", pointRadius: 0, tension: 0.2, borderDash: [4, 3] },
          { type: "bar",  label: "Srážky (mm)",  data: prec,  yAxisID: "y1", backgroundColor: "rgba(69,123,157,0.7)" },
        ],
      },
      options: {
        responsive: true,
        interaction: { mode: "index", intersect: false },
        scales: {
          x:  { ticks: { maxTicksLimit: 12 } },
          y:  { position: "left",  title: { display: true, text: "°C" } },
          y1: { position: "right", title: { display: true, text: "mm" }, grid: { drawOnChartArea: false } },
          y2: { position: "right", title: { display: true, text: "km/h" }, grid: { drawOnChartArea: false }, offset: true },
        },
        plugins: { legend: { position: "bottom" } },
      },
      plugins: [warningZonesPlugin, nowLinePlugin],
    });
  } catch (e) {
    sum.innerHTML = `<p style="color:#c00">Chyba: ${e.message}</p>`;
  }
}
document.getElementById("meteo-load")?.addEventListener("click", () => loadMeteo(false));
document.getElementById("meteo-force")?.addEventListener("click", () => loadMeteo(true));
