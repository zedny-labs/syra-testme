/* ============================================================
   VAR EXAM — Pre-intro cinematic "Digital Consciousness"
   A self-contained Three.js scene layered above the tunnel.
   window.__intro.setProgress(ip)  ip in [0..1] across 8 scenes.
   Renders only while active (gated by window.__introActive) so
   it doesn't fight the tunnel renderer for GPU.
   ============================================================ */
(function () {
  "use strict";

  const canvas = document.getElementById("intro-scene");
  if (!canvas || !window.THREE) return;

  // Cyan primary + GOLD accent (gold replaces the former violet) on pure black.
  const CY = new THREE.Color(0x00eaff); // electric cyan (primary)
  const VI = new THREE.Color(0xffd24a); // gold accent (was violet)
  const WH = new THREE.Color(0xffffff);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.05);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(0, 0.4, 8);

  const root = new THREE.Group();
  scene.add(root);

  // ---------------- environment: grid floor ----------------
  const gridMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uTime: { value: 0 }, uColor: { value: CY.clone() }, uOpacity: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      precision highp float; varying vec2 vUv; uniform float uTime; uniform vec3 uColor; uniform float uOpacity;
      float line(float c,float w){ float f=fract(c); float d=min(f,1.0-f); return smoothstep(w,0.0,d); }
      void main(){
        float g = max(line(vUv.x*42.0,0.012), line(vUv.y*42.0 - uTime*0.4,0.012));
        float fade = smoothstep(0.0,0.42,vUv.y) * smoothstep(1.0,0.55,vUv.y);
        float a = g * fade * uOpacity;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(60, 60, 1, 1), gridMat);
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -3.2;
  root.add(grid);

  // ---------------- glow sprite helper ----------------
  function glowTex() {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,0.95)");
    grd.addColorStop(0.25, "rgba(180,230,255,0.45)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }
  const gtex = glowTex();

  // ---------------- data snippets (gold readouts orbiting the core) ----------------
  function textTex(str) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    const g = c.getContext("2d");
    g.clearRect(0, 0, 256, 64);
    g.font = "600 30px 'Space Mono', monospace";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.shadowColor = "rgba(255,210,74,0.9)"; g.shadowBlur = 10;
    g.fillStyle = "#ffd24a";
    g.fillText(str, 128, 34);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    return t;
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function hex2() { return Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, "0"); }
  function snippetStr() {
    const r = Math.random();
    if (r < 0.34) return "0x" + hex2() + "·" + hex2();
    if (r < 0.58) return "LAT " + rand(-72, 72).toFixed(1) + "°";
    if (r < 0.74) return "LON " + rand(-160, 160).toFixed(1) + "°";
    if (r < 0.86) return "Δ" + rand(0, 9.9).toFixed(2) + "ms";
    if (r < 0.94) return "ID·" + hex2() + hex2();
    return "CONF " + rand(90, 99).toFixed(1) + "%";
  }
  const snippets = [];
  const SNIP_N = 16;
  for (let i = 0; i < SNIP_N; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTex(snippetStr()), transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    const sr = rand(2.0, 3.4);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    sp.userData = { sr, theta, phi, drift: rand(0.04, 0.13) * (Math.random() > 0.5 ? 1 : -1), bob: Math.random() * 6.28, w: 1.05, h: 0.26 };
    sp.scale.set(1.05, 0.26, 1);
    root.add(sp);
    snippets.push(sp);
  }

  // ---------------- the intelligence core ----------------
  const coreGroup = new THREE.Group();
  root.add(coreGroup);

  // dense geodesic wireframe — the "skeletal framework" of the core
  const icoGeo = new THREE.IcosahedronGeometry(1.25, 3);
  const coreWire = new THREE.Mesh(
    icoGeo,
    new THREE.MeshBasicMaterial({ color: CY.clone(), wireframe: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  coreGroup.add(coreWire);

  // counter-rotating outer geometric shell for depth / hard-sci-fi structure
  const coreShellWire = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.72, 1),
    new THREE.MeshBasicMaterial({ color: VI.clone(), wireframe: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  coreGroup.add(coreShellWire);

  const coreInner = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.85, 2),
    new THREE.MeshBasicMaterial({ color: CY.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  coreGroup.add(coreInner);

  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: gtex, color: CY.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  coreGlow.scale.setScalar(5);
  coreGroup.add(coreGlow);

  // tiny seed pulse — the very first sign of life in Scene 1 (before the core forms)
  const seedGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: gtex, color: CY.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  seedGlow.scale.setScalar(0.7);
  root.add(seedGlow);

  // bright node hotspots at vertices of the wireframe (intersection glows)
  const nodeGeo = new THREE.BufferGeometry();
  const ico2 = new THREE.IcosahedronGeometry(1.25, 1);
  const nodePos = ico2.attributes.position.array.slice();
  nodeGeo.setAttribute("position", new THREE.BufferAttribute(nodePos, 3));
  const nodes = new THREE.Points(nodeGeo, new THREE.PointsMaterial({ color: WH.clone(), size: 0.13, map: gtex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  coreGroup.add(nodes);

  // ---------------- radiating energy paths (fiber-optic data lines) ----------------
  const pathGroup = new THREE.Group();
  coreGroup.add(pathGroup);
  const paths = [];
  const PATH_N = 40;
  for (let i = 0; i < PATH_N; i++) {
    const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.acos(2 * Math.random() - 1), Math.random() * Math.PI * 2).normalize();
    const inner = 1.15, outer = 3.0 + Math.random() * 2.8;
    const a = dir.clone().multiplyScalar(inner);
    const b = dir.clone().multiplyScalar(outer);
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color: (Math.random() > 0.72 ? VI : CY).clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    pathGroup.add(line);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: gtex, color: WH.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    sp.scale.setScalar(0.5);
    pathGroup.add(sp);
    paths.push({ line, mat, sp, a, b, phase: Math.random(), speed: 0.3 + Math.random() * 0.7 });
  }

  // ---------------- scanning latitude ring (sweeps top -> bottom across sphere) ----------------
  const scanRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.012, 6, 100),
    new THREE.MeshBasicMaterial({ color: CY.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  scanRing.rotation.x = Math.PI / 2;
  coreGroup.add(scanRing);

  // ---------------- energy rings ----------------
  const rings = [];
  const ringDefs = [
    { r: 1.9, tilt: 0.0, gold: false, speed: 0.5 },
    { r: 2.4, tilt: 0.5, gold: true, speed: -0.35 },
    { r: 3.0, tilt: -0.4, gold: false, speed: 0.28 },
    { r: 3.6, tilt: 0.25, gold: true, speed: -0.2 },
  ];
  ringDefs.forEach((d) => {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(d.r, 0.028, 8, 140),
      new THREE.MeshBasicMaterial({ color: (d.gold ? VI : CY).clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    m.rotation.x = Math.PI / 2 + d.tilt;
    m.userData = d;
    coreGroup.add(m);
    rings.push(m);
  });

  // ---------------- neural particle field ----------------
  const P_N = 5200;
  const pPos = new Float32Array(P_N * 3);
  const pHome = new Float32Array(P_N * 3); // dispersed position
  const pShell = new Float32Array(P_N * 3); // position on/near the core shell
  const pCol = new Float32Array(P_N * 3);
  const pSize = new Float32Array(P_N);
  for (let i = 0; i < P_N; i++) {
    // dispersed home: large sphere shell of dust
    const R = 7 + Math.random() * 9;
    const t = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pHome[i * 3] = R * Math.sin(ph) * Math.cos(t);
    pHome[i * 3 + 1] = R * Math.cos(ph) * 0.6;
    pHome[i * 3 + 2] = R * Math.sin(ph) * Math.sin(t);
    // shell target near the icosa core (radius ~1.4 with jitter)
    const sr = 1.35 + (Math.random() - 0.5) * 0.5;
    const st = Math.random() * Math.PI * 2;
    const sph = Math.acos(2 * Math.random() - 1);
    pShell[i * 3] = sr * Math.sin(sph) * Math.cos(st);
    pShell[i * 3 + 1] = sr * Math.cos(sph);
    pShell[i * 3 + 2] = sr * Math.sin(sph) * Math.sin(st);
    pPos[i * 3] = pHome[i * 3]; pPos[i * 3 + 1] = pHome[i * 3 + 1]; pPos[i * 3 + 2] = pHome[i * 3 + 2];
    const c = Math.random() > 0.78 ? VI : CY;
    pCol[i * 3] = c.r; pCol[i * 3 + 1] = c.g; pCol[i * 3 + 2] = c.b;
    pSize[i] = Math.random() * 0.06 + 0.015;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  pGeo.setAttribute("aSize", new THREE.BufferAttribute(pSize, 1));
  const pMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: `
      attribute float aSize; attribute vec3 color; varying vec3 vColor; varying float vTw; uniform float uTime;
      void main(){ vColor=color; vTw=0.5+0.5*sin(uTime*2.0+position.x*2.0+position.y*1.5);
        vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*(360.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `
      varying vec3 vColor; varying float vTw; uniform float uOpacity;
      void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d); if(r>0.5) discard;
        float a=smoothstep(0.5,0.0,r)*(0.3+vTw*0.7)*uOpacity; gl_FragColor=vec4(vColor,a); }`,
  });
  const points = new THREE.Points(pGeo, pMat);
  root.add(points);


  // ---------------- starfield (far dust) ----------------
  const S_N = 900;
  const sPos = new Float32Array(S_N * 3);
  for (let i = 0; i < S_N; i++) {
    sPos[i * 3] = (Math.random() - 0.5) * 120;
    sPos[i * 3 + 1] = (Math.random() - 0.5) * 70;
    sPos[i * 3 + 2] = -10 - Math.random() * 120;
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
  const stars = new THREE.Points(sGeo, new THREE.PointsMaterial({ color: 0x9fdfff, size: 0.12, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
  root.add(stars);

  // ---------------- postprocessing ----------------
  const composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.6, 0.25);
  composer.addPass(bloom);

  // ---------------- scene parameter state (lerped) ----------------
  function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---------------- mouse parallax (desktop only) ----------------
  const par = { tx: 0, ty: 0, x: 0, y: 0 };
  const isTouch = window.matchMedia && window.matchMedia("(hover: none)").matches;
  if (!isTouch) {
    window.addEventListener("pointermove", (e) => {
      par.tx = (e.clientX / window.innerWidth - 0.5) * 2;  // -1..1
      par.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });
  }

  let introP = 0;

  // ---------------- DOM overlay (text, panels, signals) ----------------
  const q = (s) => document.querySelector(s);
  const introOverlayEl = document.getElementById("intro-overlay");
  const linksEl = document.getElementById("intro-links");
  const sigShown = [];
  const ov = {
    init: q('[data-cap="init"]'),
    forming: q('[data-cap="forming"]'),
    normal: q('[data-cap="normal"]'),
    ordoesit: q('[data-cap="ordoesit"]'),
    analyzing: q('[data-cap="analyzing"]'),
    core: q('[data-cap="core"]'),
    panels: [...document.querySelectorAll(".holo-panel")],
    signals: [...document.querySelectorAll(".isig")],
  };
  const setOp = (el, o) => { if (el) el.style.opacity = o.toFixed(3); };
  // trapezoid: fade in a->b, hold, fade out c->d
  function win(ip, a, b, c, d) { return Math.max(0, Math.min(smooth(a, b, ip), 1 - smooth(c, d, ip))); }

  // ---- core headline: per-letter cinematic reveal (GSAP "system typing") ----
  const cwWords = ov.core ? [...ov.core.querySelectorAll(".cw")] : [];
  // split each word into per-letter spans (keep words intact for line wrapping)
  let cwLetters = [];
  cwWords.forEach((w) => {
    const txt = w.textContent;
    w.textContent = "";
    [...txt].forEach((ch) => {
      const s = document.createElement("span");
      s.className = "cl";
      s.textContent = ch;
      w.appendChild(s);
      cwLetters.push(s);
    });
  });
  let coreRevealed = false;
  function resetCoreWords() {
    if (!window.gsap || !cwLetters.length) return;
    gsap.killTweensOf(cwLetters);
    gsap.set(cwLetters, { opacity: 0, y: 26, scale: 0.94, filter: "blur(10px)" });
    cwWords.forEach((w) => w.classList.remove("cw-in"));
  }
  function playCoreReveal() {
    if (!window.gsap || !cwLetters.length) return;
    gsap.killTweensOf(cwLetters);
    gsap.set(cwLetters, { opacity: 0, y: 26, scale: 0.94, filter: "blur(10px)" });
    cwWords.forEach((w) => w.classList.remove("cw-in"));
    // light per-word scan sweep as each word begins filling in
    let acc = 0;
    cwWords.forEach((w) => {
      const n = w.querySelectorAll(".cl").length;
      const delay = acc * 0.045;
      setTimeout(() => w.classList.add("cw-in"), delay * 1000);
      acc += n;
    });
    // per-letter typing reveal
    gsap.to(cwLetters, {
      opacity: 1, y: 0, scale: 1, filter: "blur(0px)",
      duration: 0.5, ease: "power3.out", stagger: 0.045,
    });
    // final-word emphasis once the last letter lands
    const last = ov.core.querySelector(".cw.last");
    if (last) {
      gsap.to(last, { scale: 1.04, duration: 0.22, delay: cwLetters.length * 0.045 + 0.35, ease: "power2.out", yoyo: true, repeat: 1 });
    }
  }
  if (cwLetters.length && window.gsap) gsap.set(cwLetters, { opacity: 0, y: 26, scale: 0.94, filter: "blur(10px)" });

  function updateOverlay(ip) {
    setOp(ov.init, win(ip, 0.0, 0.08, 0.16, 0.24));
    setOp(ov.forming, win(ip, 0.22, 0.28, 0.33, 0.39));

    const collapse = smooth(0.85, 0.95, ip);
    const lit = ip > 0.58 && ip < 0.855;
    const freeze = ip > 0.45 && ip < 0.585; // scene 4 dims panels slightly
    const panelPresence = Math.max(0, Math.min(smooth(0.32, 0.44, ip), 1 - smooth(0.86, 0.93, ip)));
    if (linksEl) linksEl.style.opacity = (panelPresence * (freeze ? 0.45 : 0.85)).toFixed(3);
    ov.panels.forEach((p, i) => {
      const stag = i * 0.018;
      let o = Math.max(0, Math.min(smooth(0.3 + stag, 0.42 + stag, ip), 1 - smooth(0.86, 0.93, ip)));
      if (freeze) o *= 0.55;
      p.style.opacity = o.toFixed(3);
      const sc = (1 - collapse * 0.7) * (lit ? 1.03 : 1);
      const dx = (1 - Math.min(smooth(0.3 + stag, 0.42 + stag, ip), 1)) * (p.dataset.side === "l" ? -26 : 26);
      p.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), -50%) scale(${sc.toFixed(3)})`;
      p.classList.toggle("lit", lit);
    });

    setOp(ov.normal, win(ip, 0.455, 0.49, 0.53, 0.565));
    setOp(ov.ordoesit, win(ip, 0.535, 0.565, 0.6, 0.64));
    setOp(ov.analyzing, win(ip, 0.6, 0.64, 0.68, 0.72));

    ov.signals.forEach((s, i) => {
      const t0 = 0.67 + i * 0.019;
      const inO = smooth(t0, t0 + 0.02, ip);
      const o = Math.max(0, Math.min(inO, 1 - smooth(0.82, 0.86, ip)));
      s.style.opacity = o.toFixed(3);
      s.style.transform = `translateX(${((1 - inO) * 14).toFixed(1)}px)`;
      // one-shot "detection" beat when a signal first becomes visible (forward scroll)
      const visible = o > 0.5;
      if (visible && !sigShown[i]) { s.classList.remove("ping"); void s.offsetWidth; s.classList.add("ping"); sigShown[i] = true; }
      else if (!visible && sigShown[i]) { sigShown[i] = false; s.classList.remove("ping"); }
    });

    // core headline: starts only after the signals have fully cleared (no overlap)
    const coreIn = ip > 0.88 && ip < 1.0;
    ov.core.style.opacity = coreIn ? (1 - smooth(0.985, 1.0, ip)).toFixed(3) : "0";
    if (ip > 0.885 && !coreRevealed) { coreRevealed = true; playCoreReveal(); }
    if (ip < 0.86 && coreRevealed) { coreRevealed = false; resetCoreWords(); }
  }

  window.__intro = {
    setProgress(ip) {
      introP = Math.max(0, Math.min(1, ip));
      updateOverlay(introP);
    },
  };

  // ---------------- render loop (gated) — DIRECT mapping from introP ----------------
  const clock = new THREE.Clock();
  const tmpC = new THREE.Color();
  function frame() {
    requestAnimationFrame(frame);
    const active = window.__introActive !== false;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!active) return; // skip rendering entirely when tunnel/chapters own the screen
    const time = clock.elapsedTime;
    const ip = introP;

    // ---- compute all visual params DIRECTLY from ip (no accumulative easing) ----
    const form = smooth(0.10, 0.30, ip);
    const observe = smooth(0.28, 0.44, ip);
    const activate = smooth(0.58, 0.70, ip) * (1 - smooth(0.85, 0.95, ip));
    const collapse = smooth(0.85, 0.95, ip);
    const transition = smooth(0.95, 1.0, ip);

    const gridOp = Math.min(form * 0.9, 1) * (1 - transition);
    const starOp = (0.25 + form * 0.3) * (1 - transition * 0.6);
    const pOp = Math.max(smooth(0.07, 0.17, ip) * 0.5, form) * (1 - transition);
    const coreOp = form * (1 - transition * 0.25);
    const glowOp = Math.min(0.14 + form * 0.2 + activate * 0.12 + collapse * 0.4 + transition * 0.7, 0.85);
    const ringOp = observe * (0.95 + activate * 0.4) * (1 - transition * 0.2);
    const converge = Math.max(form * 0.82, collapse);
    const coreScale = lerp(0.2, 1.0, form) * (1 + activate * 0.18 + collapse * 0.55 + transition * 0.6);
    const ringScale = Math.max(0.05, 1 + activate * 0.12 - collapse * 0.6);
    const tint = Math.max(activate * 0.55, collapse * 0.8, transition);
    const bloomS = 0.6 + activate * 0.22 + collapse * 0.5 + transition * 1.1;
    const push = smooth(0.0, 0.85, ip);
    const camZ = lerp(8.0, 4.2, push) - collapse * 2.0 - transition * 1.8;
    const camY = lerp(0.7, 0.25, push);
    const orbit = smooth(0.45, 0.58, ip) * (1 - collapse);

    // camera-shake impulse at "DEEP ANALYSIS ENGAGED" (peaks ip~0.62, decays)
    const shakeAmp = Math.max(0, 1 - Math.abs(ip - 0.625) / 0.06) * 0.22;

    // color tint (cyan -> violet/white)
    tmpC.copy(CY).lerp(VI, Math.min(tint, 1) * 0.7).lerp(WH, Math.max(0, tint - 0.6) * 1.2);

    // grid
    gridMat.uniforms.uTime.value = time;
    gridMat.uniforms.uOpacity.value = gridOp;
    gridMat.uniforms.uColor.value.copy(tmpC);

    // stars
    stars.material.opacity = starOp;
    stars.rotation.y = time * 0.01;

    // particles: position set DIRECTLY (home->shell->center) + global swirl
    const arr = pGeo.attributes.position.array;
    const baseMix = Math.min(converge / 0.82, 1);
    const collapseF = Math.max(0, (converge - 0.82) / 0.18);
    const swirl = time * (0.18 + activate * 0.5) + form * 1.2;
    const cs = Math.cos(swirl), sn = Math.sin(swirl);
    for (let i = 0; i < P_N; i++) {
      const ix = i * 3;
      let tx = lerp(pHome[ix], pShell[ix], baseMix);
      let ty = lerp(pHome[ix + 1], pShell[ix + 1], baseMix);
      let tz = lerp(pHome[ix + 2], pShell[ix + 2], baseMix);
      if (collapseF > 0) { tx = lerp(tx, 0, collapseF); ty = lerp(ty, 0, collapseF); tz = lerp(tz, 0, collapseF); }
      arr[ix] = tx * cs - tz * sn;
      arr[ix + 1] = ty;
      arr[ix + 2] = tx * sn + tz * cs;
    }
    pGeo.attributes.position.needsUpdate = true;
    pMat.uniforms.uTime.value = time;
    pMat.uniforms.uOpacity.value = pOp;

    // core
    coreGroup.scale.setScalar(coreScale);
    coreGroup.rotation.y = time * (0.12 + activate * 0.5);
    coreGroup.rotation.x = Math.sin(time * 0.2) * 0.12;
    coreWire.material.opacity = coreOp * 1.0;
    coreWire.material.color.copy(tmpC);
    coreShellWire.material.opacity = coreOp * (0.5 + activate * 0.3);
    coreShellWire.material.color.copy(VI).lerp(tmpC, tint * 0.5);
    coreShellWire.rotation.y = -time * (0.22 + activate * 0.4);
    coreShellWire.rotation.z = time * 0.1;
    coreInner.material.opacity = coreOp * (0.18 + activate * 0.1 + transition * 0.85);
    coreInner.material.color.copy(tmpC);
    nodes.material.opacity = coreOp * (0.7 + activate * 0.5);
    nodes.material.color.copy(WH).lerp(tmpC, 0.3);
    const pulse = 1 + Math.sin(time * (1.4 + activate * 3)) * (0.04 + activate * 0.05);
    coreGlow.scale.setScalar((2.4 + activate * 0.7 + transition * 11) * pulse);
    coreGlow.material.opacity = Math.min(glowOp, 0.85);
    coreGlow.material.color.copy(tmpC);

    // seed pulse — breathing point of light that precedes the core (Scene 1)
    const seedLife = (1 - smooth(0.08, 0.2, ip)) * smooth(0.0, 0.02, ip);
    seedGlow.material.opacity = seedLife * (0.5 + 0.5 * Math.sin(time * 2.6));
    seedGlow.scale.setScalar((0.5 + 0.18 * Math.sin(time * 2.6)) * (1 + seedLife));

    // scanning latitude ring sweeps top -> bottom across the sphere
    const scanActive = observe * (1 - collapse) * (1 - transition);
    const sweep = (time * 0.33) % 1;                 // 0..1 loop
    const yy = lerp(1.25, -1.25, sweep);             // top -> bottom (core radius ~1.25)
    const rr = Math.sqrt(Math.max(0.0001, 1.25 * 1.25 - yy * yy));
    scanRing.position.y = yy;
    scanRing.scale.set(rr, rr, 1);
    scanRing.material.opacity = scanActive * 0.9 * (0.6 + 0.4 * Math.sin(sweep * Math.PI));
    scanRing.material.color.copy(CY).lerp(tmpC, tint * 0.4);

    // data snippets orbit + drift around the core
    const snipOp = observe * (1 - collapse) * (1 - transition);
    snippets.forEach((sp) => {
      const u = sp.userData;
      u.theta += u.drift * dt;
      const x = u.sr * Math.sin(u.phi) * Math.cos(u.theta);
      const z = u.sr * Math.sin(u.phi) * Math.sin(u.theta);
      const y = u.sr * Math.cos(u.phi) + Math.sin(time * 0.6 + u.bob) * 0.12;
      sp.position.set(x, y, z);
      sp.material.opacity = snipOp * 0.85 * (0.65 + 0.35 * Math.sin(time * 1.4 + u.bob));
    });

    // radiating energy paths (fiber-optic data transmission) — brighter pulses
    const pathOp = observe * (0.5 + activate * 0.6) * (1 - collapse) * (1 - transition);
    paths.forEach((p) => {
      p.mat.opacity = pathOp * (0.45 + 0.55 * Math.sin(time * 1.6 + p.phase * 6.28));
      // travelling pulse from inner -> outer
      let t = (time * p.speed + p.phase) % 1;
      p.sp.position.lerpVectors(p.a, p.b, t);
      const head = pathOp * (1 - t) * 1.25;
      p.sp.material.opacity = Math.min(head, 0.85);
      p.sp.scale.setScalar(0.26 + (1 - t) * 0.26);
    });

    // rings
    rings.forEach((m, i) => {
      m.material.opacity = ringOp * (0.6 + 0.4 * Math.sin(time * 1.2 + i));
      m.material.color.copy(m.userData.gold ? tmpC : CY).lerp(tmpC, tint * 0.5);
      m.rotation.z += m.userData.speed * dt * (1 + activate * 2);
      m.scale.setScalar(ringScale);
    });

    // camera (direct target from ip; tiny lerp only for cinematic float)
    // + mouse parallax (depth) + activation shake impulse
    par.x += (par.tx - par.x) * Math.min(dt * 4, 1);
    par.y += (par.ty - par.y) * Math.min(dt * 4, 1);
    const shx = shakeAmp ? (Math.random() - 0.5) * shakeAmp : 0;
    const shy = shakeAmp ? (Math.random() - 0.5) * shakeAmp : 0;
    const ox = Math.sin(orbit * Math.PI) * 2.4 + par.x * 0.9;
    const ck = Math.min(dt * 6, 1);
    camera.position.x += (ox + shx - camera.position.x) * ck;
    camera.position.y += (camY + par.y * -0.6 + Math.sin(time * 0.3) * 0.12 + shy - camera.position.y) * ck;
    camera.position.z += (camZ - camera.position.z) * ck;
    camera.lookAt(0, 0, 0);

    // DOM overlay parallax (panels/text drift opposite the core for a holographic-table feel)
    if (introOverlayEl) {
      introOverlayEl.style.transform = `translate(${(-par.x * 14).toFixed(1)}px, ${(-par.y * 10).toFixed(1)}px)`;
    }

    bloom.strength = bloomS;
    composer.render();
  }
  frame();

  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); composer.setSize(w, h); bloom.setSize(w, h);
  });

  // init hidden
  window.__intro.setProgress(0);
})();
