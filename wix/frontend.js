import { fetch } from "wix-fetch";

// =====================
// CONFIG
// =====================
const DEVICE_ID = "pump-001";

/**
 * MODE SEMANTICS
 * SIM  = backend simulation (REST)
 * POLL = backend real device (REST)
 * WS   = backend real device (WebSocket)
 */
const DATA_MODE = "SIM";

const API_BASE =
  "https://9809vupfjf.execute-api.eu-north-1.amazonaws.com/default/api/v1";

const WS_URL = "wss://YOUR_WS_ID.execute-api.REGION.amazonaws.com/prod";
const POLL_MS = 1000;

// =====================
// INTERNAL STATE
// =====================
let pollHandle = null;
let ws = null;

$w.onReady(() => {
  // ----- Bind UI events -----
  safeOnClick("#boxStartCircle", () => sendCommand("start"));
  safeOnClick("#boxStopCircle", () => sendCommand("stop"));

  safeOnChange("#swAutoStart", () => {
    const isOn = $w("#swAutoStart").checked;
    sendCommand(isOn ? "auto_on" : "auto_off");
  });

  // ----- Init UI -----
  applyTelemetry({
    deviceId: DEVICE_ID,
    mode: "stopped",
    autoStart: false,
    power: "OFF",
    amps: { r: "--", y: "--", b: "--" },
    volts: { r: "--", y: "--", b: "--" },
    ts: new Date().toISOString()
  });

  startDataSource();
});

// =====================
// DATA SOURCE START/STOP
// =====================
function startDataSource() {
  stopDataSource();

  if (DATA_MODE === "SIM" || DATA_MODE === "POLL") {
    pollOnce();
    pollHandle = setInterval(pollOnce, POLL_MS);
    return;
  }

  if (DATA_MODE === "WS") {
    connectWS();
  }
}

function stopDataSource() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
}

// =====================
// REST POLLING
// =====================
async function pollOnce() {
  try {
    const url = `${API_BASE}/telemetry?deviceId=${encodeURIComponent(DEVICE_ID)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return;

    const t = await res.json();
    applyTelemetry(normalizeTelemetry(t));
  } catch (e) {
    console.warn("pollOnce error:", e);
  }
}

// =====================
// WEBSOCKET (OPTIONAL)
// =====================
function connectWS() {
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "subscribe",
        deviceId: DEVICE_ID
      }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "telemetry" || msg.type === "state") {
          applyTelemetry(normalizeTelemetry(msg.payload));
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      setTimeout(connectWS, 1500);
    };
  } catch (e) {
    console.warn("WS connect error:", e);
  }
}

// =====================
// COMMAND SENDER (BACKEND ONLY)
// =====================
async function sendCommand(action) {
  if (action === "start") setStatusBar("STARTING", "#f59e0b");
  if (action === "stop")  setStatusBar("STOPPING", "#f59e0b");

  try {
    const res = await fetch(`${API_BASE}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        action,
        clientCmdId: `${Date.now()}-${Math.random()}`,
        ts: new Date().toISOString()
      })
    });

    if (res.ok) {
      const out = await res.json();

      if (out?.state) {
        applyTelemetry(normalizeTelemetry(out.state));
      }

      pollOnce();
    }
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

  const mode = String(t.mode || "").toLowerCase();
  const autoStart = !!t.autoStart;
  const power = (t.power || (mode === "running" ? "ON" : "OFF")).toUpperCase();

  const amps = t.amps || {};
  const volts = t.volts || {};

  return {
    deviceId: t.deviceId || DEVICE_ID,
    ts: t.ts || new Date().toISOString(),
    mode: mode === "running" ? "running" : "stopped",
    autoStart,
    power,
    amps: {
      r: safeNumOrDash(amps.r),
      y: safeNumOrDash(amps.y),
      b: safeNumOrDash(amps.b)
    },
    volts: {
      r: safeNumOrDash(volts.r),
      y: safeNumOrDash(volts.y),
      b: safeNumOrDash(volts.b)
    }
  };
}

// =====================
// APPLY TO UI
// =====================
function applyTelemetry(input) {
  const t = normalizeTelemetry(input);

  if (t.mode === "running") setStatusBar("RUNNING", "#16a34a");
  else setStatusBar("STOPPED", "#ef4444");

  safeSetText("#txtUpdatedOn", `Updated ON : ${formatTs(t.ts)}`);

  safeSetText("#txtPowerState", t.power);
  safeSetBoxColor("#boxPowerState", t.power === "ON" ? "#16a34a" : "#9ca3af");

  safeSetSwitch("#swAutoStart", t.autoStart);

  safeSetText("#txtAmpsR", t.amps.r);
  safeSetText("#txtAmpsY", t.amps.y);
  safeSetText("#txtAmpsB", t.amps.b);

  safeSetText("#txtVoltR", t.volts.r);
  safeSetText("#txtVoltY", t.volts.y);
  safeSetText("#txtVoltB", t.volts.b);
}

// =====================
// UI HELPERS
// =====================
function safeOnClick(sel, fn) {
  try { $w(sel).onClick(fn); } catch (_) {}
}

function safeOnChange(sel, fn) {
  try { $w(sel).onChange(fn); } catch (_) {}
}

function safeSetText(sel, txt) {
  try { $w(sel).text = String(txt); } catch (_) {}
}

function safeSetBoxColor(sel, color) {
  try { $w(sel).style.backgroundColor = color; } catch (_) {}
}

function safeSetSwitch(sel, val) {
  try {
    if ($w(sel).checked !== val) $w(sel).checked = val;
  } catch (_) {}
}

function setStatusBar(text, color) {
  safeSetText("#txtStatusBar", text);
  safeSetBoxColor("#boxStatusBar", color);
}

// =====================
// UTILITIES
// =====================
function safeNumOrDash(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "--";
  return Math.round(Number(v) * 10) / 10;
}

function formatTs(iso) {
  try { return new Date(iso).toLocaleString(); }
  catch { return String(iso); }
}
