/* ========= 0  Disable BLE-console & expose only Nordic UART ========= */
const NUS = "6e400001-B5A3-F393-E0A9-E50E24DCCA9E";
const RX = "6e400002-B5A3-F393-E0A9-E50E24DCCA9E";
const TX = "6e400003-B5A3-F393-E0A9-E50E24DCCA9E";

NRF.setServices({
  "6e400001-B5A3-F393-E0A9-E50E24DCCA9E": {
    "6e400002-B5A3-F393-E0A9-E50E24DCCA9E": { write:true, writeWithoutResponse:true },
    "6e400003-B5A3-F393-E0A9-E50E24DCCA9E": { notify:true, descriptor:true }
  }
}, {
  advertise: [ "6e400001-B5A3-F393-E0A9-E50E24DCCA9E" ]
});

NRF.setAdvertising(
  {},
  { name: "Bangle-SleepTracker",
    services: [ "6e400001-B5A3-F393-E0A9-E50E24DCCA9E" ],
    connectable: true
  }
);


/* ========= 1  Connection state ========= */
var bleConnected = false;
NRF.on("connect", function() { bleConnected = true; });
NRF.on("disconnect", function() { bleConnected = false; });

/* ========= 2  JSON-over-UART helper ========= */
function sendBLEData(obj) {
  if (!bleConnected) return;
  Bluetooth.write(JSON.stringify(obj) + "\n");
}

/* ========= 3  App state & setup ========= */
Bangle.loadWidgets();
Bangle.drawWidgets();

var hrData       = [];
var motionData   = [];
var sleepData    = [];
var hrWindow     = [];
var motionWindow = [];
var smoothedHR   = 0;
var smoothedMotion = 0;
var sleepPhaseIdx = 0;
var lastPhaseIdx  = 0;

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

/* ========= 4  Helpers ========= */
function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce(function(a,b){return a+b;},0)/arr.length;
}
function lpf(current, previous, alpha) {
  if (alpha === undefined) alpha = 0.1;
  return alpha*current + (1-alpha)*previous;
}
function slide(win, val, size) {
  win.push(val);
  if (win.length > size) win.shift();
  return avg(win);
}

/* ========= 5  Dynamic thresholds ========= */
function optimiseThresholds() {
  if (hrData.length)     hrThreshold     = avg(hrData)*1.2;
  if (motionData.length) motionThreshold = avg(motionData)*1.2;
  hrData = [];
  motionData = [];
  if (global.gc) global.gc();
}
setInterval(optimiseThresholds, 60000);

/* ========= 6  Sleep classification ========= */
function classifySleep(hr, m) {
  var score = {
    awake: SCORES.awake.hr*(hr>hrThreshold)
         + SCORES.awake.motion*(m>motionThreshold),
    light: SCORES.light.hr*(hr>hrThreshold)
         + SCORES.light.motion*(m<=motionThreshold),
    rem:   SCORES.rem.hr*(hr<=hrThreshold)
         + SCORES.rem.motion*(m<=motionThreshold),
    deep:  SCORES.deep.hr*(hr<=hrThreshold/2)
         + SCORES.deep.motion*(m<motionThreshold/2)
  };
  var best = "awake";
  Object.keys(score).forEach(function(k){
    if (score[k] > score[best]) best = k;
  });
  if (best==="rem" && lastPhaseIdx!==PHASE.light) best="light";
  lastPhaseIdx = PHASE[best];
  return PHASE[best];
}

/* ========= 7  Storage ========= */
function saveSleepData(){
  var key = (new Date()).toISOString().slice(0,10);
  var store = require("Storage");
  var json = store.readJSON("sleepdata.json",1) || {};
  json[key] = sleepData;
  store.write("sleepdata.json", json);
  if (store.compact) store.compact();
}

