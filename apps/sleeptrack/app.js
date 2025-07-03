/* ========= 1  Bluetooth – Nordic UART (unchanged) ========= */
const NUS_SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
const NUS_TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";

/* ========= 2  Connection state & advertising ========= */
let bleConnected = false;
NRF.on("connect",   function () { bleConnected = true;  });
NRF.on("disconnect",function () { bleConnected = false; });

// Make the watch easy to spot in any scanner
NRF.setAdvertising(
  {},                                    // built‑in UART service data
  { name : "Bangle-SleepTracker",
    connectable : true }                 // keep advertising even when idle
);

/* ========= 3  JSON line helper ========= */
function sendBLEData(obj){
  if (!bleConnected) return;
  Bluetooth.println(JSON.stringify(obj));        // auto‑chunks to 20 B
}

/* ========= 4  App state ========= */
Bangle.loadWidgets();
Bangle.drawWidgets();

let hrData         = [];
let motionData     = [];
let sleepData      = [];          // ring buffer (max SLEEP_BUFFER_MAX)
let hrWindow       = [];
let motionWindow   = [];
let smoothedHR     = 0;
let smoothedMotion = 0;
let sleepPhaseIdx  = 0;           // numeric index into PHASE_NAMES
let lastPhaseIdx   = 0;

const WINDOW_SIZE        = 10;
const SLEEP_BUFFER_MAX   = 3600;  // keep at most 1 h of records in RAM

/*  Phase constants so we store ints, not strings  */
const PHASE = { awake:0, light:1, rem:2, deep:3 };
const PHASE_NAMES = ["awake","light","rem","deep"];

const SCORES = {
  awake : { hr:3, motion:3 },
  light : { hr:1, motion:2 },
  rem   : { hr:2, motion:1 },
  deep  : { hr:1, motion:0 },
};

let hrThreshold     = 10;
let motionThreshold = 0.2;
let reportMode      = false;

/*  Sensor ready flags – we wait for both before classifying */
let gotHR = false;
let gotMotion = false;

/* ========= 5  Small helpers ========= */
function avg(arr){
  return arr.length ? arr.reduce((a,b)=>a+b) / arr.length : 0;
}
function lpf(current, previous, alpha){
  if (alpha === undefined) alpha = 0.1;
  return alpha*current + (1-alpha)*previous;
}
function slide(win, val, size){
  win.push(val);
  if (win.length > size) win.shift();
  return avg(win);
}

/* ========= 6  Dynamic thresholds ========= */
function optimiseThresholds(){
  if (hrData.length)     hrThreshold     = avg(hrData)*1.2;
  if (motionData.length) motionThreshold = avg(motionData)*1.2;
  // Replace arrays so the underlying storage can be GC'd
  hrData = [];
  motionData = [];
  if (global.gc) global.gc();       // force GC on Espruino
}

/* ========= 7  Sleep classification ========= */
function classifySleep(hr, m){
  const score = {
    awake : SCORES.awake.hr *(hr>hrThreshold)      + SCORES.awake.motion *(m> motionThreshold),
    light : SCORES.light.hr *(hr>hrThreshold)      + SCORES.light.motion*(m<=motionThreshold),
    rem   : SCORES.rem.hr  *(hr<=hrThreshold)      + SCORES.rem.motion  *(m<=motionThreshold),
    deep  : SCORES.deep.hr *(hr<=hrThreshold/2)    + SCORES.deep.motion *(m< motionThreshold/2),
  };
  let phaseName = "awake";
  Object.keys(score).forEach(k=>{ if(score[k]>score[phaseName]) phaseName=k; });
  // REM only if coming from light
  if (phaseName==="rem" && lastPhaseIdx!==PHASE.light) phaseName="light";
  lastPhaseIdx = PHASE[phaseName];
  return PHASE[phaseName];
}

/* ========= 8  Storage ========= */
function saveSleepData(){
  const key = (new Date).toISOString().slice(0,10);   // YYYY-MM-DD
  const store = require("Storage");
  let json = store.readJSON("sleepdata.json",1) || {};
  json[key] = sleepData;
  store.write("sleepdata.json", json);
  if (store.compact) store.compact();
}

/* ========= 9  Display helpers ========= */
function displayData(){
  const HRtxt  = gotHR    ? Math.round(smoothedHR) : "--";
  const Motxt  = gotMotion? (Math.round(smoothedMotion*100)/100).toFixed(2) : "--";
  const Phaset = gotHR && gotMotion ? PHASE_NAMES[sleepPhaseIdx] : "Waiting…";

  g.clear();
  g.setFont("6x8",2); g.setFontAlign(0,0);
  g.drawString("Sleep Tracker", g.getWidth()/2, 20);
  g.setFont("6x8",1);
  g.drawString("HR: "+HRtxt,      g.getWidth()/2, 50);
  g.drawString("Motion: "+Motxt,  g.getWidth()/2, 70);
  g.drawString("Phase: "+Phaset,  g.getWidth()/2, 90);
  g.drawString("BTN1: Exit",      g.getWidth()/2, g.getHeight()-20);
  g.flip();
}

