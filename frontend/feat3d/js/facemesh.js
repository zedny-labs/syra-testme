/* ============================================================
   VAR EXAM — AI biometric face construct (premium)
   Dense facial topology (latitude + converging longitude contours),
   anatomical features (almond eyes, brows, nose, cupid-bow lips),
   integrated circuit traces, dense biometric landmark nodes with
   halos, a forehead sensor bar, and a sweeping scan beam.
   Colour via --mesh-c (cyan / gold-warn / green-verified).
   window.VARFaceMesh(el, { detail:'full'|'compact', head:true })
   ============================================================ */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const CX = 50, CY = 56, RX = 32, RY = 47;
  let UID = 0;

  function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  const hw = (y) => RX * Math.sqrt(Math.max(0, 1 - ((y - CY) / RY) * ((y - CY) / RY))); // oval half-width at y
  function ovalPath(rx, ry, cy) {
    rx = rx || RX; ry = ry || RY; cy = cy || CY;
    const k = 0.5523, rxk = rx * k, ryk = ry * k;
    const t = cy - ry, b = cy + ry, l = CX - rx, r = CX + rx;
    return "M " + CX + " " + t +
      " C " + (CX + rxk) + " " + t + " " + r + " " + (cy - ryk) + " " + r + " " + cy +
      " C " + r + " " + (cy + ryk) + " " + (CX + rxk) + " " + b + " " + CX + " " + b +
      " C " + (CX - rxk) + " " + b + " " + l + " " + (cy + ryk) + " " + l + " " + cy +
      " C " + l + " " + (cy - ryk) + " " + (CX - rxk) + " " + t + " " + CX + " " + t + " Z";
  }
  const poly = (pts) => pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const mirror = (pts) => pts.map(([x, y]) => [100 - x, y]);

  // circuit traces (left side, mirrored). PCB-style routing over the face.
  const TRACES = [
    [[50,18],[50,30],[50,40]],
    [[50,22],[40,22],[33,28],[33,36]],
    [[50,26],[44,26],[44,33]],
    [[33,40],[33,46],[28,48]],
    [[30,52],[24,55],[24,64],[28,70]],
    [[37,52],[37,58],[31,62],[31,72],[36,82]],
    [[50,42],[45,46],[45,52],[48,56]],
    [[50,64],[44,67],[43,73],[48,77]],
    [[36,86],[44,90],[50,92]],
  ];
  // dense biometric landmark nodes (left side + mirror, plus centre set)
  const NODES_L = [
    [22,60],[24,72],[29,83],[36,92],[44,98],          // jawline
    [30,58],[33,68],                                   // cheeks
    [40,24],[35,30],                                   // forehead
    [30,37],[38,35],[45,37],                           // brow
    [29,45],[37,40],[45,45],[37,50],                   // around eye
    [45,66],                                            // nostril
    [40,80],[45,78],[45,84],                            // mouth corner/upper/lower
  ];
  const NODES_C = [[50,22],[50,38],[50,52],[50,62],[50,68],[50,79],[50,85],[50,92],[50,100]];

  window.VARFaceMesh = function (container, opts) {
    opts = opts || {};
    if (!container) return;
    const full = opts.detail !== "compact";
    container.innerHTML = "";
    container.classList.add("fmesh-host");
    const uid = "fm" + (++UID);

    const svg = el("svg", { viewBox: "0 0 100 120", preserveAspectRatio: "xMidYMid meet", class: "fmesh-svg" });

    // clip everything interior to the face oval
    const defs = el("defs", {});
    const clip = el("clipPath", { id: uid });
    clip.appendChild(el("path", { d: ovalPath() }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    if (opts.head !== false) svg.appendChild(el("path", { class: "fm-head", d: ovalPath() }));

    // outer cranium wireframe net (full only)
    if (full) {
      const net = el("g", { class: "fm-net" });
      const oRX = RX + 10, oRY = RY + 8;
      for (let i = -3; i <= 3; i++) {
        const f = i / 3;
        net.appendChild(el("path", { d: "M " + (CX + f * oRX * 0.5) + " " + (CY - oRY) + " Q " + (CX + f * oRX) + " " + CY + " " + (CX + f * oRX * 0.62) + " " + (CY + oRY) }));
      }
      [1.06, 1.2].forEach((s) => net.appendChild(el("ellipse", { cx: CX, cy: CY, rx: (oRX * s).toFixed(1), ry: (oRY * s).toFixed(1), class: "fm-netring" })));
      svg.appendChild(net);
    }

    // dense facial topology (clipped to face)
    const topo = el("g", { class: "fm-topo", "clip-path": "url(#" + uid + ")" });
    // latitude contours
    for (let i = 1; i <= 11; i++) {
      const y = (CY - RY) + i * (2 * RY / 12);
      const w = hw(y) * 1.02;
      const bow = (y - CY) * 0.16;
      topo.appendChild(el("path", { d: "M " + (CX - w).toFixed(1) + " " + y.toFixed(1) + " Q " + CX + " " + (y + bow).toFixed(1) + " " + (CX + w).toFixed(1) + " " + y.toFixed(1) }));
    }
    // converging longitude contours
    for (let j = -4; j <= 4; j++) {
      const f = j / 4.4;
      const pts = [];
      for (let s = 0; s <= 12; s++) {
        const y = (CY - RY) + s * (2 * RY / 12);
        pts.push([CX + f * hw(y), y]);
      }
      topo.appendChild(el("path", { class: "fm-topo-v", d: poly(pts) }));
    }
    svg.appendChild(topo);

    // circuit traces
    const gT = el("g", { class: "fm-traces" });
    TRACES.forEach((t) => {
      gT.appendChild(el("path", { d: poly(t), class: "fm-trace" }));
      gT.appendChild(el("path", { d: poly(mirror(t)), class: "fm-trace" }));
    });
    svg.appendChild(gT);

    // face outline
    svg.appendChild(el("path", { class: "fm-oval", d: ovalPath() }));

    // anatomical features
    const gF = el("g", { class: "fm-feat" });
    // eyebrows
    gF.appendChild(el("path", { d: "M 28 38 Q 37 33 46 37", class: "fm-line" }));
    gF.appendChild(el("path", { d: "M 72 38 Q 63 33 54 37", class: "fm-line" }));
    // almond eyes + iris + pupil
    [[37, 45], [63, 45]].forEach(([x, y]) => {
      gF.appendChild(el("path", { d: "M " + (x - 8) + " " + y + " Q " + x + " " + (y - 4.4) + " " + (x + 8) + " " + y + " Q " + x + " " + (y + 4.4) + " " + (x - 8) + " " + y + " Z", class: "fm-line" }));
      gF.appendChild(el("circle", { cx: x, cy: y, r: 3.1, class: "fm-line" }));
      gF.appendChild(el("circle", { cx: x, cy: y, r: 1.3, class: "fm-pupil" }));
    });
    // nose: bridge + tip + nostrils
    gF.appendChild(el("path", { d: "M 50 40 L 48 60 Q 46 66 50 67 Q 54 66 52 60 L 50 40", class: "fm-line" }));
    gF.appendChild(el("path", { d: "M 44 66 Q 50 71 56 66", class: "fm-line" }));
    // lips: cupid-bow upper + lower
    gF.appendChild(el("path", { d: "M 40 80 Q 45 76 50 79 Q 55 76 60 80 Q 55 86 50 86 Q 45 86 40 80 Z", class: "fm-line" }));
    gF.appendChild(el("path", { d: "M 43 80 Q 50 82 57 80", class: "fm-dim" }));
    svg.appendChild(gF);

    // dense biometric landmark nodes with halos
    const gD = el("g", { class: "fm-dots" });
    let k = 0;
    const add = (x, y, big) => {
      gD.appendChild(el("circle", { cx: x, cy: y, r: big ? 3 : 2.3, class: "fm-halo" }));
      const c = el("circle", { cx: x, cy: y, r: big ? 1.3 : 1.0, class: "fm-lm" });
      c.style.setProperty("--d", ((k++ % 12) * 0.08).toFixed(2) + "s");
      gD.appendChild(c);
    };
    NODES_L.forEach(([x, y]) => { add(x, y); add(100 - x, y); });
    NODES_C.forEach(([x, y]) => add(x, y, true));
    svg.appendChild(gD);

    // forehead sensor bar (full only)
    if (full) {
      const bar = el("g", { class: "fm-bar" });
      bar.appendChild(el("path", { d: "M 24 18 Q 50 12 76 18", class: "fm-bar-line" }));
      bar.appendChild(el("rect", { x: 30, y: 13.5, width: 40, height: 4.4, rx: 1.2, class: "fm-bar-box" }));
      for (let s = 0; s < 5; s++) bar.appendChild(el("rect", { x: 33 + s * 7.3, y: 14.6, width: 4.6, height: 2.2, rx: 0.4, class: "fm-bar-seg" }));
      svg.appendChild(bar);
    }

    // sweeping scan beam
    const beam = el("rect", { class: "fm-beam", x: 8, y: -2, width: 84, height: 1.6, rx: 0.8 });
    beam.appendChild(el("animate", { attributeName: "y", values: "-2;116", dur: "3.8s", repeatCount: "indefinite" }));
    beam.appendChild(el("animate", { attributeName: "opacity", values: "0;0.85;0.85;0", keyTimes: "0;0.06;0.85;1", dur: "3.8s", repeatCount: "indefinite" }));
    svg.appendChild(beam);

    container.appendChild(svg);
    return container;
  };
})();
