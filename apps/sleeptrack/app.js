/* ========= 0) Disable BLE console & expose only Nordic-UART ========= */
const NUS = "6e400001-B5A3-F393-E0A9-E50E24DCCA9E";
const NUS_RX = "6e400002-B5A3-F393-E0A9-E50E24DCCA9E";
const NUS_TX = "6e400003-B5A3-F393-E0A9-E50E24DCCA9E";

// ⚠️ These two lines must come first, before anything else:
NRF.setServices({
  "6e400001-B5A3-F393-E0A9-E50E24DCCA9E": {
    "6e400002-B5A3-F393-E0A9-E50E24DCCA9E": { write:true, writeWithoutResponse:true },
    "6e400003-B5A3-F393-E0A9-E50E24DCCA9E": { notify:true, descriptor:true }
  }
}, { advertise: [ NUS ]});
NRF.setAdvertising({}, { name:"Bangle-SleepTracker", services:[ NUS ], connectable:true });


/* ========= 1) Bluetooth – Nordic UART ========= *//* ========= 1 ── Nordic UART UUID ========= */
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
  print("⬆️ Sending:", str);    // ← See exactly what's being sent
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

const NUS_SERVICE_UUID = NUS;
const NUS_TX_CHAR_UUID = NUS_TX;

/* ========= 2) Connection state ========= */
var bleConnected = false;
NRF.on("connect",    function() { bleConnected = true;  });
NRF.on("disconnect", function() { bleConnected = false; });

/* ========= 3) JSON line helper ========= */
function sendBLEData(obj) {
  if (!bleConnected) return;
  Bluetooth.write(JSON.stringify(obj) + "\n");
}

/* ========= 4) App state ========= */
Bangle.loadWidgets();
Bangle.drawWidgets();

var hrData         = [];
var motionData     = [];
var sleepData      = [];
var hrWindow       = [];
var motionWindow   = [];
var smoothedHR     = 0;
var smoothedMotion = 0;
var sleepPhaseIdx  = 0;
var lastPhaseIdx   = 0;

var WINDOW_SIZE      = 10;
var SLEEP_BUFFER_MAX = 3600;

var PHASE = { awake:0, light:1, rem:2, deep:3 };
var PHASE_NAMES = ["awake","light","rem","deep"];

var SCORES = {
  awake: { hr:3, motion:3 },
  light: { hr:1, motion:2 },
  rem:   { hr:2, motion:1 },
  deep:  { hr:1, motion:0 }
};

var hrThreshold     = 10;
var motionThreshold = 0.2;
var reportMode      = false;
var gotHR     = false;
var gotMotion = false;

/* ========= 5) Small helpers ========= */
function avg(arr) {
  return arr.length ? arr.reduce(function(a,b){return a+b;},0)/arr.length : 0;
}
function lpf(current, previous, alpha) {
  if (alpha===undefined) alpha=0.1;
  return alpha*current + (1-alpha)*previous;
}
function slide(win, val, size) {
  win.push(val);
  if (win.length>size) win.shift();
  return avg(win);
}

/* ========= 6) Dynamic thresholds ========= */
function optimiseThresholds(){
  if (hrData.length)     hrThreshold     = avg(hrData)*1.2;
  if (motionData.length) motionThreshold = avg(motionData)*1.2;
  hrData = [];
  motionData = [];
  if (global.gc) global.gc();
}
setInterval(optimiseThresholds, 60000);

/* ========= 7) Sleep classification ========= */
function classifySleep(hr, m) {
  var score = {
    awake: SCORES.awake.hr*(hr>hrThreshold)   + SCORES.awake.motion*(m>motionThreshold),
    light: SCORES.light.hr*(hr>hrThreshold)   + SCORES.light.motion*(m<=motionThreshold),
    rem:   SCORES.rem.hr*(hr<=hrThreshold)    + SCORES.rem.motion*(m<=motionThreshold),
    deep:  SCORES.deep.hr*(hr<=hrThreshold/2)+ SCORES.deep.motion*(m<motionThreshold/2)
  };
  var best = "awake";
  Object.keys(score).forEach(function(k){
    if (score[k]>score[best]) best=k;
  });
  if (best==="rem" && lastPhaseIdx!==PHASE.light) best="light";
  lastPhaseIdx = PHASE[best];
  return PHASE[best];
}

/* ========= 8) Storage ========= */
function saveSleepData(){
  var key = (new Date()).toISOString().slice(0,10);
  var store = require("Storage");
  var json = store.readJSON("sleepdata.json",1)||{};
  json[key]=sleepData;
  store.write("sleepdata.json", json);
  if (store.compact) store.compact();
}