/* ========= 8  Display ========= */
function displayData(){
  var HRtxt  = gotHR     ? Math.round(smoothedHR) : "--";
  var Motxt  = gotMotion ? (Math.round(smoothedMotion*100)/100).toFixed(2) : "--";
  var Phaset = (gotHR&&gotMotion) ? PHASE_NAMES[sleepPhaseIdx] : "Waiting…";

  g.clear();
  g.setFont("6x8",2); g.setFontAlign(0,0);
  g.drawString("Sleep Tracker", g.getWidth()/2, 20);
  g.setFont("6x8",1);
  g.drawString("HR: "+HRtxt,     g.getWidth()/2, 50);
  g.drawString("Motion: "+Motxt, g.getWidth()/2, 70);
  g.drawString("Phase: "+Phaset, g.getWidth()/2, 90);
  g.drawString("BTN1: Exit",     g.getWidth()/2, g.getHeight()-20);
  g.flip();
}
function displayReport(){
  g.clear();
  g.setFont("6x8",2); g.setFontAlign(0,0);
  g.drawString("Sleep Report", g.getWidth()/2, 20);
  if (!sleepData.length) {
    g.setFont("6x8",1);
    g.drawString("No data yet!", g.getWidth()/2, g.getHeight()/2);
    g.flip(); return;
  }
  var count=[0,0,0,0];
  sleepData.forEach(function(e){ count[e.phase]++; });
  var tot = sleepData.length;
  function pct(i){return Math.round(count[i]/tot*100);}
  g.setFont("6x8",1);
  g.drawString("Awake: "+pct(PHASE.awake)+"%", g.getWidth()/2, 50);
  g.drawString("Light: "+pct(PHASE.light)+"%", g.getWidth()/2, 70);
  g.drawString("REM:   "+pct(PHASE.rem)+"%",   g.getWidth()/2, 90);
  g.drawString("Deep:  "+pct(PHASE.deep)+"%",  g.getWidth()/2,110);
  var tip="Tip: Keep a steady bedtime!";
  if (pct(PHASE.awake)>30) tip="Tip: Wind down to reduce awakenings.";
  else if (pct(PHASE.deep)<20) tip="Tip: Dark, cool room boosts deep sleep.";
  g.drawString(tip, g.getWidth()/2, g.getHeight()-30);
  g.flip();
}

/* ========= 9  Sensors ========= */
function startHRM(){
  Bangle.setHRMPower(1,"sleep");
  var last=0;
  Bangle.on("HRM", function(h){
    if (h.confidence>80) {
      gotHR=true;
      var f = lpf(h.bpm,last); last=f;
      smoothedHR = slide(hrWindow,f,WINDOW_SIZE);
      hrData.push(f);
    }
  });
}
function startAccelerometer(){
  Bangle.setPollInterval(200);
  var prev=0;
  Bangle.on("accel", function(a){
    if (!gotMotion) gotMotion=true;
    var m0=Math.sqrt(a.x*a.x+a.y*a.y+a.z*a.z)-1;
    var f=lpf(m0,prev); prev=f;
    smoothedMotion=slide(motionWindow,f,WINDOW_SIZE);
    motionData.push(f);
  });
}

/* ========= 10  Main loop (after BLE connect) ========= */
function startClassification(){
  setInterval(function(){
    if (!gotHR||!gotMotion) {
      sleepPhaseIdx=PHASE.awake;
      if (!reportMode) displayData();
      return;
    }
    sleepPhaseIdx = classifySleep(smoothedHR, smoothedMotion);
    var rec = {
      t: Math.round(Date.now()/1000),
      hr: smoothedHR,
      m: smoothedMotion,
      phase: sleepPhaseIdx
    };
    if (sleepData.length>=SLEEP_BUFFER_MAX) sleepData.shift();
    sleepData.push(rec);
    sendBLEData({t:rec.t, hr:rec.hr, m:rec.m, phase:PHASE_NAMES[rec.phase]});
    if (!reportMode) displayData();
  },1000);
}
function startThresholdOptimiser(){
  setInterval(optimiseThresholds,60000);
}

/* ========= 11  Buttons & housekeeping ========= */
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
  NRF.disconnect();
  load();
}
setWatch(exitApp, BTN1, {repeat:false,edge:"rising"});
setWatch(toggleReport, BTN2,{repeat:true,edge:"rising"});

/* ========= 12  Boot screen & start ========= */
g.clear();
g.setFont("6x8",2); g.setFontAlign(0,0);
g.drawString("Starting Sleep Tracker", g.getWidth()/2, g.getHeight()/2);
g.flip();
startHRM();
startAccelerometer();
startClassification();
startThresholdOptimiser();
