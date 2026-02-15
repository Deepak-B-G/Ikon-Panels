import { fetch } from "wix-fetch";

// =====================
// CONFIG (change only this block)
// =====================
const DEVICE_ID = "pump-001";

// Your ECS ALB base URL (no trailing slash)
const API_BASE = "https://api.ikonpanels.com/api/v1";

// APP_MODE:
//  - "SIM"  => uses SimulationController endpoints: /telemetry, /command
//  - "POLL" => uses UI endpoints: /ui/telemetry, /ui/command
const APP_MODE = "POLL"; // <-- change to "POLL" when needed

// Polling interval
const POLL_MS = 1000;

// =====================
// INTERNAL STATE (Telemetry)
// =====================
let pollHandle = null;

// Optional: pending status UI for start/stop feeling
let pendingStatus = null; // "STARTING" | "STOPPING" | null
let pendingUntilMs = 0;

// =====================
// INTERNAL STATE (Settings)
// =====================
let appliedSettings = null; // last saved/active settings (UI only for now)
let draftSettings = null;   // user is editing these (UI only for now)

// =====================
// ENDPOINT RESOLVER
// =====================
function getEndpoints() {
  const m = String(APP_MODE || "").toUpperCase();

  // SIM endpoints (SimulationController)
  const sim = {
    mode: "SIM",
    telemetryGet: (deviceId) =>
      `${API_BASE}/telemetry?deviceId=${encodeURIComponent(deviceId)}`,
    commandPost: () => `${API_BASE}/command`,
  };

  // POLL endpoints (UI APIs)
  // NOTE: per your backend logs, UI controller route is /api/v1/ui/telemetry, /api/v1/ui/command
  const poll = {
    mode: "POLL",
    telemetryGet: (deviceId) =>
      `${API_BASE}/ui/telemetry?deviceId=${encodeURIComponent(deviceId)}`,
    commandPost: () => `${API_BASE}/ui/command`,
    settingsPost: () => `${API_BASE}/ui/settings`, 
  };

  return m === "POLL" ? poll : sim;
}

// =====================
// PAGE READY
// =====================
$w.onReady(() => {
  const ep = getEndpoints();
  console.log(
    `[IKON_UI] APP_MODE = ${ep.mode} | telemetry: ${ep.telemetryGet(DEVICE_ID)} | command: ${ep.commandPost()}`
  );

  // ----- Bind MOTOR UI events -----
  safeOnClick("#boxStartCircle", () => sendCommand("start"));
  safeOnClick("#boxStopCircle",  () => sendCommand("stop"));

  safeOnChange("#swAutoStart", () => {
    // UI-only for now
  });

  // ----- Init MOTOR UI -----
  applyTelemetry({
    deviceId: DEVICE_ID,
    mode: "stopped",
    autoStart: false,
    power: "OFF",
    amps: { r: "--", y: "--", b: "--" },
    volts:{ r: "--", y: "--", b: "--" },
    ts: new Date().toISOString()
  });

  // ----- Init SETTINGS UI (UI stays, no backend link today) -----
  initSettingsModule();

  // ----- Start backend telemetry polling -----
  startPolling();
});

// =====================
// API UNWRAP HELPER
// Some APIs respond as {status,message,data:{...}}
// =====================
function unwrapApi(body) {
  if (!body) return {};
  if (typeof body === "object" && body.data && typeof body.data === "object") return body.data;
  return body;
}

// =====================
// BACKEND POLLING (REST)
// =====================
function startPolling() {
  stopPolling();
  pollOnce();
  pollHandle = setInterval(pollOnce, POLL_MS);
}

