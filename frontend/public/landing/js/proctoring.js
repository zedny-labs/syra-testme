/* ============================================================
   VAR EXAM — Chapter 6 AI Proctoring simulation
   Scroll-driven: window.__proctor.setLocal(p, active) maps the
   chapter's local progress (0..1) to 7 detection events.
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const feed = $("feed");
  const subject = $("subject");
  const trackMesh = $("trackMesh");
  const intruder = $("intruder");
  const phoneObj = $("phoneObj");
  const gaze = $("gaze");
  const audioWave = $("audioWave");
  const intruderBox = $("intruderBox");
  const phoneBox = $("phoneBox");
  const monitors = {};
  document.querySelectorAll(".mon-module").forEach((m) => (monitors[m.dataset.mon] = m));
  const logItems = $("logItems");
  const logCount = $("logCount");
  const feedTimer = $("feedTimer");
  const integrityArc = $("integrityArc");
  const integrityNum = $("integrityNum");

  // build face-tracking mesh points
  // build the AI face-recognition mesh (proctor webcam — compact vector, live)
  if (trackMesh && window.VARFaceMesh) window.VARFaceMesh(trackMesh, { detail: "compact", head: false });
  // Verify uses the real biometric face image (see .face-mesh CSS) — no vector build.

  // focus-lost overlay (created dynamically)
  const focusLost = document.createElement("div");
  focusLost.style.cssText =
    "position:absolute;inset:0;z-index:9;display:flex;align-items:center;justify-content:center;" +
    "font-family:var(--font-mono);font-size:13px;letter-spacing:0.3em;text-transform:uppercase;color:#ff3b4e;" +
    "background:rgba(5,5,5,0.74);opacity:0;transition:opacity .35s;pointer-events:none;";
  focusLost.textContent = "⚠ Focus Lost — Window Switched";
  if (feed) feed.appendChild(focusLost);

  // timer pulse for fast-completion
  const timerWarn = document.createElement("div");
  timerWarn.style.cssText =
    "position:absolute;right:12px;top:36px;z-index:9;font-family:var(--font-mono);font-size:10px;" +
    "letter-spacing:.1em;color:#ffd700;opacity:0;transition:opacity .35s;";
  timerWarn.textContent = "⚡ Pace 4.2× expected";
  if (feed) feed.appendChild(timerWarn);

  // ---------------- Events ----------------
  const EVENTS = [
    { key: "eye", sev: "warn", hit: 4, label: "Gaze repeatedly off-screen", title: "Eye Tracking" },
    { key: "behavior", sev: "warn", hit: 5, label: "Suspicious head movement", title: "Head Movement" },
    { key: "audio", sev: "warn", hit: 6, label: "Voice activity detected", title: "Voice Detection" },
    { key: "camera", sev: "crit", hit: 12, label: "Multiple persons detected", title: "Multi-Person" },
    { key: "camera", sev: "crit", hit: 11, label: "Unauthorized device detected", title: "Phone Detection" },
    { key: "browser", sev: "crit", hit: 9, label: "Focus lost — tab switch", title: "Focus Lost" },
    { key: "behavior", sev: "warn", hit: 5, label: "Suspicious completion speed", title: "Pace Anomaly" },
  ];

  const START = 0.08;
  const END = 0.74;
  const BAND = (END - START) / EVENTS.length;

  let maxStage = -1; // highest event index reached (for log accumulation)
  let lastShownStage = -99; // guard: only re-render overlays when stage changes
  let score = 100;
  const CIRC = 2 * Math.PI * 52;

  function clearOverlays() {
    subject.classList.remove("turn");
    trackMesh.classList.remove("warn");
    intruder.classList.remove("show");
    phoneObj.classList.remove("show");
    gaze.classList.remove("show");
    audioWave.classList.remove("show");
    intruderBox.classList.remove("show");
    phoneBox.classList.remove("show");
    focusLost.style.opacity = "0";
    timerWarn.style.opacity = "0";
    Object.values(monitors).forEach((m) => m.classList.remove("alert"));
  }

  function showStageOverlay(stage) {
    clearOverlays();
    if (stage < 0) return;
    const ev = EVENTS[stage];
    if (monitors[ev.key]) monitors[ev.key].classList.add("alert");
    switch (stage) {
      case 0: gaze.classList.add("show"); trackMesh.classList.add("warn"); break;
      case 1: subject.classList.add("turn"); trackMesh.classList.add("warn"); break;
      case 2: audioWave.classList.add("show"); break;
      case 3: intruder.classList.add("show"); intruderBox.classList.add("show"); break;
      case 4: phoneObj.classList.add("show"); phoneBox.classList.add("show"); break;
      case 5: focusLost.style.opacity = "1"; break;
      case 6: timerWarn.style.opacity = "1"; break;
    }
  }

  function setScore(s) {
    score = Math.max(0, Math.round(s));
    integrityNum.textContent = score;
    integrityArc.style.strokeDashoffset = (CIRC * (1 - score / 100)).toFixed(1);
    // recolor ring by score
    const col = score > 85 ? "#00ffff" : score > 65 ? "#ffd700" : "#ff3b4e";
    integrityArc.setAttribute("stroke", col);
  }

  function logEvent(stage) {
    const ev = EVENTS[stage];
    const row = document.createElement("div");
    row.className = "log-row " + ev.sev;
    const t = formatTime(START + stage * BAND);
    row.innerHTML =
      '<span class="sev"></span><span class="t">' + t + '</span>' +
      '<span class="msg">' + ev.label + "</span>";
    logItems.appendChild(row);
    requestAnimationFrame(() => row.classList.add("show"));
    logCount.textContent = logItems.children.length;
    // integrity hit
    setScore(score - ev.hit);
    // feed flash + tunnel alert
    feed.classList.remove("flash");
    void feed.offsetWidth;
    feed.classList.add("flash");
    if (window.__journey) window.__journey.alert = ev.sev === "crit" ? 1 : 0.55;
  }

  function reset() {
    maxStage = -1;
    lastShownStage = -99;
    score = 100;
    setScore(100);
    logItems.innerHTML = "";
    logCount.textContent = "0";
    clearOverlays();
  }

  function formatTime(local) {
    const total = Math.floor(local * 47); // ~47s window
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return m + ":" + s;
  }

  // ---------------- Public API ----------------
  window.__proctor = {
    setLocal(local, active) {
      if (!active) return;
      feedTimer.textContent = formatTime(local);

      if (local < START - 0.02) {
        if (maxStage !== -1) reset();
        if (lastShownStage !== -1) { showStageOverlay(-1); lastShownStage = -1; }
        return;
      }
      let stage = Math.floor((local - START) / BAND);
      stage = Math.max(0, Math.min(EVENTS.length - 1, stage));

      // log any newly-reached stages
      while (maxStage < stage) {
        maxStage++;
        logEvent(maxStage);
      }
      // only re-render overlays when the stage actually changes (avoid
      // restarting CSS transitions every scroll frame)
      if (stage !== lastShownStage) {
        showStageOverlay(stage);
        lastShownStage = stage;
      }
    },
    reset,
  };

  setScore(100);
})();
