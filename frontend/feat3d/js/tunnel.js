/* ============================================================
   VAR EXAM — Procedural tunnel (the journey corridor)
   Three.js r128 + UnrealBloom. Camera flies along a curve
   driven by window.__journey.progress (0..1).
   ============================================================ */
(function () {
  "use strict";

  // Shared journey state (journey.js writes target colors/alert)
  const J = (window.__journey = window.__journey || {
    progress: 0,
    eased: 0,
    // target tunnel look (lerped each frame)
    color: new THREE.Color(0x00ffff),
    accent: new THREE.Color(0xffd700),
    targetColor: new THREE.Color(0x0bd3e0),
    targetAccent: new THREE.Color(0xffd700),
    bloom: 1.15,
    targetBloom: 1.15,
    alert: 0,        // 0..1 red flash from proctoring events
    exposure: 0,     // ramps up at the awakening
    targetExposure: 1.15,
    speed: 1,
  });

  const canvas = document.getElementById("scene");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0;
  renderer.setClearColor(0x050505, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x050505, 0.04);

  const camera = new THREE.PerspectiveCamera(
    72,
    window.innerWidth / window.innerHeight,
    0.1,
    400
  );

  // ---------------- Curve (gentle, never dizzying) ----------------
  const PTS = [];
  const SEG = 26;
  const STEP = 18;
  for (let i = 0; i < SEG; i++) {
    const z = -i * STEP;
    // slow meander — small amplitude, long wavelength
    const x = Math.sin(i * 0.42) * 9 + Math.sin(i * 0.13) * 5;
    const y = Math.cos(i * 0.33) * 6 + Math.sin(i * 0.21) * 3;
    PTS.push(new THREE.Vector3(x, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(PTS, false, "catmullrom", 0.5);
  const TUBE_R = 7;

  // ---------------- Tunnel shell (shader corridor) ----------------
  const tubeGeo = new THREE.TubeGeometry(curve, 900, TUBE_R, 40, false);
  const tubeMat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: J.color },
      uAccent: { value: J.accent },
      uAlert: { value: 0 },
      uHead: { value: 0 }, // camera t along tube, for energy travel
    },
    vertexShader: `
      varying vec2 vUv;
      varying float vDepth;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      varying float vDepth;
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uAccent;
      uniform float uAlert;
      uniform float uHead;

      float band(float c, float w){
        float f = fract(c);
        float d = min(f, 1.0 - f);
        return smoothstep(w, 0.0, d);
      }
      void main(){
        // rings travelling toward the viewer = data stream (calmer pace)
        float ringCoord = vUv.x * 520.0 - uTime * 1.4;
        float rings = band(ringCoord, 0.045);
        // pulsing energy rings, sparse + bright
        float pulse = band(vUv.x * 60.0 - uTime * 0.9, 0.012);
        // longitudinal ribs around circumference
        float ribs = band(vUv.y * 24.0, 0.05) * 0.55;

        float grid = max(rings * 0.9, ribs);
        grid = max(grid, pulse * 1.6);

        // depth fade: corridor dissolves into darkness ahead
        float fade = smoothstep(120.0, 6.0, vDepth);
        float near = smoothstep(2.0, 16.0, vDepth); // hide the ring right on camera

        vec3 col = mix(uColor, uAccent, pulse * 0.9 + rings * 0.12);
        col = mix(col, vec3(1.0, 0.18, 0.24), uAlert * (0.5 + pulse));

        float intensity = grid * fade * near;
        // soft base glow of the walls
        float wall = (0.05 + 0.05 * sin(vUv.y * 6.2831 + uTime * 0.4)) * fade * near;

        vec3 outc = col * intensity + uColor * wall * 0.6;
        float a = clamp(intensity + wall * 0.8, 0.0, 1.0);
        gl_FragColor = vec4(outc, a);
      }
    `,
  });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  scene.add(tube);

  // ---------------- Light rings (torus gates) ----------------
  const ringGroup = new THREE.Group();
  const RING_N = 60;
  const ringMat = new THREE.MeshBasicMaterial({
    color: J.color,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ringGeo = new THREE.TorusGeometry(TUBE_R * 0.92, 0.05, 8, 60);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < RING_N; i++) {
    const t = (i + 0.5) / RING_N;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const m = new THREE.Mesh(ringGeo, ringMat.clone());
    m.position.copy(p);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tan);
    m.quaternion.copy(q);
    m.userData.t = t;
    m.userData.phase = Math.random() * Math.PI * 2;
    m.userData.gold = i % 5 === 0;
    ringGroup.add(m);
  }
  scene.add(ringGroup);

  // ---------------- Particle field inside the tube ----------------
  const P_N = 4200;
  const pPos = new Float32Array(P_N * 3);
  const pColor = new Float32Array(P_N * 3);
  const pSize = new Float32Array(P_N);
  const pT = new Float32Array(P_N);
  const tmp = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3();
  for (let i = 0; i < P_N; i++) {
    const t = Math.random();
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    // build a frame around the tangent
    nrm.set(0, 1, 0).cross(tan).normalize();
    bin.crossVectors(tan, nrm).normalize();
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.pow(Math.random(), 0.5) * TUBE_R * 0.92;
    tmp.copy(p)
      .addScaledVector(nrm, Math.cos(ang) * rad)
      .addScaledVector(bin, Math.sin(ang) * rad);
    pPos[i * 3] = tmp.x;
    pPos[i * 3 + 1] = tmp.y;
    pPos[i * 3 + 2] = tmp.z;
    pT[i] = t;
    pSize[i] = Math.random() * 0.10 + 0.02;
    const c = Math.random();
    const col = c > 0.82 ? J.accent : J.color;
    pColor[i * 3] = col.r;
    pColor[i * 3 + 1] = col.g;
    pColor[i * 3 + 2] = col.b;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(pColor, 3));
  pGeo.setAttribute("aSize", new THREE.BufferAttribute(pSize, 1));
  const pMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aSize;
      attribute vec3 color;
      varying vec3 vColor;
      varying float vTw;
      uniform float uTime;
      void main(){
        vColor = color;
        vTw = 0.5 + 0.5 * sin(uTime * 2.0 + position.x * 3.0 + position.y * 2.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vTw;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if(r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r) * (0.25 + vTw * 0.75);
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });
  const points = new THREE.Points(pGeo, pMat);
  scene.add(points);

  // ---------------- Distant volumetric haze sprites ----------------
  const hazeTex = makeGlowTexture();
  const hazeMat = new THREE.SpriteMaterial({
    map: hazeTex,
    color: J.color,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const hazeGroup = new THREE.Group();
  for (let i = 0; i < 22; i++) {
    const t = (i + 0.5) / 22;
    const p = curve.getPointAt(t);
    const s = new THREE.Sprite(hazeMat.clone());
    s.position.copy(p);
    s.scale.setScalar(TUBE_R * (1.4 + Math.random()));
    s.userData.t = t;
    hazeGroup.add(s);
  }
  scene.add(hazeGroup);

  // ---------------- Postprocessing ----------------
  const composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  const bloom = new THREE.UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.15, // strength
    0.7, // radius
    0.04 // threshold
  );
  composer.addPass(bloom);

  // ---------------- Camera path helpers ----------------
  const T_MAX = 0.9; // leave tail
  const camLook = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();

  function setCamera(tEased, time) {
    // gentle auto-drift: the camera always glides forward a touch, even when
    // the scroll is still — a slow breathing motion along the tunnel axis.
    const drift = 0.004 * Math.sin(time * 0.5) + 0.004;
    const t = Math.min(tEased * T_MAX + drift, T_MAX);
    curve.getPointAt(t, camPos);
    curve.getPointAt(Math.min(t + 0.006, 0.999), tmpLook);
    // gentle cinematic sway
    const swayX = Math.sin(time * 0.4) * 0.5;
    const swayY = Math.cos(time * 0.32) * 0.35;
    camera.position.set(camPos.x + swayX, camPos.y + swayY, camPos.z);
    camLook.copy(tmpLook);
    camLook.x += swayX * 0.5;
    camLook.y += swayY * 0.5;
    camera.lookAt(camLook);
    // subtle roll
    camera.rotation.z = Math.sin(time * 0.25) * 0.03;
  }

  // ---------------- Render loop ----------------
  const clock = new THREE.Clock();
  let raf;
  function animate() {
    raf = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    // paused while the pre-intro cinematic owns the screen (saves GPU)
    if (window.__tunnelActive === false) return;

    // ease progress toward target (scroll provides target)
    J.eased += (J.progress - J.eased) * Math.min(dt * 4.5, 1);

    // lerp look/colors
    J.color.lerp(J.targetColor, Math.min(dt * 1.6, 1));
    J.accent.lerp(J.targetAccent, Math.min(dt * 1.6, 1));
    J.bloom += (J.targetBloom - J.bloom) * Math.min(dt * 2.0, 1);
    J.alert += (0 - J.alert) * Math.min(dt * 2.4, 1); // decay
    J.exposure += (J.targetExposure - J.exposure) * Math.min(dt * 1.2, 1);

    renderer.toneMappingExposure = J.exposure;
    bloom.strength = J.bloom + J.alert * 0.6;

    // tube uniforms
    tubeMat.uniforms.uTime.value = time;
    tubeMat.uniforms.uColor.value = J.color;
    tubeMat.uniforms.uAccent.value = J.accent;
    tubeMat.uniforms.uAlert.value = J.alert;
    pMat.uniforms.uTime.value = time;

    // camera
    setCamera(J.eased, time);
    const headT = Math.min(J.eased * T_MAX, T_MAX);

    // rings: glow as camera approaches, recolor
    ringGroup.children.forEach((m) => {
      const d = Math.abs(m.userData.t - headT);
      const near = Math.max(0, 1 - d * 7);
      const tw = 0.6 + 0.4 * Math.sin(time * 2 + m.userData.phase);
      m.material.opacity = near * 0.9 * tw;
      m.material.color.copy(m.userData.gold ? J.accent : J.color);
      const s = 1 + near * 0.06 * Math.sin(time * 3 + m.userData.phase);
      m.scale.setScalar(s);
    });

    // haze recolor + fade in with approach
    hazeGroup.children.forEach((s) => {
      const d = Math.abs(s.userData.t - headT);
      const near = Math.max(0, 1 - d * 5);
      s.material.opacity = near * 0.22;
      s.material.color.copy(J.color);
    });

    composer.render();
  }
  animate();

  // ---------------- Resize ----------------
  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  });

  // pause when tab hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { clock.getDelta(); animate(); }
  });

  // ---------------- helpers ----------------
  function makeGlowTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.3, "rgba(255,255,255,0.35)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  window.__tunnelReady = true;
})();