function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function pollOnce() {
  try {
    const ep = getEndpoints();
    const url = ep.telemetryGet(DEVICE_ID);

    console.log("[IKON_UI] POLL -> GET", url, "| pendingStatus:", pendingStatus, "| pendingUntilMs:", pendingUntilMs);

    const t0 = Date.now();
    const res = await fetch(url, { method: "GET" });
    const ms = Date.now() - t0;

    console.log("[IKON_UI] POLL RESPONSE:", res.status, "| took", ms, "ms");
    if (!res.ok) return;

    const body = await res.json();
    console.log("[IKON_UI] POLL BODY (raw):", body);

    const payload = unwrapApi(body);
    const norm = normalizeTelemetry(payload);
    console.log("[IKON_UI] POLL normalized:", norm);

    // Pending STARTING/STOPPING UX:
    if (pendingStatus && Date.now() <= pendingUntilMs) {
      if (pendingStatus === "STARTING" && norm.mode === "running") {
        pendingStatus = null;
        pendingUntilMs = 0;
      }
      if (pendingStatus === "STOPPING" && norm.mode === "stopped") {
        pendingStatus = null;
        pendingUntilMs = 0;
      }
    } else if (pendingStatus && Date.now() > pendingUntilMs) {
      console.log("[IKON_UI] POLL pending expired -> clearing pendingStatus");
      pendingStatus = null;
      pendingUntilMs = 0;
    }

    applyTelemetry(norm);
  } catch (e) {
    console.warn("pollOnce error:", e);
    setStatusBar("OFFLINE", "#9ca3af");
  }
}

// =====================
// COMMAND SENDER
// =====================
async function sendCommand(action) {
  // Optimistic status while we wait for real telemetry to reflect it
  if (action === "start") {
    pendingStatus = "STARTING";
    pendingUntilMs = Date.now() + 8000;
    setStatusBar("STARTING", "#f59e0b");
  }
  if (action === "stop") {
    pendingStatus = "STOPPING";
    pendingUntilMs = Date.now() + 8000;
    setStatusBar("STOPPING", "#f59e0b");
  }

  const ep = getEndpoints();
  const url = ep.commandPost();
  const payload = { deviceId: DEVICE_ID, action };

  console.log("[IKON_UI] SEND COMMAND:", action, "| url:", url, "| payload:", payload);

  try {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const ms = Date.now() - t0;

    console.log("[IKON_UI] COMMAND RESPONSE:", res.status, "| took", ms, "ms");

    const body = await res.json().catch(() => ({}));
    console.log("[IKON_UI] COMMAND BODY (raw):", body);

    if (!res.ok) {
      setStatusBar("ERROR", "#ef4444");
      return;
    }

    console.log("[IKON_UI] COMMAND OK -> pollOnce() now");
    await pollOnce();
  } catch (e) {
    console.warn("sendCommand error:", e);
    setStatusBar("ERROR", "#ef4444");
  }
}

// =====================
// TELEMETRY NORMALIZER
// =====================
function normalizeTelemetry(raw) {
  const t = raw || {};

  // normalize strings safely
  const modeRaw  = String(t.mode  ?? "").trim().toLowerCase();
  const powerRaw = String(t.power ?? "").trim().toLowerCase();

  // Accept multiple backend variants
  const runningWords = new Set(["running", "run", "started", "start", "on"]);
  const stoppedWords = new Set(["stopped", "stop", "off"]);

  let mode = "stopped";
  if (runningWords.has(modeRaw)) mode = "running";
  else if (stoppedWords.has(modeRaw)) mode = "stopped";

  const autoStart = !!t.autoStart;

  // power: accept ON/OFF and On/Off etc.
  let power = powerRaw === "on" ? "ON" : powerRaw === "off" ? "OFF" : "";
  if (!power) power = mode === "running" ? "ON" : "OFF";

  const amps = t.amps || {};
  const volts = t.volts || {};

  return {
    deviceId: t.deviceId || DEVICE_ID,
    ts: t.ts || new Date().toISOString(),
    mode,
    autoStart,
    power,
    amps: {
      r: safeNumOrDash(amps.r),
      y: safeNumOrDash(amps.y),
      b: safeNumOrDash(amps.b),
    },
    volts: {
      r: safeNumOrDash(volts.r),
      y: safeNumOrDash(volts.y),
      b: safeNumOrDash(volts.b),
    }
  };
}