/* ========= 9) Display helpers ========= */
function displayData(){
  var HRtxt  = gotHR     ? Math.round(smoothedHR) : "--";
  var Motxt  = gotMotion ? (Math.round(smoothedMotion*100)/100).toFixed(2) : "--";
  var Phaset = gotHR&&gotMotion ? PHASE_NAMES[sleepPhaseIdx] : "Waiting…";

  g.clear();
  g.setFont("6x8",2); g.setFontAlign(0,0);
  g.drawString("Sleep Tracker",g.getWidth()/2,20);
  g.setFont("6x8",1);
  g.drawString("HR: "+HRtxt,   g.getWidth()/2,50);
  g.drawString("Motion: "+Motxt,g.getWidth()/2,70);
  g.drawString("Phase: "+Phaset,g.getWidth()/2,90);
  g.drawString("BTN1: Exit",   g.getWidth()/2,g.getHeight()-20);
  g.flip();
}
function displayReport(){
  g.clear();
  g.setFont("6x8",2); g.setFontAlign(0,0);
  g.drawString("Sleep Report", g.getWidth()/2,20);
  if (!sleepData.length) {
    g.setFont("6x8",1);
    g.drawString("No data yet!",g.getWidth()/2,g.getHeight()/2);
    g.flip(); return;
  }
  var count=[0,0,0,0];
  sleepData.forEach(function(e){count[e.phase]++;});
  var tot=sleepData.length;
  function pct(i){return Math.round(count[i]/tot*100);}
  g.setFont("6x8",1);
  g.drawString("Awake: "+pct(PHASE.awake)+"%",g.getWidth()/2,50);
  g.drawString("Light: "+pct(PHASE.light)+"%",g.getWidth()/2,70);
  g.drawString("REM:   "+pct(PHASE.rem)+"%",  g.getWidth()/2,90);
  g.drawString("Deep:  "+pct(PHASE.deep)+"%", g.getWidth()/2,110);
  var tip="Tip: Keep a steady bedtime!";
  if (pct(PHASE.awake)>30) tip="Tip: Wind down to reduce awakenings.";
  else if (pct(PHASE.deep)<20) tip="Tip: Dark, cool room boosts deep sleep.";
  g.drawString(tip,g.getWidth()/2,g.getHeight()-30);
  g.flip();
}

/* ========= 10) Sensors ========= */
function startHRM(){
  Bangle.setHRMPower(1,"sleep");
  var last=0;
  Bangle.on("HRM",function(h){
    if (h.confidence>80){
      gotHR=true;
      var f=lpf(h.bpm,last); last=f;
      smoothedHR=slide(hrWindow,f,WINDOW_SIZE);
      hrData.push(f);
    }
  });
}
function startAccelerometer(){
  Bangle.setPollInterval(200);
  var prev=0;
  Bangle.on("accel",function(a){
    if (!gotMotion) gotMotion=true;
    var m0=Math.sqrt(a.x*a.x+a.y*a.y+a.z*a.z)-1;
    var f=lpf(m0,prev); prev=f;
    smoothedMotion=slide(motionWindow,f,WINDOW_SIZE);
    motionData.push(f);
  });
}

/* ========= 11) Main loops ========= */
function startClassification(){
  setInterval(function(){
    if (!gotHR||!gotMotion){
      sleepPhaseIdx=PHASE.awake;
      if(!reportMode) displayData();
      return;
    }
    sleepPhaseIdx=classifySleep(smoothedHR,smoothedMotion);
    var rec={
      t:Math.round(Date.now()/1000),
      hr:smoothedHR,
      m:smoothedMotion,
      phase:sleepPhaseIdx
    };
    if(sleepData.length>=SLEEP_BUFFER_MAX) sleepData.shift();
    sleepData.push(rec);
    sendBLEData({t:rec.t,hr:rec.hr,m:rec.m,phase:PHASE_NAMES[rec.phase]});
    if(!reportMode) displayData();
  },1000);
}
function startThresholdOptimiser(){
  setInterval(optimiseThresholds,60000);
}

/* ========= 12) House-keeping ========= */
function stopSensors(){
  Bangle.setHRMPower(0,"sleep");
  Bangle.removeAllListeners("HRM");
  Bangle.removeAllListeners("accel");
}
function toggleReport(){
  reportMode=!reportMode;
  if (reportMode) displayReport(); else displayData();
}
function exitApp(){
  stopSensors();
  saveSleepData();
  NRF.disconnect();
  load();
}
setWatch(exitApp,BTN1,{repeat:false,edge:"rising"});
setWatch(toggleReport,BTN2,{repeat:true,edge:"rising"});

/* ========= 13) Boot screen & go ========= */
g.clear();
g.setFont("6x8",2); g.setFontAlign(0,0);
g.drawString("Starting Sleep Tracker",g.getWidth()/2,g.getHeight()/2);
g.flip();
startHRM(); startAccelerometer(); startClassification(); startThresholdOptimiser();
