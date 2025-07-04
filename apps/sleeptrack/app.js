/* ========= 1 ── Nordic UART UUID ========= */
const NUS_SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
const NUS_TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

/* ========= 2 ── Connection state & advertising ========= */
let bleConnected = false;

NRF.on("connect", function () {
  bleConnected = true;
  print("✅ BLE connected");
});

NRF.on("disconnect", function () {
  bleConnected = false;
  print("🔌 BLE disconnected");
});

// Advertise UART with friendly name
NRF.setAdvertising(
  {},
  {
    name: "Bangle-SleepTracker",
    connectable: true
  }
);

/* ========= 3 ── JSON line helper ========= */
function sendBLEData(obj) {
  if (!bleConnected) {
    print("⚠️ Not connected, skip send:", JSON.stringify(obj));
    return;
  }
  const str = JSON.stringify(obj);
  print("⬆️ Sending:", str);    // ← See exactly what’s being sent
  Bluetooth.println(str);        // ← This always sends with a newline!
}

/* ========= 4 ── Debug ping every 8 s ========= */
setInterval(() => {
  sendBLEData({ debug: "ping", t: Math.round(Date.now() / 1000) });
}, 8000);

/* ========= 5 ── Widgets & basic state ========= */
Bangle.loadWidgets();
Bangle.drawWidgets();

let hrData = [];
let motionData = [];
let sleepData = [];
let hrWindow = [];
let motionWindow = [];
let smoothedHR = 0;
let smoothedMotion = 0;
let sleepPhaseIdx = 0;
let lastPhaseIdx = 0;

const WINDOW_SIZE = 10;
const SLEEP_BUFFER_MAX = 3600;

const PHASE = { awake: 0, light: 1, rem: 2, deep: 3 };
const PHASE_NAMES = ["awake", "light", "rem", "deep"];

const SCORES = {
  awake: { hr: 3, motion: 3 },
  light: { hr: 1, motion: 2 },
  rem: { hr: 2, motion: 1 },
  deep: { hr: 1, motion: 0 },
};

let hrThreshold = 10;
let motionThreshold = 0.2;
let reportMode = false;

let gotHR = false;
let gotMotion = false;

/* ========= 6 ── Small helpers ========= */
function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b) / arr.length : 0;
}
function lpf(current, previous, alpha) {
  if (alpha === undefined) alpha = 0.1;
  return alpha * current + (1 - alpha) * previous;
}
function slide(win, val, size) {
  win.push(val);
  if (win.length > size) win.shift();
  return avg(win);
}

/* ========= 7 ── Dynamic thresholds ========= */
function optimiseThresholds() {
  if (hrData.length) hrThreshold = avg(hrData) * 1.2;
  if (motionData.length) motionThreshold = avg(motionData) * 1.2;
  hrData = [];
  motionData = [];
  if (global.gc) global.gc();
  print("🔧 Thresholds updated:", hrThreshold, motionThreshold);
}

/* ========= 8 ── Sleep classification ========= */
function classifySleep(hr, m) {
  const score = {
    awake: SCORES.awake.hr * (hr > hrThreshold) + SCORES.awake.motion * (m > motionThreshold),
    light: SCORES.light.hr * (hr > hrThreshold) + SCORES.light.motion * (m <= motionThreshold),
    rem: SCORES.rem.hr * (hr <= hrThreshold) + SCORES.rem.motion * (m <= motionThreshold),
    deep: SCORES.deep.hr * (hr <= hrThreshold / 2) + SCORES.deep.motion * (m < motionThreshold / 2),
  };

  let phaseName = "awake";
  Object.keys(score).forEach(k => { if (score[k] > score[phaseName]) phaseName = k; });
  if (phaseName === "rem" && lastPhaseIdx !== PHASE.light) phaseName = "light";
  lastPhaseIdx = PHASE[phaseName];
  return PHASE[phaseName];
}