// =====================
// APPLY TELEMETRY TO UI
// (DO NOT change component IDs)
// =====================
function applyTelemetry(input) {
  const t = normalizeTelemetry(input);

  if (pendingStatus && Date.now() <= pendingUntilMs) {
    setStatusBar(pendingStatus, "#f59e0b");
  } else {
    if (t.mode === "running") setStatusBar("RUNNING", "#16a34a");
    else setStatusBar("STOPPED", "#ef4444");
  }

  safeSetText("#txtUpdatedOn", `Updated ON : ${formatTs(t.ts)}`);

  safeSetText("#txtPowerState", t.power);
  safeSetBoxColor("#boxPowerState", t.power === "ON" ? "#16a34a" : "#9ca3af");

  safeSetSwitchChecked("#swAutoStart", !!t.autoStart);

  safeSetText("#txtAmpsR", `${t.amps.r}`);
  safeSetText("#txtAmpsY", `${t.amps.y}`);
  safeSetText("#txtAmpsB", `${t.amps.b}`);

  safeSetText("#txtVoltR", `${t.volts.r}`);
  safeSetText("#txtVoltY", `${t.volts.y}`);
  safeSetText("#txtVoltB", `${t.volts.b}`);
}

// =====================================================
// SETTINGS MODULE (UI stays, NO backend link today)
// =====================================================
function initSettingsModule() {
  initHoursDropdown("#ddDryRunHrs", 0, 3);
  initHoursDropdown("#ddCyclicRunHrs", 0, 3);
  initHoursDropdown("#ddCyclicOffHrs", 0, 3);

  initSlider("#slAutoStartDelay", 0, 300, 1);
  initSlider("#slPowerOnDelay", 0, 300, 1);
  initSlider("#slOverloadAmps", 0, 150, 1);

  initSlider("#slDryrunMins", 0, 59, 1);
  initSlider("#slCyclicRunMins", 0, 59, 1);
  initSlider("#slCyclicOffMins", 0, 59, 1);

  const initial = getInitialSettings();
  appliedSettings = deepClone(initial);
  draftSettings = deepClone(initial);

  bindSettingsEvents();
  renderSettingsUI(draftSettings);
  applySettingsRules();

  safeOnClick("#Savebutton", onSaveSettings);
  safeOnClick("#Resetbutton", onResetSettings);
}

function getInitialSettings() {
  return {
    autoStartDelayEnabled: false,
    autoStartDelaySec: 0,

    powerOnDelayEnabled: false,
    powerOnDelaySec: 0,

    dryRunEnabled: false,

    dryRunRestartEnabled: false,
    dryRunRestartDelayMin: 1,

    overloadEnabled: false,
    overloadAmps: 0,

    cyclicEnabled: false,
    cyclicRunMin: 0,
    cyclicOffMin: 0,

    deviceInfo: {
      starterMobile: "value",
      imei: "value",
      totalRunTime: "value"
    }
  };
}

