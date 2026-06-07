/* ============================================================
   VAR EXAM — Journey choreography
   ScrollTrigger maps scroll -> normalized progress, which flies
   the camera, crossfades chapters, recolors the tunnel, and
   drives each chapter's internal animation.
   ============================================================ */
(function () {
  "use strict";

  gsap.registerPlugin(ScrollTrigger);

  const J = window.__journey;
  const C = (hex) => new THREE.Color(hex);

  // --- scroll length (robot beat + intro + chapters) ---
  document.getElementById("scroll-spacer").style.height = "2100vh";
  const ROBOT_BEAT = 0.045;  // first 4.5% of scroll = hero robot beat (one scroll -> init)
  const INTRO_END = 0.42;   // consciousness cinematic spans 0 .. INTRO_END (post-robot)

  // intro / chrome elements
  const introCanvas = document.getElementById("intro-scene");
  const introOverlay = document.getElementById("intro-overlay");
  const introWhite = document.getElementById("intro-white");
  const brandMark = document.querySelector(".brand-mark");
  const progressRail = document.getElementById("progress-rail");
  const contactCta = document.getElementById("contactCta");

  // --- chapter ranges across progress 0..1 (gaps = pure-tunnel moments) ---
  // 7 chapters: Awakening, Create, Verify, Secure Entry, AI Proctoring,
  //             Integrity Report, Final CTA
  const RANGES = [
    [0.0, 0.12],
    [0.135, 0.28],
    [0.295, 0.44],
    [0.455, 0.60],
    [0.615, 0.76],
    [0.775, 0.89],
    [0.905, 1.12],
  ];
  const FADE = 0.018;

  // --- per-chapter tunnel look ---
  const LOOK = [
    { color: 0x10c4d4, accent: 0xffd700, bloom: 0.92 },
    { color: 0x00e5ee, accent: 0xffd700, bloom: 1.0 },
    { color: 0x3fd6a8, accent: 0x00ffff, bloom: 0.95 },
    { color: 0x3fd6a8, accent: 0x00ffff, bloom: 0.9 },
    { color: 0x00e5ee, accent: 0xffd700, bloom: 1.12 },
    { color: 0x3fd6a8, accent: 0x00ffff, bloom: 1.0 },
    { color: 0x00e5ee, accent: 0xffd700, bloom: 1.35 },
  ];

  // --- chapters + staggered children ---
  const chapters = [...document.querySelectorAll(".chapter")].map((el, idx) => {
    const fx = [...el.querySelectorAll(".fx")];
    fx.forEach((f, i) => (f.dataset.fxI = i));
    return { el, fx, idx };
  });

  // wordmark letters
  (function buildWordmark() {
    document.querySelectorAll("#wordmark .word").forEach((w) => {
      const txt = w.dataset.word;
      [...txt].forEach((ch, i) => {
        const s = document.createElement("span");
        s.className = "ltr";
        s.textContent = ch;
        s.dataset.li = i;
        w.appendChild(s);
      });
    });
  })();
  const wordLetters = [...document.querySelectorAll("#wordmark .ltr")];

  const rail = [...document.querySelectorAll(".rail-node")];
  const verifyStage = document.getElementById("verifyStage");
  const sceneCanvas = document.getElementById("scene");
  const scrollHint = document.getElementById("scrollHint");

  // ---------- helpers ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function smooth(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function rangeVis(p, r) {
    const up = smooth(r[0], r[0] + FADE, p);
    const down = 1 - smooth(r[1] - FADE, r[1], p);
    return Math.min(up, down);
  }

  function setChildVis(el, base, i) {
    const off = Math.min(i * 0.06, 0.55);
    const v = clamp((base - off) / (1 - off), 0, 1);
    el.style.setProperty("--vis", v.toFixed(3));
  }

  // ---------- main update: route between intro and chapters ----------
  function update(p) {
    if (p < INTRO_END) {
      // ----- PRE-INTRO PHASE -----
      const ip = clamp(p / INTRO_END, 0, 1);
      window.__introActive = true;
      window.__tunnelActive = false;
      document.body.classList.add("intro-phase");
      if (window.__intro) window.__intro.setProgress(ip);

      introCanvas.style.opacity = "1";
      introOverlay.style.opacity = "1";
      introOverlay.style.pointerEvents = "none";
      // white flash builds up over a wider range so the move into Chapter 1
      // takes more scroll (slower, calmer handoff)
      introWhite.style.opacity = (smooth(INTRO_END - 0.06, INTRO_END, p) * 0.4).toFixed(3);

      // hide product chrome + chapters during the cinematic
      brandMark.style.opacity = "0";
      progressRail.style.opacity = "0";
      if (contactCta) contactCta.style.opacity = "0";
      scrollHint.style.opacity = ip < 0.03 ? "0.8" : "0";
      scrollHint.style.visibility = ip < 0.03 ? "visible" : "hidden";
      chapters.forEach((ch) => { ch.el.style.opacity = "0"; ch.el.classList.remove("is-active"); });

      // park the tunnel camera at the start so it is ready for the handoff
      J.progress = 0;
      return;
    }

    // ----- CHAPTER PHASE (existing experience, remapped) -----
    window.__introActive = false;
    window.__tunnelActive = true;
    document.body.classList.remove("intro-phase");
    introCanvas.style.opacity = "0";
    introOverlay.style.opacity = "0";
    if (window.__intro) window.__intro.setProgress(1);
    // white flash fades out slowly as the hero is revealed (longer = slower handoff)
    introWhite.style.opacity = (0.4 * (1 - smooth(INTRO_END, INTRO_END + 0.06, p))).toFixed(3);
    brandMark.style.opacity = "1";
    progressRail.style.opacity = "1";
    if (contactCta) contactCta.style.opacity = "1";

    const e = clamp((p - INTRO_END) / (1 - INTRO_END), 0, 1);
    updateChapters(e);
  }

  // ---------- chapter choreography (drives tunnel + overlays) ----------
  function updateChapters(p) {
    J.progress = p;

    // hide scroll hint after start
    scrollHint.style.opacity = p > 0.015 ? "0" : "0.9";
    scrollHint.style.visibility = p > 0.015 ? "hidden" : "visible";

    let dominant = 0,
      domVis = -1;

    chapters.forEach((ch, i) => {
      const vis =
        i === 0
          ? 1 - smooth(RANGES[0][1] - FADE, RANGES[0][1], p) // first chapter present on load
          : rangeVis(p, RANGES[i]);
      const el = ch.el;
      el.style.opacity = vis.toFixed(3);
      el.style.setProperty("--vis", vis.toFixed(3)); // base for non-.fx descendants
      el.classList.toggle("is-active", vis > 0.55);
      if (vis > domVis) {
        domVis = vis;
        dominant = i;
      }

      // Integrity Report (i===5): dim + blur the tunnel so the dashboard
      // "locks in" as a solid HUD. Driven inline per-frame (compositor-safe).
      if (i === 5 && sceneCanvas) {
        sceneCanvas.style.filter = vis > 0.02
          ? "blur(" + (vis * 6).toFixed(1) + "px) brightness(" + (1 - vis * 0.62).toFixed(2) + ")"
          : "none";
      }

      if (vis <= 0.001) return;
      const local = clamp((p - RANGES[i][0]) / (RANGES[i][1] - RANGES[i][0]), 0, 1);

      // staggered child reveal
      if (i === 0) {
        wordLetters.forEach((l, li) => setChildVis(l, vis, li));
      }
      ch.fx.forEach((f, fi) => setChildVis(f, vis, fi));

      // chapter-specific internals
      // (0 Awaken, 1 Create, 2 Verify, 3 Entry, 4 Proctor, 5 Report, 6 Final CTA)
      if (i === 2) drawVerify(local);
      if (i === 3 && window.__entry) window.__entry.setLocal(local, true);
      if (i === 4 && window.__proctor) window.__proctor.setLocal(local, true);
      if (i === 5 && window.__report) window.__report.setLocal(local);
      if (i === 6 && window.__finalcta) window.__finalcta.setLocal(local);
    });

    // tunnel look from dominant chapter
    const look = LOOK[dominant];
    J.targetColor.copy(C(look.color));
    J.targetAccent.copy(C(look.accent));
    J.targetBloom = look.bloom;

    // rail state
    rail.forEach((node, i) => {
      node.classList.toggle("active", i === dominant);
      node.classList.toggle("passed", i < dominant);
    });
  }

  // ---------- ch4 verify ----------
  function drawVerify(local) {
    // scan sweeps 0->1 over first 60%
    const scan = clamp(local / 0.6, 0, 1);
    verifyStage.style.setProperty("--scan", scan.toFixed(3));
    verifyStage.classList.toggle("verified", local > 0.62);
  }

  // ---------- ScrollTrigger (robot beat -> existing experience) ----------
  ScrollTrigger.create({
    trigger: "#scroll-spacer",
    start: "top top",
    end: "bottom bottom",
    scrub: 0.7,
    onUpdate: (self) => {
      const raw = self.progress;
      if (raw < ROBOT_BEAT) {
        // hero robot intro beat owns the screen; existing experience parked at start
        if (window.__robot) window.__robot.setPhase(raw / ROBOT_BEAT);
        update(0);
        scrollHint.style.opacity = "0";
        scrollHint.style.visibility = "hidden";
      } else {
        if (window.__robot) window.__robot.hide();
        update((raw - ROBOT_BEAT) / (1 - ROBOT_BEAT));
      }
    },
  });

  // "Start Interactive Demo" -> scroll to ch2 (remapped past the intro)
  document.querySelectorAll('[data-action="next"]').forEach((b) => {
    b.addEventListener("click", () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: maxScroll * 0.55, behavior: "smooth" });
    });
  });

  // init
  update(0);
  // expose for verification/scripted seeking (captures only work at scrollY 0
  // because the whole experience is position:fixed over a tall spacer)
  window.__seek = update;
  // refresh once fonts/layout settle
  window.addEventListener("load", () => ScrollTrigger.refresh());
  setTimeout(() => ScrollTrigger.refresh(), 600);
})();