/* ========= 9 ── Storage ========= */
function saveSleepData() {
  const key = (new Date).toISOString().slice(0, 10);
  const store = require("Storage");
  let json = store.readJSON("sleepdata.json", 1) || {};
  json[key] = sleepData;
  store.write("sleepdata.json", json);
  if (store.compact) store.compact();
  print("💾 Sleep data saved");
}

/* ========= 10 ── Display helpers ========= */
function displayData() {
  const HRtxt = gotHR ? Math.round(smoothedHR) : "--";
  const Motxt = gotMotion ? (Math.round(smoothedMotion * 100) / 100).toFixed(2) : "--";
  const Phaset = gotHR && gotMotion ? PHASE_NAMES[sleepPhaseIdx] : "Waiting…";

  g.clear();
  g.setFont("6x8", 2); g.setFontAlign(0, 0);
  g.drawString("Sleep Tracker", g.getWidth() / 2, 20);
  g.setFont("6x8", 1);
  g.drawString("HR: " + HRtxt, g.getWidth() / 2, 50);
  g.drawString("Motion: " + Motxt, g.getWidth() / 2, 70);
  g.drawString("Phase: " + Phaset, g.getWidth() / 2, 90);
  g.drawString("BTN1: Exit", g.getWidth() / 2, g.getHeight() - 20);
  g.flip();
}

/* ========= 11 ── Sensors ========= */
function startHRM() {
  Bangle.setHRMPower(1, "sleep");
  let last = 0;
  Bangle.on("HRM", function (h) {
    smoothedHR = h.bpm;
    if (h.confidence > 50) {
      gotHR = true;
      const f = lpf(h.bpm, last); last = f;
      smoothedHR = slide(hrWindow, f, WINDOW_SIZE);
      hrData.push(f);
    }
  });
}

function startAccelerometer() {
  Bangle.setPollInterval(200);
  let prev = 0;
  Bangle.on("accel", function (a) {
    gotMotion = true;
    let m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) - 1;
    m = lpf(m, prev); prev = m;
    smoothedMotion = slide(motionWindow, m, WINDOW_SIZE);
    motionData.push(m);
  });
}

/* ========= 12 ── Main classification loop ========= */
function startClassification() {
  setInterval(function () {
    if (!gotHR || !gotMotion) {
      sleepPhaseIdx = PHASE.awake;
      displayData();
      return;
    }

    sleepPhaseIdx = classifySleep(smoothedHR, smoothedMotion);
    const rec = {
      t: Math.round(Date.now() / 1000),
      hr: smoothedHR,
      m: smoothedMotion,
      phase: sleepPhaseIdx
    };

    if (sleepData.length >= SLEEP_BUFFER_MAX) sleepData.shift();
    sleepData.push(rec);

    sendBLEData({
      t: rec.t,
      hr: rec.hr,
      m: rec.m,
      phase: PHASE_NAMES[rec.phase]
    });

    displayData();
  }, 1000);
}

function startThresholdOptimiser() {
  setInterval(optimiseThresholds, 60000);
}

/* ========= 13 ── Housekeeping ========= */
function stopSensors() {
  Bangle.setHRMPower(0, "sleep");
  Bangle.removeAllListeners("HRM");
  Bangle.removeAllListeners("accel");
}

function toggleReport() {
  reportMode = !reportMode;
  if (reportMode) displayReport();
  else displayData();
}

function exitApp() {
  stopSensors();
  saveSleepData();
  NRF.disconnect();
  load();
}

setWatch(exitApp, BTN1, { repeat: false, edge: "rising" });
setWatch(toggleReport, BTN2, { repeat: true, edge: "rising" });

/* ========= 14 ── Boot screen & start ========= */
g.clear();
g.setFont("6x8", 2); g.setFontAlign(0, 0);
g.drawString("Starting Sleep Tracker", g.getWidth() / 2, g.getHeight() / 2);
g.flip();

print("🚀 Sleep Tracker started!");

startHRM();
startAccelerometer();
startClassification();
startThresholdOptimiser();
