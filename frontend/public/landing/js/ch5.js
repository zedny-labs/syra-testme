/* ============================================================
   VAR EXAM — Chapter 5 sequential secure-entry verification
   Scroll-driven: window.__entry.setLocal(local, active) walks
   five checks pending -> active(running) -> verified, fills a
   progress rail, and resolves to an "Environment Secured" state.
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const STEPS = [
    { key: "face", label: "Face Verification", done: "Face Verified" },
    { key: "camera", label: "Camera Check", done: "Camera Active" },
    { key: "mic", label: "Microphone Check", done: "Microphone Active" },
    { key: "browser", label: "Browser Lock", done: "Browser Locked" },
    { key: "env", label: "Environment Scan", done: "Environment Approved" },
  ];

  const items = [...document.querySelectorAll("#checklist .entry-item")];
  const stages = {};
  document.querySelectorAll("#entryStage .estage").forEach((s) => (stages[s.dataset.stage] = s));
  const railFill = $("entryRailFill");
  const headline = $("entryHeadline");
  const sub = $("entrySub");
  const stageWrap = $("entryStage");
  const securedEl = document.querySelector("#entryStage .entry-secured");

  // Secure Entry uses the real biometric face image (see .fmesh CSS) — no vector build.

  // timing within the chapter's local progress (kept inside the full-opacity
  // window so every step animates while the chapter is crisp, not mid-fade)
  const START = 0.2;
  const END = 0.78;
  const STEP_W = (END - START) / STEPS.length;
  const RUN_FRAC = 0.62; // first 62% of a step's band = running, then verified

  let verifiedCount = -1; // for one-shot pulse on completion
  let lastActive = -2;

  // estage panels switched via DISPLAY (opacity/ancestor-attr fail to repaint
  // under the heavy WebGL/bloom compositor — display toggles force a clean relayout)
  function setStage(name) {
    document.querySelectorAll("#entryStage .estage").forEach((el) => {
      el.classList.toggle("is-on", el.dataset.stage === name);
    });
  }

  function pulseRow(i) {
    const el = items[i];
    el.classList.remove("just-done");
    void el.offsetWidth;
    el.classList.add("just-done");
  }

  function applyState(states, activeIdx, allDone, fill) {
    states.forEach((st, i) => {
      const el = items[i];
      el.classList.toggle("pending", st === "pending");
      el.classList.toggle("active", st === "active");
      el.classList.toggle("verified", st === "verified");
      const label = el.querySelector(".ei-label");
      const status = el.querySelector(".ei-status");
      if (st === "verified") {
        label.textContent = STEPS[i].done;
        status.textContent = "Verified";
      } else if (st === "active") {
        label.textContent = STEPS[i].label;
        status.textContent = "Running";
      } else {
        label.textContent = STEPS[i].label;
        status.textContent = "Pending";
      }
    });

    railFill.style.height = (fill * 100).toFixed(1) + "%";

    // headline/sub copy (stage panel + secured are handled in setLocal)
    if (allDone) {
      headline.innerHTML = 'Exam Environment<br /><span class="accent">Secured</span>';
      sub.textContent = "All five checks passed — entering proctored session.";
    } else {
      headline.innerHTML = "Securing the<br />Exam Environment";
      sub.textContent = "Preparing the candidate before access is granted.";
    }
  }

  function reset() {
    verifiedCount = -1;
    lastActive = -2;
  }

  window.__entry = {
    setLocal(local, active) {
      if (!active) return;

      const states = [];
      let activeIdx = -1;
      let vCount = 0;
      for (let i = 0; i < STEPS.length; i++) {
        const aAt = START + i * STEP_W;
        const vAt = aAt + STEP_W * RUN_FRAC;
        if (local < aAt) {
          states.push("pending");
        } else if (local < vAt) {
          states.push("active");
          activeIdx = i;
        } else {
          states.push("verified");
          vCount++;
        }
      }
      const allDone = vCount === STEPS.length;

      // --- drive the stage panel FIRST, so nothing downstream can block it ---
      // when between steps (last one verified, next not yet running) keep the
      // panel on the latest-progressed step instead of snapping back to "face"
      let stageName;
      if (allDone) {
        stageName = "none";
      } else if (activeIdx >= 0) {
        stageName = STEPS[activeIdx].key;
      } else if (vCount > 0) {
        stageName = STEPS[vCount - 1].key; // latest verified step
      } else {
        stageName = "face";
      }
      setStage(stageName);
      if (securedEl) securedEl.classList.toggle("is-on", allDone);

      // progress fill: smooth up to last verify point
      const lastVAt = START + (STEPS.length - 1) * STEP_W + STEP_W * RUN_FRAC;
      const fill = Math.max(0, Math.min(1, (local - START) / (lastVAt - START)));

      applyState(states, activeIdx, allDone, fill);

      // one-shot completion pulse + confirmation ripple
      if (vCount > verifiedCount && verifiedCount >= 0) {
        pulseRow(vCount - 1);
      }
      verifiedCount = vCount;
      lastActive = activeIdx;

      if (local < START - 0.02) reset();
    },
    reset,
  };
})();