function bindSettingsEvents() {
  safeOnChange("#swAutoStartDelay", () => {
    draftSettings.autoStartDelayEnabled = !!$w("#swAutoStartDelay").checked;
    applySettingsRules();
  });

  safeOnChange("#swPowerOnDelay", () => {
    draftSettings.powerOnDelayEnabled = !!$w("#swPowerOnDelay").checked;
    applySettingsRules();
  });

  safeOnChange("#swDryRun", () => {
    draftSettings.dryRunEnabled = !!$w("#swDryRun").checked;
    applySettingsRules();
  });

  safeOnChange("#swDryRunRestart", () => {
    draftSettings.dryRunRestartEnabled = !!$w("#swDryRunRestart").checked;
    applySettingsRules();
  });

  safeOnChange("#swOverload", () => {
    draftSettings.overloadEnabled = !!$w("#swOverload").checked;
    applySettingsRules();
  });

  safeOnChange("#swCyclic", () => {
    draftSettings.cyclicEnabled = !!$w("#swCyclic").checked;
    applySettingsRules();
  });

  const bindSlider = (sel, handler) => {
    safeOnInput(sel, handler);
    safeOnChange(sel, handler);
  };

  bindSlider("#slAutoStartDelay", () => {
    draftSettings.autoStartDelaySec = toInt($w("#slAutoStartDelay").value);
    safeSetText("#txtAutoStartDelayVal", `${draftSettings.autoStartDelaySec} s`);
  });

  bindSlider("#slPowerOnDelay", () => {
    draftSettings.powerOnDelaySec = toInt($w("#slPowerOnDelay").value);
    safeSetText("#txtPowerOnDelayVal", `${draftSettings.powerOnDelaySec} s`);
  });

  bindSlider("#slOverloadAmps", () => {
    draftSettings.overloadAmps = toInt($w("#slOverloadAmps").value);
    safeSetText("#txtOverloadAmpsVal", `${draftSettings.overloadAmps} A`);
  });

  safeOnChange("#ddDryRunHrs", () => {
    draftSettings.dryRunRestartDelayMin = clamp(getDryRunRestartMinsFromUI(), 1, 180);
    safeSetText("#txtDryRunRestartVal", `Delay: ${minsToHHMM(draftSettings.dryRunRestartDelayMin)}`);
  });

  bindSlider("#slDryrunMins", () => {
    draftSettings.dryRunRestartDelayMin = clamp(getDryRunRestartMinsFromUI(), 1, 180);
    safeSetText("#txtDryRunRestartVal", `Delay: ${minsToHHMM(draftSettings.dryRunRestartDelayMin)}`);
  });

  safeOnChange("#ddCyclicRunHrs", () => {
    draftSettings.cyclicRunMin = clamp(getCyclicRunMinsFromUI(), 0, 180);
    safeSetText("#txtCyclicRunVal", `Time: ${minsToHHMM(draftSettings.cyclicRunMin)}`);
  });

  bindSlider("#slCyclicRunMins", () => {
    draftSettings.cyclicRunMin = clamp(getCyclicRunMinsFromUI(), 0, 180);
    safeSetText("#txtCyclicRunVal", `Time: ${minsToHHMM(draftSettings.cyclicRunMin)}`);
  });

  safeOnChange("#ddCyclicOffHrs", () => {
    draftSettings.cyclicOffMin = clamp(getCyclicOffMinsFromUI(), 0, 180);
    safeSetText("#txtCyclicOffVal", `Time: ${minsToHHMM(draftSettings.cyclicOffMin)}`);
  });

  bindSlider("#slCyclicOffMins", () => {
    draftSettings.cyclicOffMin = clamp(getCyclicOffMinsFromUI(), 0, 180);
    safeSetText("#txtCyclicOffVal", `Time: ${minsToHHMM(draftSettings.cyclicOffMin)}`);
  });
}

function applySettingsRules() {
  safeSetEnabled("#slAutoStartDelay", !!draftSettings.autoStartDelayEnabled);
  safeSetEnabled("#slPowerOnDelay", !!draftSettings.powerOnDelayEnabled);
  safeSetEnabled("#slOverloadAmps", !!draftSettings.overloadEnabled);

  safeSetEnabled("#swDryRunRestart", !!draftSettings.dryRunEnabled);

  if (!draftSettings.dryRunEnabled) {
    draftSettings.dryRunRestartEnabled = false;
    safeSetSwitchChecked("#swDryRunRestart", false);
  }

  const dryRestartAllowed = !!draftSettings.dryRunEnabled && !!draftSettings.dryRunRestartEnabled;
  safeSetEnabled("#ddDryRunHrs", dryRestartAllowed);
  safeSetEnabled("#slDryrunMins", dryRestartAllowed);

  safeSetEnabled("#ddCyclicRunHrs", !!draftSettings.cyclicEnabled);
  safeSetEnabled("#slCyclicRunMins", !!draftSettings.cyclicEnabled);
  safeSetEnabled("#ddCyclicOffHrs", !!draftSettings.cyclicEnabled);
  safeSetEnabled("#slCyclicOffMins", !!draftSettings.cyclicEnabled);

  draftSettings.autoStartDelaySec = clamp(draftSettings.autoStartDelaySec, 0, 300);
  draftSettings.powerOnDelaySec = clamp(draftSettings.powerOnDelaySec, 0, 300);
  draftSettings.overloadAmps = clamp(draftSettings.overloadAmps, 0, 150);

  draftSettings.cyclicRunMin = clamp(draftSettings.cyclicRunMin, 0, 180);
  draftSettings.cyclicOffMin = clamp(draftSettings.cyclicOffMin, 0, 180);

  draftSettings.dryRunRestartDelayMin = clamp(draftSettings.dryRunRestartDelayMin, 1, 180);

  renderSettingsUI(draftSettings);
}

