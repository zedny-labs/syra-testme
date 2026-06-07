/* ============================================================
   VAR EXAM — Chapter 7 (Integrity Report) + Chapter 9 (Final CTA)
   Both driven DIRECTLY from local scroll progress each frame
   (no CSS transitions on state — avoids the WebGL/bloom
   compositor stranding seen elsewhere in this build).
   ============================================================ */
(function () {
  "use strict";

  // ---------- Chapter 7: Integrity Report ----------
  const reportArc = document.getElementById("reportArc");
  const reportNum = document.getElementById("reportNum");
  const reportGrade = document.getElementById("reportGrade");
  const verdictBanner = document.getElementById("verdictBanner");
  const sparkLine = document.getElementById("sparkLine");
  const rChecks = [...document.querySelectorAll("#ch7 .rcheck")];
  const rMarks = [...document.querySelectorAll("#ch7 .rt-mark")];
  const R_CIRC = 2 * Math.PI * 92; // 578.05
  const SPARK_LEN = 320;
  const TARGET = 96;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  // gauge tick marks around the ring (every 30°)
  (function buildTicks() {
    const g = document.getElementById("reportTicks");
    if (!g) return;
    const cx = 110, cy = 110, rOut = 92, rIn = 84;
    for (let a = 0; a < 360; a += 30) {
      const rad = (a - 90) * Math.PI / 180;
      const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l.setAttribute("x1", (cx + Math.cos(rad) * rOut).toFixed(1));
      l.setAttribute("y1", (cy + Math.sin(rad) * rOut).toFixed(1));
      l.setAttribute("x2", (cx + Math.cos(rad) * rIn).toFixed(1));
      l.setAttribute("y2", (cy + Math.sin(rad) * rIn).toFixed(1));
      g.appendChild(l);
    }
  })();

  // checks + timeline-mark reveal thresholds across local progress
  const checkAt = [0.2, 0.3, 0.4, 0.5];
  const markAt = [0.46, 0.58];

  // grade label by score band
  function gradeFor(score) {
    if (score >= 90) return "Verified · Low Risk";
    if (score >= 75) return "Verified · Moderate";
    if (score >= 55) return "Review Recommended";
    return "High Risk · Flagged";
  }

  window.__report = {
    setLocal(local) {
      // score ring + count-up fill over first 70%
      const fill = smooth(0.08, 0.7, local);
      const score = Math.round(fill * TARGET);
      if (reportNum) reportNum.textContent = score;
      if (reportArc) reportArc.style.strokeDashoffset = (R_CIRC * (1 - fill * TARGET / 100)).toFixed(1);
      // grade label appears once the ring is mostly filled
      if (reportGrade) {
        reportGrade.textContent = gradeFor(score);
        reportGrade.style.opacity = smooth(0.6, 0.7, local).toFixed(3);
      }
      // verdict banner
      if (verdictBanner) {
        const v = smooth(0.12, 0.2, local);
        verdictBanner.style.opacity = v.toFixed(3);
        verdictBanner.style.transform = `translateY(${((1 - v) * -8).toFixed(1)}px)`;
      }
      // AI-confidence sparkline draws itself as the score rises
      if (sparkLine) sparkLine.style.strokeDashoffset = (SPARK_LEN * (1 - smooth(0.3, 0.78, local))).toFixed(1);

      rChecks.forEach((el, i) => {
        const on = local > checkAt[i];
        el.style.opacity = on ? "1" : "0";
        el.style.transform = on ? "translateY(0)" : "translateY(10px)";
      });
      // timeline marks driven INLINE per-frame (compositor-safe — CSS-class
      // transitions get stranded over the WebGL/bloom scene)
      rMarks.forEach((el, i) => {
        const g = smooth(markAt[i], markAt[i] + 0.09, local);
        const iEl = el.querySelector("i");
        const em = el.querySelector("em");
        const stem = el.querySelector(".rt-stem");
        if (iEl) iEl.style.transform = "translate(-50%,-50%) scale(" + g.toFixed(3) + ")";
        if (stem) stem.style.transform = "translateX(-50%) scaleY(" + g.toFixed(3) + ")";
        if (em) em.style.opacity = g.toFixed(3);
      });
    },
  };
  // base hidden state
  rChecks.forEach((el) => { el.style.opacity = "0"; el.style.transform = "translateY(10px)"; el.style.transition = "opacity .4s cubic-bezier(.22,1,.36,1), transform .4s cubic-bezier(.22,1,.36,1)"; });
  if (verdictBanner) verdictBanner.style.transition = "opacity .4s cubic-bezier(.22,1,.36,1), transform .4s cubic-bezier(.22,1,.36,1)";
  if (reportGrade) reportGrade.style.transition = "opacity .4s ease";

  // ---------- Chapter 9: Final CTA logo formation ----------
  (function buildFinalMark() {
    document.querySelectorAll("#finalMark .word").forEach((w) => {
      const txt = w.dataset.fword;
      [...txt].forEach((ch) => {
        const s = document.createElement("span");
        s.className = "fltr";
        s.textContent = ch;
        w.appendChild(s);
      });
    });
  })();
  const fLetters = [...document.querySelectorAll("#finalMark .fltr")];

  window.__finalcta = {
    setLocal(local) {
      // letters light up left-to-right as the tunnel collapses into the logo
      // (compressed so the wordmark fully forms within the chapter's local span,
      // which caps near ~0.55 because the final range extends past 1.0 to stay lit)
      fLetters.forEach((l, i) => {
        const t0 = 0.04 + (i / Math.max(fLetters.length, 1)) * 0.32;
        const lit = smooth(t0, t0 + 0.1, local);
        l.style.setProperty("--lit", lit.toFixed(3));
      });
    },
  };
})();