function displayReport(){
  g.clear();
  g.setFont("6x8",2); g.setFontAlign(0,0);
  g.drawString("Sleep Report", g.getWidth()/2, 20);

  if (!sleepData.length){
    g.setFont("6x8",1);
    g.drawString("No data yet!", g.getWidth()/2, g.getHeight()/2);
    g.flip(); return;
  }

  const count = [0,0,0,0]; // awake, light, rem, deep
  sleepData.forEach(e=>{ count[e.phase]++; });
  const tot = sleepData.length;
  const pct = i=> Math.round(count[i]/tot*100);

  g.setFont("6x8",1);
  g.drawString("Awake: "+pct(PHASE.awake)+"%", g.getWidth()/2, 50);
  g.drawString("Light: "+pct(PHASE.light)+"%", g.getWidth()/2, 70);
  g.drawString("REM:   "+pct(PHASE.rem)+"%",  g.getWidth()/2, 90);
  g.drawString("Deep:  "+pct(PHASE.deep)+"%", g.getWidth()/2,110);

  let tip = "Tip: Keep a steady bedtime!";
  if      (pct(PHASE.awake)>30) tip="Tip: Wind down to reduce awakenings.";
  else if (pct(PHASE.deep) <20) tip="Tip: Dark, cool room boosts deep sleep.";
  g.drawString(tip, g.getWidth()/2, g.getHeight()-30);
  g.flip();
}

/* ========= 10  Sensors ========= */
function startHRM(){
  Bangle.setHRMPower(1,"sleep");
  let last = 0;
  Bangle.on("HRM", function(h){
    smoothedHR = h.bpm;                         // always visible
    if (h.confidence > 50){                     // looser gate
      gotHR = true;
      const f = lpf(h.bpm, last);  last = f;
      smoothedHR = slide(hrWindow, f, WINDOW_SIZE);
      hrData.push(f);
    }
  });
}

function startAccelerometer(){
  Bangle.setPollInterval(200); // ~5 Hz to save memory
  let prev = 0;
  Bangle.on("accel", function(a){
    gotMotion = true;
    let m = Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z) - 1;
    m = lpf(m, prev);  prev = m;
    smoothedMotion = slide(motionWindow, m, WINDOW_SIZE);
    motionData.push(m);
  });
}

/* ========= 11  Main loops ========= */
function startClassification(){
  setInterval(function(){
    if (!gotHR || !gotMotion){
      sleepPhaseIdx = PHASE.awake;
      if (!reportMode) displayData();
      return;
    }
    sleepPhaseIdx = classifySleep(smoothedHR, smoothedMotion);
    const rec = { t:Math.round(Date.now()/1000), hr:smoothedHR, m:smoothedMotion, phase:sleepPhaseIdx };

    // ring buffer behaviour
    if (sleepData.length >= SLEEP_BUFFER_MAX) sleepData.shift();
    sleepData.push(rec);

    // send over BLE using readable string
    sendBLEData({t:rec.t, hr:rec.hr, m:rec.m, phase:PHASE_NAMES[rec.phase]});

    if (!reportMode) displayData();
  }, 1000);
}
function startThresholdOptimiser(){
  setInterval(optimiseThresholds, 60000);
}

/* ========= 12  House‑keeping ========= */
function stopSensors(){
  Bangle.setHRMPower(0,"sleep");
  Bangle.removeAllListeners("HRM");
  Bangle.removeAllListeners("accel");
}
function toggleReport(){
  reportMode = !reportMode;
  if (reportMode) displayReport(); else displayData();
}
function exitApp(){
  stopSensors();
  saveSleepData();
  NRF.disconnect();            // ensure BLE buffers released
  load();                      // return to launcher
}

/* ========= 13  Buttons ========= */
setWatch(exitApp,     BTN1, { repeat:false, edge:"rising" });
setWatch(toggleReport, BTN2, { repeat:true,  edge:"rising" });

/* ========= 14  Boot screen & go ========= */
g.clear();
g.setFont("6x8",2); g.setFontAlign(0,0);
g.drawString("Starting Sleep Tracker", g.getWidth()/2, g.getHeight()/2);
g.flip();

startHRM();
startAccelerometer();
startClassification();
startThresholdOptimiser();