function renderSettingsUI(s) {
  safeSetSwitchChecked("#swAutoStartDelay", !!s.autoStartDelayEnabled);
  safeSetSwitchChecked("#swPowerOnDelay", !!s.powerOnDelayEnabled);
  safeSetSwitchChecked("#swDryRun", !!s.dryRunEnabled);
  safeSetSwitchChecked("#swDryRunRestart", !!s.dryRunRestartEnabled);
  safeSetSwitchChecked("#swOverload", !!s.overloadEnabled);
  safeSetSwitchChecked("#swCyclic", !!s.cyclicEnabled);

  safeSetSlider("#slAutoStartDelay", s.autoStartDelaySec, 0, 300, 1);
  safeSetText("#txtAutoStartDelayVal", `${toInt(s.autoStartDelaySec)} s`);

  safeSetSlider("#slPowerOnDelay", s.powerOnDelaySec, 0, 300, 1);
  safeSetText("#txtPowerOnDelayVal", `${toInt(s.powerOnDelaySec)} s`);

  safeSetSlider("#slOverloadAmps", s.overloadAmps, 0, 150, 1);
  safeSetText("#txtOverloadAmpsVal", `${toInt(s.overloadAmps)} A`);

  const dr = clamp(s.dryRunRestartDelayMin, 1, 180);
  const drH = Math.floor(dr / 60);
  const drM = dr % 60;
  safeSetDropdown("#ddDryRunHrs", drH);
  safeSetSlider("#slDryrunMins", drM, 0, 59, 1);
  safeSetText("#txtDryRunRestartVal", `Delay: ${pad2(drH)}:${pad2(drM)}`);

  const run = clamp(s.cyclicRunMin, 0, 180);
  const runH = Math.floor(run / 60);
  const runM = run % 60;
  safeSetDropdown("#ddCyclicRunHrs", runH);
  safeSetSlider("#slCyclicRunMins", runM, 0, 59, 1);
  safeSetText("#txtCyclicRunVal", `Time: ${pad2(runH)}:${pad2(runM)}`);

  const off = clamp(s.cyclicOffMin, 0, 180);
  const offH = Math.floor(off / 60);
  const offM = off % 60;
  safeSetDropdown("#ddCyclicOffHrs", offH);
  safeSetSlider("#slCyclicOffMins", offM, 0, 59, 1);
  safeSetText("#txtCyclicOffVal", `Time: ${pad2(offH)}:${pad2(offM)}`);

  safeSetText("#txtStarterMobile", `Starter Mobile: ${s.deviceInfo?.starterMobile ?? "--"}`);
  safeSetText("#txtImei", `IMEI: ${s.deviceInfo?.imei ?? "--"}`);
  safeSetText("#txtTotalRunTime", `Total Run Time: ${s.deviceInfo?.totalRunTime ?? "--"}`);
}

async function onSaveSettings() {
  appliedSettings = deepClone(draftSettings);

  const ep = getEndpoints();
  if (ep.mode === "POLL" && ep.settingsPost) {
    try {
      const res = await fetch(ep.settingsPost(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          settings: appliedSettings
        }),
      });

      const body = await res.json().catch(() => ({}));
      console.log("[IKON_UI] SETTINGS SAVE:", res.status, body);

      if (!res.ok) {
        flashButtonText("#Savebutton", "Error ✗", 1200);
        return;
      }
    } catch (e) {
      console.warn("[IKON_UI] SETTINGS SAVE error:", e);
      flashButtonText("#Savebutton", "Error ✗", 1200);
      return;
    }
  }

  flashButtonText("#Savebutton", "Saved ✓", 1200);
}


