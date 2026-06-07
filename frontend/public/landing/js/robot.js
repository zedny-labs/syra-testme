/* ============================================================
   VAR EXAM — Hero intro robot (Spline)
   A first-beat overlay: the blue point intensifies, particles
   orbit, the robot materialises, a welcome line appears and the
   robot "points" (GSAP approximation), then on scroll it retreats
   and dematerialises back into the blue point that begins the
   existing consciousness intro.
   API: window.__robot.setPhase(t)  t=0 present .. 1 gone
        window.__robot.hide()
   ============================================================ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const stage = $("robot-stage");
  if (!stage) return;
  const scaleW = $("robot-scale");
  const tiltW = $("robot-tilt");
  const viewer = $("robotViewer");
  const glow = $("robot-glow");
  const point = $("robot-point");
  const text = $("robot-text");
  const hint = $("robot-hint");
  const particles = $("robot-particles");

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // ---- background starfield (static, twinkling — replaces orbiting dots) ----
  const P = [];
  for (let i = 0; i < 90; i++) {
    const s = document.createElement("span");
    s.className = "rstar";
    s.style.left = (Math.random() * 100).toFixed(2) + "%";
    s.style.top = (Math.random() * 100).toFixed(2) + "%";
    const sz = (Math.random() * 1.6 + 0.6).toFixed(2);
    s.style.width = sz + "px";
    s.style.height = sz + "px";
    s.style.setProperty("--tw", (2 + Math.random() * 4).toFixed(2) + "s");
    s.style.setProperty("--dly", (-Math.random() * 5).toFixed(2) + "s");
    s.style.setProperty("--max", (0.3 + Math.random() * 0.7).toFixed(2));
    particles.appendChild(s);
    P.push(s);
  }

  // ---- mouse parallax (damped) ----
  const par = { tx: 0, ty: 0, x: 0, y: 0 };
  const isTouch = window.matchMedia && window.matchMedia("(hover: none)").matches;
  if (!isTouch) {
    window.addEventListener("pointermove", (e) => {
      par.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      par.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });
  }
  let retreatScale = 1, retreatY = 0;
  (function tick() {
    requestAnimationFrame(tick);
    par.x += (par.tx - par.x) * 0.06;
    par.y += (par.ty - par.y) * 0.06;
    if (tiltW) {
      // constrained, intelligent-feeling lean toward cursor
      tiltW.style.transform =
        "perspective(1200px) rotateY(" + (par.x * 6).toFixed(2) + "deg) rotateX(" +
        (-par.y * 4).toFixed(2) + "deg) translate(" + (par.x * 10).toFixed(1) + "px," + (par.y * 6).toFixed(1) + "px)";
    }
  })();

  // ---- load-time cinematic intro (plays once) ----
  let introPlayed = false;
  let introTL = null;
  let retreating = false;
  function playIntro() {
    if (introPlayed || !window.gsap) return;
    introPlayed = true;
    const tl = gsap.timeline();
    introTL = tl;
    // 1-3: blue light intensifies + expands
    tl.fromTo(glow, { opacity: 0.0, scale: 0.4 }, { opacity: 0.6, scale: 1, duration: 1.8, ease: "power2.out" }, 0);
    tl.fromTo(particles, { opacity: 0 }, { opacity: 1, duration: 1.2 }, 0.4);
    // 4-6: robot materialises + camera push
    tl.fromTo(scaleW, { opacity: 0, scale: 0.7, filter: "blur(14px)" },
      { opacity: 1, scale: 1, filter: "blur(0px)", duration: 1.8, ease: "power2.out" }, 0.8);
    tl.to(glow, { opacity: 0.4, scale: 1.15, duration: 1.6, ease: "sine.inOut" }, 2.0);
    // welcome text
    tl.fromTo(text, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 1.0, ease: "power2.out" }, 2.6);
    // point approximation: lean toward the text, hold, return
    tl.to(scaleW, { rotateZ: -3, y: 6, duration: 0.7, ease: "power2.inOut" }, 3.0);
    tl.to(text, { scale: 1.04, duration: 0.6, ease: "power2.out" }, 3.2);
    tl.to(text, { scale: 1.0, duration: 0.6 }, 3.9);
    tl.to(scaleW, { rotateZ: 0, y: 0, duration: 0.9, ease: "power2.inOut" }, 3.9);
    // scroll hint
    tl.fromTo(hint, { opacity: 0 }, { opacity: 0.85, duration: 0.8 }, 3.6);
  }

  // try to play once the viewer element exists / on load
  function nudge() { window.dispatchEvent(new Event("resize")); }
  function onViewerReady() {
    playIntro();
    requestAnimationFrame(nudge);
    setTimeout(nudge, 200);
    setTimeout(nudge, 900);
  }
  if (viewer) {
    viewer.addEventListener("load", onViewerReady);   // spline-viewer fires 'load'
  }
  window.addEventListener("load", () => setTimeout(onViewerReady, 400));
  setTimeout(onViewerReady, 2500); // fallback if events don't fire

  // ---- scroll-driven retreat + dematerialise ----
  window.__robot = {
    setPhase(t) {
      t = clamp(t, 0, 1);
      stage.style.display = "flex";
      // before any real scroll, let the load-time GSAP intro fully own the scene
      if (t <= 0.006) { retreating = false; return; }
      if (!retreating) { retreating = true; if (introTL) introTL.kill(); }

      // text + hint fade out as soon as the user moves
      const ui = 1 - smooth(0.02, 0.18, t);
      text.style.opacity = ui.toFixed(3);
      hint.style.opacity = (0.85 * ui).toFixed(3);

      // robot recedes into depth: scale down + fade + drift back
      const recede = smooth(0.05, 0.82, t);
      retreatScale = 1 - recede * 0.78;
      retreatY = -recede * 4;
      scaleW.style.opacity = (1 - smooth(0.18, 0.86, t)).toFixed(3);
      scaleW.style.transform = "translateY(" + retreatY.toFixed(1) + "vh) scale(" + retreatScale.toFixed(3) + ")";

      // particles burst outward then fade
      const burst = smooth(0.1, 0.7, t);
      particles.style.setProperty("--burst", (1 + burst * 1.6).toFixed(2));
      particles.style.opacity = (1 - smooth(0.55, 0.95, t)).toFixed(3);

      // collapse into a concentrated blue point that retreats into distance
      const cp = smooth(0.55, 1.0, t);
      point.style.opacity = (smooth(0.55, 0.72, t) * (1 - smooth(0.9, 1.0, t))).toFixed(3);
      const ps = (1.4 - cp * 1.2);
      point.style.transform = "translate(-50%,-50%) scale(" + Math.max(0.06, ps).toFixed(3) + ")";

      // glow follows: gentle mid-retreat lift, then shrink away (calm)
      glow.style.opacity = (0.4 + smooth(0.4, 0.7, t) * 0.28 - smooth(0.8, 1.0, t) * 0.6).toFixed(3);
      glow.style.transform = "translate(-50%,-50%) scale(" + (1 - cp * 0.7).toFixed(3) + ")";
    },
    hide() {
      stage.style.display = "none";
    },
    show() {
      stage.style.display = "flex";
    },
  };

  // stars twinkle via CSS; nothing to animate per-frame here.
})();