function onResetSettings() {
  draftSettings = deepClone(appliedSettings);
  renderSettingsUI(draftSettings);
  applySettingsRules();
  flashButtonText("#Resetbutton", "Reset ✓", 900);
}

// =====================
// SETTINGS: UI value getters
// =====================
function getDryRunRestartMinsFromUI() {
  const h = toInt($w("#ddDryRunHrs").value ?? 0);
  const m = toInt($w("#slDryrunMins").value ?? 0);
  return h * 60 + m;
}
function getCyclicRunMinsFromUI() {
  const h = toInt($w("#ddCyclicRunHrs").value ?? 0);
  const m = toInt($w("#slCyclicRunMins").value ?? 0);
  return h * 60 + m;
}
function getCyclicOffMinsFromUI() {
  const h = toInt($w("#ddCyclicOffHrs").value ?? 0);
  const m = toInt($w("#slCyclicOffMins").value ?? 0);
  return h * 60 + m;
}

function minsToHHMM(mins) {
  const m = clamp(mins, 0, 9999);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${pad2(h)}:${pad2(mm)}`;
}

// =====================
// UI HELPERS (safe wrappers)
// =====================
function safeOnClick(sel, fn) { try { $w(sel).onClick(fn); } catch (_) {} }
function safeOnChange(sel, fn) { try { $w(sel).onChange(fn); } catch (_) {} }
function safeOnInput(sel, fn) { try { $w(sel).onInput(fn); } catch (_) {} }

function safeSetText(sel, txt) {
  try {
    const el = $w(sel);
    const s = String(txt);
    if (typeof el.text !== "undefined") { el.text = s; return; }
    if (typeof el.html !== "undefined") { el.html = s; return; }
  } catch (_) {}
}

function safeSetBoxColor(sel, color) {
  try { $w(sel).style.backgroundColor = color; } catch (_) {}
}

function safeSetSwitchChecked(sel, checked) {
  try {
    if ($w(sel).checked !== !!checked) $w(sel).checked = !!checked;
  } catch (_) {}
}

function safeSetEnabled(sel, enabled) {
  try { $w(sel).enabled = !!enabled; } catch (_) {}
}

function safeSetSlider(sel, value, min, max, step = 1) {
  try {
    $w(sel).min = min;
    $w(sel).max = max;
    $w(sel).step = step;
    $w(sel).value = clamp(toInt(value), min, max);
  } catch (_) {}
}

function safeSetDropdown(sel, value) {
  try { $w(sel).value = toInt(value); } catch (_) {}
}

function setStatusBar(text, color) {
  safeSetText("#txtStatusBar", text);
  safeSetBoxColor("#boxStatusBar", color);
}

function initHoursDropdown(sel, minH, maxH) {
  try {
    const opts = [];
    for (let h = minH; h <= maxH; h++) opts.push({ label: `${h}`, value: h });
    $w(sel).options = opts;
  } catch (_) {}
}

function initSlider(sel, min, max, step = 1) {
  try {
    $w(sel).min = min;
    $w(sel).max = max;
    $w(sel).step = step;
  } catch (_) {}
}

function flashButtonText(sel, text, ms) {
  try {
    const btn = $w(sel);
    const old = btn.label;
    btn.label = text;
    setTimeout(() => (btn.label = old), ms);
  } catch (_) {}
}

// =====================
// Utils
// =====================
function safeNumOrDash(v) {
  if (v === null || v === undefined || v === "") return "--";
  const n = Number(v);
  if (Number.isNaN(n)) return "--";
  return Math.round(n * 10) / 10;
}

function formatTs(iso) {
  try { return new Date(iso).toLocaleString(); } catch (_) { return String(iso); }
}

function clamp(n, a, b) {
  n = Number(n);
  if (Number.isNaN(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function toInt(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.round(n);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function deepClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return obj; }
}
