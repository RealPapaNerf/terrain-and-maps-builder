// editor.js — the map editor: a top-down, hillshaded view of one map, with
// tools for the things a map carries. Stand points and line-of-sight get the
// most care, because "the launch spot turned out to be a hole with mountains
// over it" is the problem this editor exists to solve: the View tool marks
// every post you cannot see from a spot before you ever fly it.
//
// Coordinates, once:
//   grid   (c, r)  posts, c east-wards, r south-wards, row 0 = north edge
//   local  (n, e)  the sim's metres: n = originNE[0] - r*cell, e = originNE[1] + c*cell
//   world  (u, v)  canvas metres from the north-west post: u = c*cell, v = r*cell
//   screen (x, y)  css px: x = (u - cam.u) * cam.k, y = (v - cam.v) * cam.k
//
// The datum rule (fieldElevM and origin.datumElevM follow the ground under
// the pilot) is applied by the server on save — the editor only previews it.

import { api, toast } from './app.js';

const $ = (s) => document.querySelector(s);

const SURFACE_NAMES = ['unknown', 'grass', 'rock', 'water', 'asphalt', 'snow', 'dirt', 'brush'];
const SURF_COLOR = [
  [138, 138, 138], [106, 154, 78], [154, 143, 130], [52, 110, 165],
  [84, 84, 88], [235, 238, 240], [160, 132, 87], [125, 143, 86],
];
const SKY_DEG = 12; // proposeSites' idea of "the horizon is low enough"

let E = null; // the open map's whole editor state

/* Save means "make it real". The sim's default library is the PUBLISHED one,
   so a map saved to this folder and not pushed is a map the sim never sees —
   which is how an afternoon of moved stand points stayed invisible. Save
   therefore commits and pushes the map it just saved, and the checkbox beside
   it is the way out for someone editing without a network or not ready to
   publish. Remembered, because it is a habit, not a per-map decision. */
const PUB_KEY = 'flmap.publishOnSave';
const publishOnSave = () => localStorage.getItem(PUB_KEY) !== 'off';
function syncSaveLabel() {
  const box = $('#edPub'), btn = $('#edSave');
  if (!box || !btn) return;
  box.checked = publishOnSave();
  btn.textContent = box.checked ? 'Save & publish' : 'Save';
}

export function editorDirty() {
  return !!(E && (E.dirty.heights || E.dirty.surface || E.dirty.meta));
}

export function closeEditor() {
  if (E && E.raf) cancelAnimationFrame(E.raf);
  E = null;
}

export async function openEditor(id) {
  const json = await api(`/api/map/${id}`);
  const g = json.grid;
  const originNE = g.originNE || [((g.rows - 1) * g.cell) / 2, -((g.cols - 1) * g.cell) / 2];

  const hbuf = await (await fetch(`/library/${id}/${g.heights.file}?t=${Date.now()}`)).arrayBuffer();
  const raw = new Uint16Array(hbuf);
  const elev = new Float32Array(g.cols * g.rows);
  for (let i = 0; i < elev.length; i++) elev[i] = raw[i] * g.heights.scale + g.heights.offset;

  let surf = null;
  if (g.surface && g.surface.file) {
    const sbuf = await (await fetch(`/library/${id}/${g.surface.file}?t=${Date.now()}`)).arrayBuffer();
    surf = new Uint8Array(sbuf);
  }

  let colorData = null;
  if (json.color && json.color.file) {
    colorData = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const t = document.createElement('canvas');
        t.width = g.cols; t.height = g.rows;
        const tc = t.getContext('2d');
        tc.drawImage(img, 0, 0, g.cols, g.rows);
        resolve(tc.getImageData(0, 0, g.cols, g.rows));
      };
      img.onerror = () => resolve(null);
      img.src = `/library/${id}/${json.color.file}?t=${Date.now()}`;
    });
  }

  const base = document.createElement('canvas');
  base.width = g.cols; base.height = g.rows;

  E = {
    id, json, cols: g.cols, rows: g.rows, cell: g.cell, originNE,
    elev, surf, colorData,
    base, baseCtx: base.getContext('2d'), baseImg: null,
    canvas: $('#edCanvas'), ctx: $('#edCanvas').getContext('2d'),
    cam: { u: 0, v: 0, k: 0.2 },
    tool: 'select', sel: null, showClasses: !colorData && !!surf,
    brush: { mode: 'raise', radiusM: 60, strengthM: 4, cls: 1 },
    obj: { kind: 'tree', treeR: 2.4, treeH: 9, density: 5, forestR: 40, bSizeN: 8, bSizeE: 6, bH: 3.2, roof: 'gable', wireUp: 9, sag: 1, gateW: 2.2, gateH: 2 },
    wirePending: null, // first end of a wire being placed
    viewshed: null,    // { mask, n, e, eyeM, horizon: Float32Array(360), open }
    stroke: null, undo: [], redo: [],
    dirty: { heights: false, surface: false, meta: false },
    needsDraw: true, raf: 0, pointer: null, panning: null, dragging: null,
  };
  E.baseImg = E.baseCtx.createImageData(g.cols, g.rows);

  $('#edName').textContent = json.name || id;
  renderBase(0, 0, E.cols - 1, E.rows - 1);
  bindOnce();
  resize();
  fit();
  setTool('sites'); // the tool you most likely came for
  loop();
}

/* =============================================== geometry and sampling */
const idx = (c, r) => r * E.cols + c;
const NEofCR = (c, r) => [E.originNE[0] - r * E.cell, E.originNE[1] + c * E.cell];
const CRofNE = (n, e) => [(e - E.originNE[1]) / E.cell, (E.originNE[0] - n) / E.cell]; // fractional [c, r]
const scrOfNE = (n, e) => {
  const u = (e - E.originNE[1]), v = (E.originNE[0] - n);
  return [(u - E.cam.u) * E.cam.k, (v - E.cam.v) * E.cam.k];
};
const NEofScr = (x, y) => {
  const u = x / E.cam.k + E.cam.u, v = y / E.cam.k + E.cam.v;
  return [E.originNE[0] - v, E.originNE[1] + u];
};
const inGrid = (n, e) => {
  const [c, r] = CRofNE(n, e);
  return c >= 0 && c <= E.cols - 1 && r >= 0 && r <= E.rows - 1;
};

function elevAt(n, e) {
  let [c, r] = CRofNE(n, e);
  c = Math.max(0, Math.min(E.cols - 1.001, c));
  r = Math.max(0, Math.min(E.rows - 1.001, r));
  const c0 = Math.floor(c), r0 = Math.floor(r), tc = c - c0, tr = r - r0;
  return E.elev[idx(c0, r0)] * (1 - tc) * (1 - tr) + E.elev[idx(c0 + 1, r0)] * tc * (1 - tr)
    + E.elev[idx(c0, r0 + 1)] * (1 - tc) * tr + E.elev[idx(c0 + 1, r0 + 1)] * tc * tr;
}

/* ========================================================= base render */
function renderBase(c0, r0, c1, r1) {
  c0 = Math.max(0, c0); r0 = Math.max(0, r0);
  c1 = Math.min(E.cols - 1, c1); r1 = Math.min(E.rows - 1, r1);
  const { elev, surf, colorData, cols, rows, cell } = E;
  const d = E.baseImg.data, cd = colorData ? colorData.data : null;
  let lo = Infinity, hi = -Infinity;
  if (!cd && !surf) { for (let i = 0; i < elev.length; i++) { if (elev[i] < lo) lo = elev[i]; if (elev[i] > hi) hi = elev[i]; } }
  const lx = -0.5, ly = -0.5, lz = 0.707; // light from the north-west, 45° up

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = idx(c, r);
      const cm = Math.min(cols - 1, Math.max(1, c)), rm = Math.min(rows - 1, Math.max(1, r));
      const dzdx = (elev[idx(Math.min(cols - 1, cm + 1), r)] - elev[idx(cm - 1, r)]) / (2 * cell);
      const dzdy = (elev[idx(c, Math.min(rows - 1, rm + 1))] - elev[idx(c, rm - 1)]) / (2 * cell);
      const nl = 1 / Math.hypot(dzdx, dzdy, 1);
      const lambert = Math.max(0, (-dzdx * lx + -dzdy * ly + lz) * nl);

      let R, G, B;
      if (cd) { R = cd[i * 4]; G = cd[i * 4 + 1]; B = cd[i * 4 + 2]; }
      else if (surf) { const s = SURF_COLOR[surf[i]] || SURF_COLOR[0]; R = s[0]; G = s[1]; B = s[2]; }
      else { // elevation ramp: valley green up through tan to pale rock
        const t = (elev[i] - lo) / Math.max(1, hi - lo);
        R = 90 + t * 140; G = 125 + t * 95; B = 70 + t * 120;
      }
      if (E.showClasses && surf && cd) { // classes blended over imagery, when asked
        const s = SURF_COLOR[surf[i]] || SURF_COLOR[0];
        R = R * 0.5 + s[0] * 0.5; G = G * 0.5 + s[1] * 0.5; B = B * 0.5 + s[2] * 0.5;
      }
      // over a photo the morning's shadows are already in it, so shade gently
      const k = cd ? 0.74 + 0.36 * lambert : 0.52 + 0.62 * lambert;
      d[i * 4] = Math.min(255, R * k); d[i * 4 + 1] = Math.min(255, G * k);
      d[i * 4 + 2] = Math.min(255, B * k); d[i * 4 + 3] = 255;
    }
  }
  E.baseCtx.putImageData(E.baseImg, 0, 0, c0, r0, c1 - c0 + 1, r1 - r0 + 1);
  E.needsDraw = true;
}

/* ========================================================== screen draw */
function resize() {
  const wrap = $('#edCanvasWrap');
  const dpr = devicePixelRatio || 1;
  E.canvas.width = wrap.clientWidth * dpr;
  E.canvas.height = wrap.clientHeight * dpr;
  E.dpr = dpr;
  E.needsDraw = true;
}

function fit() {
  const W = E.canvas.width / E.dpr, H = E.canvas.height / E.dpr;
  const spanU = (E.cols - 1) * E.cell, spanV = (E.rows - 1) * E.cell;
  E.cam.k = Math.min(W / spanU, H / spanV) * 0.94;
  E.cam.u = (spanU - W / E.cam.k) / 2;
  E.cam.v = (spanV - H / E.cam.k) / 2;
  E.needsDraw = true;
}

function loop() {
  if (!E) return;
  if (E.needsDraw) { E.needsDraw = false; draw(); }
  E.raf = requestAnimationFrame(loop);
}

function draw() {
  const { ctx, cam, dpr } = E;
  const W = E.canvas.width / dpr, H = E.canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, W, H);

  // terrain: base canvas px are posts; world u = post * cell
  ctx.imageSmoothingEnabled = cam.k * E.cell < 3;
  ctx.drawImage(E.base,
    cam.u / E.cell, cam.v / E.cell, W / (cam.k * E.cell), H / (cam.k * E.cell),
    0, 0, W, H);

  // viewshed: red where you cannot see
  if (E.viewshed) {
    ctx.drawImage(E.viewshed.canvas,
      cam.u / E.cell, cam.v / E.cell, W / (cam.k * E.cell), H / (cam.k * E.cell),
      0, 0, W, H);
  }

  drawPads(ctx);
  drawObstacles(ctx);
  drawGates(ctx);
  drawStarts(ctx);
  drawSites(ctx);
  if (E.viewshed) {
    const [x, y] = scrOfNE(E.viewshed.n, E.viewshed.e);
    glyph(ctx, x, y, '#ffd34d', '◉', 'view from here');
  }
  if (E.wirePending) {
    const [x, y] = scrOfNE(E.wirePending.n, E.wirePending.e);
    dot(ctx, x, y, 4, '#ddd');
    if (E.pointer) {
      const [px, py] = E.pointer;
      ctx.strokeStyle = '#ddd'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(px, py); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // brush cursor
  if ((E.tool === 'terrain' || E.tool === 'surface' || (E.tool === 'objects' && E.obj.kind === 'forest')) && E.pointer) {
    const rM = E.tool === 'objects' ? E.obj.forestR : E.brush.radiusM;
    ctx.strokeStyle = '#fff8'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(E.pointer[0], E.pointer[1], rM * cam.k, 0, 7); ctx.stroke();
  }

  scaleBar(ctx, W, H);
  ctx.fillStyle = '#dde4ee'; ctx.font = '12px system-ui';
  ctx.fillText('N ↑', W - 34, 20);
}

function worldPx(m) { return Math.max(1, m * E.cam.k); }

function drawPads(ctx) {
  for (const [i, p] of (E.json.pads || []).entries()) {
    const a = (p.yawDeg * Math.PI) / 180;
    // corners in NE space, projected — no ctx.rotate, no sign ambiguity
    const cs = Math.cos(a), sn = Math.sin(a);
    const half = p.lengthM / 2, hw = p.widthM / 2;
    const corner = (dl, dw) => scrOfNE(p.n + dl * cs - dw * sn, p.e + dl * sn + dw * cs);
    const pts = [corner(half, hw), corner(half, -hw), corner(-half, -hw), corner(-half, hw)];
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) ctx.lineTo(q[0], q[1]);
    ctx.closePath();
    ctx.fillStyle = p.surface === 'grass' ? '#4d7a3d88' : '#52525a99';
    ctx.fill();
    ctx.strokeStyle = isSel('pad', i) ? '#fff' : '#c9d2e0';
    ctx.lineWidth = isSel('pad', i) ? 2 : 1;
    ctx.stroke();
    if (p.kind === 'runway') { // centreline
      const a1 = scrOfNE(p.n + (half - 6) * cs, p.e + (half - 6) * sn);
      const a2 = scrOfNE(p.n - (half - 6) * cs, p.e - (half - 6) * sn);
      ctx.setLineDash([6, 6]); ctx.strokeStyle = '#fffa';
      ctx.beginPath(); ctx.moveTo(a1[0], a1[1]); ctx.lineTo(a2[0], a2[1]); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawObstacles(ctx) {
  for (const [i, o] of (E.json.obstacles || []).entries()) {
    const sel = isSel('obstacle', i);
    if (o.t === 'tree') {
      const [x, y] = scrOfNE(o.n, o.e);
      ctx.fillStyle = '#2f7d32cc';
      ctx.beginPath(); ctx.arc(x, y, Math.max(2.5, worldPx(o.r * 2)), 0, 7); ctx.fill();
      if (sel) ring(ctx, x, y, Math.max(5, worldPx(o.r * 2) + 3));
    } else if (o.t === 'building') {
      const [x0, y0] = scrOfNE(o.n + o.sizeN / 2, o.e - o.sizeE / 2);
      const [x1, y1] = scrOfNE(o.n - o.sizeN / 2, o.e + o.sizeE / 2);
      ctx.fillStyle = '#c2a36bd0';
      ctx.fillRect(x0, y0, Math.max(3, x1 - x0), Math.max(3, y1 - y0));
      ctx.strokeStyle = sel ? '#fff' : '#8a7549';
      ctx.strokeRect(x0, y0, Math.max(3, x1 - x0), Math.max(3, y1 - y0));
    } else if (o.t === 'pole') {
      const [x, y] = scrOfNE(o.n, o.e);
      dot(ctx, x, y, sel ? 4 : 2.6, '#cfd6e2');
    } else if (o.t === 'wire') {
      const [x0, y0] = scrOfNE(o.a.n, o.a.e), [x1, y1] = scrOfNE(o.b.n, o.b.e);
      ctx.strokeStyle = sel ? '#fff' : '#cfd6e2'; ctx.lineWidth = sel ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      dot(ctx, x0, y0, 2.4, '#cfd6e2'); dot(ctx, x1, y1, 2.4, '#cfd6e2');
      ctx.lineWidth = 1;
    } else if (o.t === 'gate') {
      const [x, y] = scrOfNE(o.n, o.e);
      glyph(ctx, x, y, sel ? '#fff' : '#e0a93f', '▟▙', '');
    } else if (o.t === 'target') {
      const [x, y] = scrOfNE(o.n, o.e);
      ctx.strokeStyle = sel ? '#fff' : '#e06c5f';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, 7); ctx.stroke();
    }
  }
}

function drawGates(ctx) {
  for (const [i, gq] of (E.json.gates || []).entries()) {
    const [x, y] = scrOfNE(gq.n, gq.e);
    glyph(ctx, x, y, isSel('gate', i) ? '#fff' : '#4da3ff', `⊓${i + 1}`, '');
  }
}

function drawStarts(ctx) {
  for (const [i, s] of (E.json.starts || []).entries()) {
    const [x, y] = scrOfNE(s.n, s.e);
    const a = ((s.yawDeg || 0) * Math.PI) / 180;
    const sel = isSel('start', i);
    ctx.strokeStyle = sel ? '#fff' : '#5dbb63';
    ctx.fillStyle = sel ? '#fff' : '#5dbb63';
    ctx.lineWidth = sel ? 2.4 : 1.8;
    // arrow pointing along yaw (0 = north = up-screen)
    const dx = Math.sin(a) * 13, dy = -Math.cos(a) * 13;
    ctx.beginPath(); ctx.moveTo(x - dx * 0.4, y - dy * 0.4); ctx.lineTo(x + dx, y + dy); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    ctx.lineWidth = 1;
    label(ctx, x, y + 14, s.name || s.id, sel);
  }
}

function drawSites(ctx) {
  const j = E.json;
  for (const [i, s] of (j.sites || []).entries()) {
    const [x, y] = scrOfNE(s.n, s.e);
    glyph(ctx, x, y, isSel('site', i) ? '#fff' : '#4da3ff', '⚑', s.name);
  }
  if (j.home && (j.home.n !== j.pilot.n || j.home.e !== j.pilot.e)) {
    const [x, y] = scrOfNE(j.home.n, j.home.e);
    glyph(ctx, x, y, '#9ad', 'H', '');
  }
  const [x, y] = scrOfNE(j.pilot.n, j.pilot.e);
  const sel = isSel('pilot', 0);
  ctx.fillStyle = sel ? '#fff' : '#ff9c3f';
  ctx.strokeStyle = '#000';
  ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fillStyle = '#000'; ctx.fill();
  label(ctx, x, y + 18, 'You stand here', sel);
}

function glyph(ctx, x, y, color, ch, name) {
  ctx.fillStyle = color;
  ctx.font = 'bold 15px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(ch, x, y + 5);
  if (name) label(ctx, x, y + 18, name, false);
  ctx.textAlign = 'left';
}
function label(ctx, x, y, text, hot) {
  ctx.font = '11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000b';
  const w = ctx.measureText(text).width;
  ctx.fillRect(x - w / 2 - 3, y - 9, w + 6, 13);
  ctx.fillStyle = hot ? '#fff' : '#dde4ee';
  ctx.fillText(text, x, y + 1);
  ctx.textAlign = 'left';
}
function dot(ctx, x, y, r, col) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
function ring(ctx, x, y, r) { ctx.strokeStyle = '#fff'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke(); ctx.setLineDash([]); }

function scaleBar(ctx, W, H) {
  const target = 120 / E.cam.k; // ~120 px worth of metres
  const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((v) => v >= target) || 5000;
  const px = nice * E.cam.k;
  ctx.strokeStyle = '#dde4ee'; ctx.fillStyle = '#dde4ee'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(14, H - 16); ctx.lineTo(14 + px, H - 16); ctx.stroke();
  ctx.font = '11px system-ui';
  ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 16, H - 22);
  ctx.lineWidth = 1;
}

const isSel = (kind, i) => E.sel && E.sel.kind === kind && E.sel.i === i;

/* ================================================= undo, redo, dirtying */
function cloneMeta() {
  const j = E.json;
  return JSON.parse(JSON.stringify({
    pilot: j.pilot, home: j.home, sites: j.sites || [], starts: j.starts || [],
    pads: j.pads || [], obstacles: j.obstacles || [], gates: j.gates || [],
    name: j.name, region: j.region, rangeM: j.rangeM,
  }));
}
function applyMeta(m) {
  Object.assign(E.json, m);
  if (!m.sites.length) delete E.json.sites;
  if (!m.pads.length) delete E.json.pads;
  if (m.rangeM == null) delete E.json.rangeM;
  if (m.region == null || m.region === '') delete E.json.region;
}
function metaAction(fn) {
  const pre = cloneMeta();
  fn();
  const post = cloneMeta();
  pushUndo({ type: 'meta', pre, post });
  E.dirty.meta = true;
  E.needsDraw = true;
}
function pushUndo(a) { E.undo.push(a); if (E.undo.length > 60) E.undo.shift(); E.redo.length = 0; }

function applyPatch(a, dir) {
  const data = dir === 'undo' ? a.pre : a.post;
  const arr = a.type === 'heights' ? E.elev : E.surf;
  for (let r = 0; r < a.h; r++) arr.set(data.subarray(r * a.w, (r + 1) * a.w), idx(a.x, a.y + r));
  renderBase(a.x - 1, a.y - 1, a.x + a.w, a.y + a.h);
  E.dirty[a.type] = true;
  if (E.viewshed && a.type === 'heights') runViewshed(E.viewshed.n, E.viewshed.e, E.viewshed.eyeM);
}
function doUndoRedo(which) {
  const from = which === 'undo' ? E.undo : E.redo, to = which === 'undo' ? E.redo : E.undo;
  const a = from.pop();
  if (!a) return;
  to.push(a);
  if (a.type === 'meta') { applyMeta(which === 'undo' ? a.pre : a.post); E.dirty.meta = true; E.sel = null; renderPanel(); }
  else applyPatch(a, which);
  E.needsDraw = true;
}

/* ======================================================== tools + input */
function bindOnce() {
  if (bindOnce.done) return;
  bindOnce.done = true;

  const cv = $('#edCanvas');
  new ResizeObserver(() => { if (E) resize(); }).observe($('#edCanvasWrap'));

  $('#edTools').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b) setTool(b.dataset.tool);
  });
  $('#edFit').onclick = () => fit();
  $('#edUndo').onclick = () => doUndoRedo('undo');
  $('#edRedo').onclick = () => doUndoRedo('redo');
  $('#edSave').onclick = save;
  $('#edPub').onchange = () => { localStorage.setItem(PUB_KEY, $('#edPub').checked ? 'on' : 'off'); syncSaveLabel(); };
  syncSaveLabel();
  $('#edFly').onclick = () => {
    navigator.clipboard?.writeText(`${location.origin}/library/`).catch(() => {});
    toast('Opening Flightline. Library URL copied — paste into Settings → Map → Map library, pick your map.');
    window.open('http://localhost:5178', '_blank');
  };

  window.addEventListener('keydown', (ev) => {
    if (!E || $('#view-edit').hidden) return;
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'SELECT') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') { ev.preventDefault(); doUndoRedo('undo'); }
    else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'y' || (ev.shiftKey && ev.key === 'Z'))) { ev.preventDefault(); doUndoRedo('redo'); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') deleteSelection();
    else if (ev.key === 'Escape') { E.wirePending = null; E.sel = null; renderPanel(); E.needsDraw = true; }
    else if (ev.key === 'f') fit();
  });

  cv.addEventListener('wheel', (ev) => {
    if (!E) return;
    ev.preventDefault();
    const f = Math.exp(-ev.deltaY * 0.0013);
    const [n, e] = NEofScr(ev.offsetX, ev.offsetY);
    E.cam.k = Math.max(0.02, Math.min(40, E.cam.k * f));
    const u = e - E.originNE[1], v = E.originNE[0] - n;
    E.cam.u = u - ev.offsetX / E.cam.k;
    E.cam.v = v - ev.offsetY / E.cam.k;
    E.needsDraw = true;
  }, { passive: false });

  cv.addEventListener('contextmenu', (ev) => ev.preventDefault()); // right-drag pans
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointerleave', () => { E && (E.pointer = null, E.needsDraw = true); });
}

function setTool(t) {
  E.tool = t;
  E.wirePending = null;
  for (const b of document.querySelectorAll('#edTools button')) b.classList.toggle('on', b.dataset.tool === t);
  renderPanel();
  E.needsDraw = true;
}

function onDown(ev) {
  const cv = $('#edCanvas');
  cv.setPointerCapture(ev.pointerId);
  const x = ev.offsetX, y = ev.offsetY;
  const [n, e] = NEofScr(x, y);

  if (ev.button === 1 || ev.button === 2 || ev.shiftKey) { E.panning = { x, y }; return; }

  if (E.tool === 'terrain' || E.tool === 'surface') return startStroke(n, e);

  if (E.tool === 'view') {
    if (inGrid(n, e)) { runViewshed(n, e, E.viewshed ? E.viewshed.eyeM : 1.7); renderPanel(); }
    return;
  }

  // everything else: grab what is under the cursor first
  const hit = hitTest(n, e);
  if (hit) {
    E.sel = hit;
    E.dragging = { hit, start: [n, e], pre: cloneMeta(), moved: false };
    renderPanel();
    E.needsDraw = true;
    return;
  }

  if (E.tool === 'sites') return addSite(n, e);
  if (E.tool === 'starts') return addStart(n, e);
  if (E.tool === 'pads') return addPad(n, e);
  if (E.tool === 'objects') return addObject(n, e);

  // select tool on empty ground: pan
  E.sel = null;
  renderPanel();
  E.panning = { x, y };
  E.needsDraw = true;
}

function onMove(ev) {
  if (!E) return;
  const x = ev.offsetX, y = ev.offsetY;
  E.pointer = [x, y];
  const [n, e] = NEofScr(x, y);

  const el = elevAt(Math.max(E.originNE[0] - (E.rows - 1) * E.cell, Math.min(E.originNE[0], n)),
    Math.max(E.originNE[1], Math.min(E.originNE[1] + (E.cols - 1) * E.cell, e)));
  const cls = E.surf ? SURFACE_NAMES[E.surf[idx(
    Math.round(Math.max(0, Math.min(E.cols - 1, CRofNE(n, e)[0]))),
    Math.round(Math.max(0, Math.min(E.rows - 1, CRofNE(n, e)[1]))))]] : '';
  $('#edReadout').textContent =
    `N ${n.toFixed(0)}  E ${e.toFixed(0)}   ${el.toFixed(1)} m ASL  (${(el - (E.json.origin.datumElevM || 0)).toFixed(1)} m up)` + (cls ? `   ${cls}` : '');

  if (E.panning) {
    E.cam.u -= (x - E.panning.x) / E.cam.k;
    E.cam.v -= (y - E.panning.y) / E.cam.k;
    E.panning = { x, y };
    E.needsDraw = true;
    return;
  }
  if (E.stroke) return moveStroke(n, e);
  if (E.dragging) return moveDrag(n, e);
  E.needsDraw = true; // brush cursor follows
}

function onUp() {
  if (!E) return;
  E.panning = null;
  if (E.stroke) endStroke();
  if (E.dragging) {
    const d = E.dragging;
    E.dragging = null;
    if (d.moved) {
      pushUndo({ type: 'meta', pre: d.pre, post: cloneMeta() });
      E.dirty.meta = true;
      if (d.hit.kind === 'pilot') pilotMovedNote();
      renderPanel();
    }
  }
}

/* --------------------------------------------------------- hit testing */
function hitTest(n, e) {
  const tol = 10 / E.cam.k; // 10 px in metres
  const j = E.json;
  const near = (p) => Math.hypot(p.n - n, p.e - e) < tol;
  if (near(j.pilot)) return { kind: 'pilot', i: 0 };
  for (const [i, s] of (j.sites || []).entries()) if (near(s)) return { kind: 'site', i };
  for (const [i, s] of (j.starts || []).entries()) if (near(s)) return { kind: 'start', i };
  for (const [i, gq] of (j.gates || []).entries()) if (near(gq)) return { kind: 'gate', i };
  for (const [i, o] of (j.obstacles || []).entries()) {
    if (o.t === 'wire') {
      if (distToSeg(n, e, o.a, o.b) < tol) return { kind: 'obstacle', i };
    } else if (o.t === 'building') {
      if (Math.abs(o.n - n) < o.sizeN / 2 + tol / 2 && Math.abs(o.e - e) < o.sizeE / 2 + tol / 2) return { kind: 'obstacle', i };
    } else if (near(o)) return { kind: 'obstacle', i };
  }
  for (const [i, p] of (j.pads || []).entries()) {
    const a = (p.yawDeg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    const dn = n - p.n, de = e - p.e;
    if (Math.abs(dn * cs + de * sn) < p.lengthM / 2 + tol / 2 && Math.abs(-dn * sn + de * cs) < p.widthM / 2 + tol / 2) return { kind: 'pad', i };
  }
  return null;
}
function distToSeg(n, e, a, b) {
  const dn = b.n - a.n, de = b.e - a.e;
  const L2 = dn * dn + de * de || 1;
  const t = Math.max(0, Math.min(1, ((n - a.n) * dn + (e - a.e) * de) / L2));
  return Math.hypot(n - (a.n + t * dn), e - (a.e + t * de));
}

function moveDrag(n, e) {
  const d = E.dragging;
  const [n0, e0] = d.start;
  const dn = n - n0, de = e - e0;
  if (Math.hypot(dn, de) < 0.5) return;
  d.moved = true;
  const j = E.json;
  const pre = d.pre;
  if (d.hit.kind === 'pilot') {
    // the pilot carries the pilot-anchored starts and (if it matched) home — same rule as flmap sites --pilot
    const old = pre.pilot;
    j.pilot = { ...old, n: r1(old.n + dn), e: r1(old.e + de) };
    if (pre.home && pre.home.n === old.n && pre.home.e === old.e) j.home = { ...pre.home, n: j.pilot.n, e: j.pilot.e };
    j.starts = pre.starts.map((s) => s.anchor === 'map' ? s : { ...s, n: r1(s.n + dn), e: r1(s.e + de) });
  } else if (d.hit.kind === 'site') j.sites[d.hit.i] = { ...pre.sites[d.hit.i], n: r1(pre.sites[d.hit.i].n + dn), e: r1(pre.sites[d.hit.i].e + de) };
  else if (d.hit.kind === 'start') j.starts[d.hit.i] = { ...pre.starts[d.hit.i], n: r1(pre.starts[d.hit.i].n + dn), e: r1(pre.starts[d.hit.i].e + de) };
  else if (d.hit.kind === 'gate') j.gates[d.hit.i] = { ...pre.gates[d.hit.i], n: r1(pre.gates[d.hit.i].n + dn), e: r1(pre.gates[d.hit.i].e + de) };
  else if (d.hit.kind === 'pad') j.pads[d.hit.i] = { ...pre.pads[d.hit.i], n: r1(pre.pads[d.hit.i].n + dn), e: r1(pre.pads[d.hit.i].e + de) };
  else if (d.hit.kind === 'obstacle') {
    const o = pre.obstacles[d.hit.i];
    j.obstacles[d.hit.i] = o.t === 'wire'
      ? { ...o, a: { ...o.a, n: r1(o.a.n + dn), e: r1(o.a.e + de) }, b: { ...o.b, n: r1(o.b.n + dn), e: r1(o.b.e + de) } }
      : { ...o, n: r1(o.n + dn), e: r1(o.e + de) };
  }
  E.needsDraw = true;
}
const r1 = (v) => +(+v).toFixed(1);

function pilotMovedNote() {
  const g = elevAt(E.json.pilot.n, E.json.pilot.e);
  toast(`Stand point moved — pilot-anchored starts came along. Field elevation settles to ${g.toFixed(1)} m on save.`);
  if (E.viewshed) runViewshed(E.json.pilot.n, E.json.pilot.e, E.viewshed.eyeM);
}

function deleteSelection() {
  if (!E.sel || E.sel.kind === 'pilot') return;
  const { kind, i } = E.sel;
  metaAction(() => {
    const j = E.json;
    if (kind === 'site') j.sites.splice(i, 1);
    if (kind === 'start') j.starts.splice(i, 1);
    if (kind === 'pad') j.pads.splice(i, 1);
    if (kind === 'gate') j.gates.splice(i, 1);
    if (kind === 'obstacle') j.obstacles.splice(i, 1);
  });
  E.sel = null;
  renderPanel();
}

/* ------------------------------------------------------------ brushes */
function startStroke(n, e) {
  const arr = E.tool === 'terrain' ? E.elev : (E.surf || (E.surf = new Uint8Array(E.cols * E.rows)));
  E.stroke = {
    type: E.tool === 'terrain' ? 'heights' : 'surface',
    snap: arr.slice(),
    x0: E.cols, y0: E.rows, x1: -1, y1: -1,
    anchor: elevAt(n, e),
  };
  moveStroke(n, e);
}

function moveStroke(n, e) {
  const S = E.stroke;
  const [cc, cr] = CRofNE(n, e);
  const rad = E.brush.radiusM / E.cell;
  const c0 = Math.max(0, Math.floor(cc - rad)), c1 = Math.min(E.cols - 1, Math.ceil(cc + rad));
  const r0 = Math.max(0, Math.floor(cr - rad)), r1b = Math.min(E.rows - 1, Math.ceil(cr + rad));
  if (c1 < c0 || r1b < r0) return;
  S.x0 = Math.min(S.x0, c0); S.y0 = Math.min(S.y0, r0);
  S.x1 = Math.max(S.x1, c1); S.y1 = Math.max(S.y1, r1b);

  const { mode, strengthM, cls } = E.brush;
  for (let r = r0; r <= r1b; r++) {
    for (let c = c0; c <= c1; c++) {
      const d = Math.hypot(c - cc, r - cr) / rad;
      if (d > 1) continue;
      const k = 1 - d * d * (3 - 2 * d); // smooth falloff to the rim
      const i = idx(c, r);
      if (S.type === 'surface') { if (k > 0.3) E.surf[i] = cls; continue; }
      if (mode === 'raise') E.elev[i] += strengthM * k * 0.15;
      else if (mode === 'lower') E.elev[i] -= strengthM * k * 0.15;
      else if (mode === 'flatten') E.elev[i] += (S.anchor - E.elev[i]) * k * 0.3;
      else if (mode === 'smooth') {
        const cm = Math.max(1, Math.min(E.cols - 2, c)), rm = Math.max(1, Math.min(E.rows - 2, r));
        const avg = (E.elev[idx(cm - 1, rm)] + E.elev[idx(cm + 1, rm)] + E.elev[idx(cm, rm - 1)] + E.elev[idx(cm, rm + 1)]) / 4;
        E.elev[i] += (avg - E.elev[i]) * k * 0.5;
      }
    }
  }
  renderBase(c0 - 1, r0 - 1, c1 + 1, r1b + 1);
}

function endStroke() {
  const S = E.stroke;
  E.stroke = null;
  if (S.x1 < S.x0) return;
  const w = S.x1 - S.x0 + 1, h = S.y1 - S.y0 + 1;
  const arr = S.type === 'heights' ? E.elev : E.surf;
  const Ctor = S.type === 'heights' ? Float32Array : Uint8Array;
  const pre = new Ctor(w * h), post = new Ctor(w * h);
  for (let r = 0; r < h; r++) {
    pre.set(S.snap.subarray(idx(S.x0, S.y0 + r), idx(S.x0, S.y0 + r) + w), r * w);
    post.set(arr.subarray(idx(S.x0, S.y0 + r), idx(S.x0, S.y0 + r) + w), r * w);
  }
  pushUndo({ type: S.type, x: S.x0, y: S.y0, w, h, pre, post });
  E.dirty[S.type] = true;
  if (E.viewshed && S.type === 'heights') runViewshed(E.viewshed.n, E.viewshed.e, E.viewshed.eyeM);
}

/* -------------------------------------------------------- adding things */
function addSite(n, e) {
  if (!inGrid(n, e)) return;
  metaAction(() => {
    E.json.sites = E.json.sites || [];
    const name = `Site ${E.json.sites.length + 1}`;
    E.json.sites.push({ id: name.toLowerCase().replace(/\s+/g, '-'), name, n: r1(n), e: r1(e) });
    E.sel = { kind: 'site', i: E.json.sites.length - 1 };
  });
  renderPanel();
}

function addStart(n, e) {
  if (!inGrid(n, e)) return;
  const kind = document.querySelector('#edPanel [name=startKind]')?.value || 'ground';
  metaAction(() => {
    E.json.starts = E.json.starts || [];
    const id = `start-${Date.now() % 100000}`;
    const tpl = kind === 'hand'
      ? { id, name: 'In your hand', n: r1(n), e: r1(e), yawDeg: 0, aglM: 1.7, anchor: 'map', held: true }
      : kind === 'air'
        ? { id, name: 'In the air, 60 m', n: r1(n), e: r1(e), yawDeg: 0, aglM: 60, speedMs: 16, anchor: 'map' }
        : { id, name: 'On the ground', n: r1(n), e: r1(e), yawDeg: 0, aglM: 0, anchor: 'map' };
    E.json.starts.push(tpl);
    E.sel = { kind: 'start', i: E.json.starts.length - 1 };
  });
  renderPanel();
}

function addPad(n, e) {
  if (!inGrid(n, e)) return;
  metaAction(() => {
    E.json.pads = E.json.pads || [];
    E.json.pads.push({ kind: 'runway', n: r1(n), e: r1(e), yawDeg: 90, lengthM: 120, widthM: 10, surface: 'asphalt' });
    E.sel = { kind: 'pad', i: E.json.pads.length - 1 };
  });
  renderPanel();
}

function addObject(n, e) {
  if (!inGrid(n, e)) return;
  const o = E.obj;
  if (o.kind === 'wire') {
    if (!E.wirePending) { E.wirePending = { n: r1(n), e: r1(e) }; E.needsDraw = true; return; }
    const a = E.wirePending;
    E.wirePending = null;
    metaAction(() => {
      E.json.obstacles.push({ t: 'wire', a: { n: a.n, e: a.e, up: o.wireUp }, b: { n: r1(n), e: r1(e), up: o.wireUp }, r: 0.02, sagM: o.sag });
      E.sel = { kind: 'obstacle', i: E.json.obstacles.length - 1 };
    });
  } else if (o.kind === 'forest') {
    // a scatter stroke: pointerdown plants one stamp; dragging plants more
    E.stroke = null;
    const pre = cloneMeta();
    stampForest(n, e);
    E.dragging = null;
    E.forestStroke = { pre, last: [n, e] };
    const cv = $('#edCanvas');
    const move = (ev) => {
      const [nn, ee] = NEofScr(ev.offsetX, ev.offsetY);
      const [ln, le] = E.forestStroke.last;
      if (Math.hypot(nn - ln, ee - le) > o.forestR * 0.7) { stampForest(nn, ee); E.forestStroke.last = [nn, ee]; }
    };
    const up = () => {
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      pushUndo({ type: 'meta', pre: E.forestStroke.pre, post: cloneMeta() });
      E.dirty.meta = true;
      E.forestStroke = null;
      renderPanel();
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
  } else {
    metaAction(() => {
      const list = E.json.obstacles;
      if (o.kind === 'tree') list.push({ t: 'tree', n: r1(n), e: r1(e), r: o.treeR, h: o.treeH });
      if (o.kind === 'building') list.push({ t: 'building', n: r1(n), e: r1(e), sizeN: o.bSizeN, sizeE: o.bSizeE, h: o.bH, roof: o.roof });
      if (o.kind === 'pole') list.push({ t: 'pole', n: r1(n), e: r1(e), r: 0.16, h: 10 });
      if (o.kind === 'gate') list.push({ t: 'gate', n: r1(n), e: r1(e), yawDeg: 0, widthM: o.gateW, heightM: o.gateH, baseM: 0 });
      if (o.kind === 'target') list.push({ t: 'target', n: r1(n), e: r1(e), kind: 'hiker' });
      E.sel = { kind: 'obstacle', i: list.length - 1 };
    });
    renderPanel();
  }
}

function stampForest(n, e) {
  const o = E.obj;
  for (let i = 0; i < o.density; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * o.forestR;
    const tn = n + Math.cos(a) * d, te = e + Math.sin(a) * d;
    if (!inGrid(tn, te)) continue;
    E.json.obstacles.push({
      t: 'tree', n: r1(tn), e: r1(te),
      r: +(1.5 + Math.random() * 2.2).toFixed(1),
      h: +(5 + Math.random() * 7).toFixed(1),
    });
  }
  E.dirty.meta = true;
  E.needsDraw = true;
}

/* ----------------------------------------------------------- viewshed */
function runViewshed(n, e, eyeM) {
  const t0 = performance.now();
  const { cols, rows, cell } = E;
  const mask = new Uint8Array(cols * rows); // 0 unseen-yet, 1 visible, 2 hidden
  const horizon = new Float32Array(360).fill(-90);
  const [u0, v0] = CRofNE(n, e); // fractional posts
  const eye = elevAt(n, e) + eyeM;

  const corners = [[0, 0], [cols - 1, 0], [0, rows - 1], [cols - 1, rows - 1]];
  const maxR = Math.max(...corners.map(([c, r]) => Math.hypot(c - u0, r - v0)));
  const rays = Math.min(4096, Math.max(720, Math.ceil(2 * Math.PI * maxR)));
  const step = 0.6;

  for (let a = 0; a < rays; a++) {
    const th = (a / rays) * 2 * Math.PI;
    const dc = Math.cos(th), dr = Math.sin(th);
    // compass azimuth of this ray: east = +c, north = -r
    const az = ((Math.atan2(dc, -dr) * 180) / Math.PI + 360) % 360;
    const bin = Math.floor(az);
    let maxAng = -Infinity;
    for (let t = step; t <= maxR; t += step) {
      const c = u0 + dc * t, r = v0 + dr * t;
      if (c < 0 || c > cols - 1 || r < 0 || r > rows - 1) break;
      const c0 = Math.floor(c), r0 = Math.floor(r), tc = c - c0, tr = r - r0;
      const el = E.elev[idx(c0, r0)] * (1 - tc) * (1 - tr) + E.elev[idx(Math.min(cols - 1, c0 + 1), r0)] * tc * (1 - tr)
        + E.elev[idx(c0, Math.min(rows - 1, r0 + 1))] * (1 - tc) * tr + E.elev[idx(Math.min(cols - 1, c0 + 1), Math.min(rows - 1, r0 + 1))] * tc * tr;
      const ang = Math.atan2(el - eye, t * cell);
      const i = idx(Math.round(c), Math.round(r));
      if (ang >= maxAng - 1e-4) { mask[i] = 1; if (ang > maxAng) maxAng = ang; }
      else if (mask[i] === 0) mask[i] = 2;
    }
    const deg = (maxAng * 180) / Math.PI;
    if (deg > horizon[bin]) horizon[bin] = deg;
  }
  // fill any horizon bins no ray landed in
  for (let b = 0; b < 360; b++) if (horizon[b] === -90) horizon[b] = horizon[(b + 359) % 360];

  // paint the mask once into its own canvas
  const vc = document.createElement('canvas');
  vc.width = cols; vc.height = rows;
  const vctx = vc.getContext('2d');
  const im = vctx.createImageData(cols, rows);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) { // hidden (or never reached — also hidden from here)
      im.data[i * 4] = 225; im.data[i * 4 + 1] = 60; im.data[i * 4 + 2] = 60; im.data[i * 4 + 3] = 88;
    }
  }
  vctx.putImageData(im, 0, 0);

  const open = [...Array(16)].filter((_, k) => {
    const b0 = Math.floor((k * 360) / 16), b1 = Math.floor(((k + 1) * 360) / 16);
    let worst = -90;
    for (let b = b0; b < b1; b++) worst = Math.max(worst, horizon[b]);
    return worst < SKY_DEG;
  }).length;

  E.viewshed = { mask, canvas: vc, n: r1(n), e: r1(e), eyeM, horizon, open, ms: Math.round(performance.now() - t0) };
  E.needsDraw = true;
  if (E.tool === 'view') renderPanel();
}

function drawHorizonStrip(canvas) {
  const H = E.viewshed.horizon;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, Ht = canvas.height;
  ctx.clearRect(0, 0, W, Ht);
  const yOf = (deg) => Ht - ((Math.max(-5, Math.min(45, deg)) + 5) / 50) * Ht;
  // sky threshold line
  ctx.strokeStyle = '#4da3ff88';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, yOf(SKY_DEG)); ctx.lineTo(W, yOf(SKY_DEG)); ctx.stroke();
  ctx.setLineDash([]);
  // the mountains
  ctx.fillStyle = '#e06c5f55';
  ctx.strokeStyle = '#e06c5f';
  ctx.beginPath();
  ctx.moveTo(0, Ht);
  for (let b = 0; b < 360; b++) ctx.lineTo((b / 359) * W, yOf(H[b]));
  ctx.lineTo(W, Ht);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#8a94a6'; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
  for (const [t, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 359]]) ctx.fillText(t, (az / 359) * W, 10);
  ctx.textAlign = 'left';
}

/* ------------------------------------------------------------- panels */
function renderPanel() {
  if (!E) return;
  const P = $('#edPanel');
  const j = E.json;
  const t = E.tool;
  let html = '';

  if (t === 'select') {
    html = '<h3>Select</h3><span class="note">Click anything to select it; drag to move it. Delete removes it. Drag empty ground to pan, scroll to zoom.</span>';
    html += selectionFields();
  }

  if (t === 'sites') {
    html = `<h3>Where you stand</h3>
      <span class="note">The orange marker is the default stand point — drag it somewhere you can actually see from (check with the View tool). Click the map to add an alternative; the sim lists them under Settings → Map.</span>
      <div class="item" data-pick="pilot"><b style="color:#ff9c3f">●</b> Default stand point <span class="spacer"></span><span class="mono">${j.pilot.n.toFixed(0)}, ${j.pilot.e.toFixed(0)}</span></div>
      ${(j.sites || []).map((s, i) => `
        <div class="item ${isSel('site', i) ? 'sel' : ''}" data-site="${i}">⚑ ${esc(s.name)}
          <span class="spacer"></span>
          <button data-stand="${i}" title="Make this the default stand point">stand</button>
          <button data-del-site="${i}" title="Remove">✕</button>
        </div>`).join('')}
      <div class="formButtons"><button id="btnPropose" class="ghost">Propose spots for me</button></div>
      <div id="proposals"></div>`;
    html += selectionFields();
  }

  if (t === 'view') {
    const v = E.viewshed;
    html = `<h3>Line of sight</h3>
      <span class="note">Click anywhere: red is ground you <b>cannot</b> see from there, standing at eye height. The strip below is the horizon in every direction — peaks above the dashed line (${SKY_DEG}°) are mountains in your face.</span>
      <label>Eye height <input type="number" name="eyeM" step="0.1" value="${v ? v.eyeM : 1.7}"> m</label>
      <div class="formButtons">
        <button id="btnVsPilot" class="ghost">From the stand point</button>
        ${v ? '<button id="btnVsClear" class="ghost">Clear</button>' : ''}
      </div>
      ${v ? `
        <canvas id="horizonStrip" width="270" height="92"></canvas>
        <div class="statline">Open directions: <b>${v.open} / 16</b> below ${SKY_DEG}° &nbsp;·&nbsp; highest horizon <b>${Math.max(...v.horizon).toFixed(0)}°</b></div>
        <div class="statline">From N ${v.n}, E ${v.e} at ${v.eyeM} m &nbsp;·&nbsp; ${v.ms} ms</div>
        <div class="formButtons"><button id="btnVsStand" class="primary">Stand here</button></div>` : ''}`;
  }

  if (t === 'starts') {
    html = `<h3>Starts</h3>
      <span class="note">Positions the sim's menu offers. Click the map to add one. <code>anchor: pilot</code> starts follow the stand point when it moves; <code>map</code> starts (a runway) stay put.</span>
      <label>New start is <select name="startKind">
        <option value="ground">On the ground</option>
        <option value="hand">A hand launch (held)</option>
        <option value="air">In the air</option>
      </select></label>
      ${(j.starts || []).map((s, i) => `
        <div class="item ${isSel('start', i) ? 'sel' : ''}" data-start="${i}">➹ ${esc(s.name || s.id)}
          <span class="spacer"></span><span class="mono">${s.aglM > 0 ? `${s.aglM} m` : 'ground'}</span>
          <button data-del-start="${i}">✕</button>
        </div>`).join('')}`;
    html += selectionFields();
  }

  if (t === 'pads') {
    html = `<h3>Runways and pads</h3>
      <span class="note">Click the map to lay a runway, then set its heading and size here. Flattening levels the heightfield under it, feathered over 15 m.</span>
      ${(j.pads || []).map((p, i) => `
        <div class="item ${isSel('pad', i) ? 'sel' : ''}" data-pad="${i}">▭ ${p.kind} ${p.lengthM}×${p.widthM} m @ ${p.yawDeg}°
          <span class="spacer"></span><button data-del-pad="${i}">✕</button>
        </div>`).join('')}`;
    html += selectionFields();
  }

  if (t === 'terrain') {
    const b = E.brush;
    html = `<h3>Terrain</h3>
      ${E.colorData ? '<span class="note">⚠ This heightfield is measured lidar. Carving a launch ledge or a strip is fine — just know the photo will no longer match the ground you moved.</span>' : ''}
      <div class="objButtons">
        ${['raise', 'lower', 'flatten', 'smooth'].map((m) => `<button data-bmode="${m}" class="${b.mode === m ? 'on' : ''}">${m}</button>`).join('')}
      </div>
      <label>Brush radius <b>${b.radiusM} m</b><input type="range" name="radiusM" min="5" max="400" value="${b.radiusM}"></label>
      <label>Strength <b>${b.strengthM} m</b><input type="range" name="strengthM" min="1" max="40" value="${b.strengthM}"></label>
      <span class="note">Flatten pulls toward the height where the stroke began.</span>`;
  }

  if (t === 'surface') {
    const b = E.brush;
    html = `<h3>Surface classes</h3>
      <span class="note">What the ground is, per post: it sets terrain colour (where there is no photo), the lidar rangefinder's return, and water is near-invisible to it.</span>
      <div class="swatches">
        ${SURFACE_NAMES.map((nm, i) => `<button data-cls="${i}" class="${b.cls === i ? 'on' : ''}" style="border-color: rgb(${SURF_COLOR[i]})">${nm}</button>`).join('')}
      </div>
      <label>Brush radius <b>${b.radiusM} m</b><input type="range" name="radiusM" min="5" max="400" value="${b.radiusM}"></label>
      ${E.colorData ? `<label class="check" style="color:var(--ink)"><input type="checkbox" id="chkClasses" ${E.showClasses ? 'checked' : ''}> Show classes over the photo</label>` : ''}
      ${!E.surf ? '<span class="note">This map has no surface grid yet — the first stroke creates one (everything else stays "unknown").</span>' : ''}`;
  }

  if (t === 'objects') {
    const o = E.obj;
    const kinds = [['tree', '🌲 Tree'], ['forest', '🌳 Forest'], ['building', '🏠 Building'], ['pole', '📍 Pole'], ['wire', '🔌 Wire'], ['gate', '⊓ Gate'], ['target', '🎯 Target']];
    html = `<h3>Objects</h3>
      <span class="note">Everything you can hit. All of it sits on the ground and the sim renders and collides it. Select + Delete removes one.</span>
      <div class="objButtons">
        ${kinds.map(([k, lab]) => `<button data-obj="${k}" class="${o.kind === k ? 'on' : ''}">${lab}</button>`).join('')}
      </div>
      ${o.kind === 'tree' ? `
        <label>Crown radius <input type="number" name="treeR" value="${o.treeR}" step="0.2"> m</label>
        <label>Height <input type="number" name="treeH" value="${o.treeH}" step="0.5"> m</label>` : ''}
      ${o.kind === 'forest' ? `
        <label>Stamp radius <b>${o.forestR} m</b><input type="range" name="forestR" min="10" max="150" value="${o.forestR}"></label>
        <label>Trees per stamp <input type="number" name="density" value="${o.density}" min="1" max="25"></label>
        <span class="note">Click and drag to plant. Sizes vary on their own.</span>` : ''}
      ${o.kind === 'building' ? `
        <label>Size N <input type="number" name="bSizeN" value="${o.bSizeN}" step="0.5"> m</label>
        <label>Size E <input type="number" name="bSizeE" value="${o.bSizeE}" step="0.5"> m</label>
        <label>Height <input type="number" name="bH" value="${o.bH}" step="0.2"> m</label>
        <label>Roof <select name="roof"><option ${o.roof === 'gable' ? 'selected' : ''}>gable</option><option ${o.roof === 'flat' ? 'selected' : ''}>flat</option></select></label>
        <span class="note">Boxes are axis-aligned (a format v1 rule) — size N runs north-south.</span>` : ''}
      ${o.kind === 'wire' ? `
        <label>Height at the poles <input type="number" name="wireUp" value="${o.wireUp}" step="0.5"> m</label>
        <label>Sag <input type="number" name="sag" value="${o.sag}" step="0.1"> m</label>
        <span class="note">Two clicks: one per end. Height is above the terrain at each end.</span>` : ''}
      ${o.kind === 'gate' ? `
        <label>Width <input type="number" name="gateW" value="${o.gateW}" step="0.1"> m</label>
        <label>Height <input type="number" name="gateH" value="${o.gateH}" step="0.1"> m</label>` : ''}
      <div class="statline">${(j.obstacles || []).length} objects on the map</div>`;
    html += selectionFields();
  }

  P.innerHTML = html;
  bindPanel();
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Editable fields for whatever is selected, appended under several tools. */
function selectionFields() {
  if (!E.sel) return '';
  const { kind, i } = E.sel;
  const j = E.json;
  const F = (label, name, val, step = 1) =>
    `<label>${label} <input type="number" data-f="${name}" value="${val}" step="${step}"></label>`;
  const T = (label, name, val) =>
    `<label>${label} <input type="text" data-f="${name}" value="${esc(val)}"></label>`;
  let f = '';
  if (kind === 'site') { const s = j.sites[i]; f = T('Name', 'name', s.name) + F('N', 'n', s.n) + F('E', 'e', s.e); }
  if (kind === 'pilot') f = F('N', 'n', j.pilot.n) + F('E', 'e', j.pilot.e) + `<span class="note">Moving this carries the pilot-anchored starts, and the field elevation follows on save.</span>`;
  if (kind === 'start') {
    const s = j.starts[i];
    f = T('Name', 'name', s.name || '') + F('Heading °', 'yawDeg', s.yawDeg || 0, 5) + F('Height AGL', 'aglM', s.aglM || 0, 1)
      + F('Speed m/s', 'speedMs', s.speedMs || 0, 1)
      + `<label>Anchor <select data-f="anchor"><option ${s.anchor !== 'map' ? 'selected' : ''}>pilot</option><option ${s.anchor === 'map' ? 'selected' : ''}>map</option></select></label>`
      + `<label class="check" style="color:var(--ink)"><input type="checkbox" data-f="held" ${s.held ? 'checked' : ''}> Held in your hand until thrown</label>`;
  }
  if (kind === 'pad') {
    const p = j.pads[i];
    f = `<label>Kind <select data-f="kind"><option ${p.kind === 'runway' ? 'selected' : ''}>runway</option><option ${p.kind === 'pad' ? 'selected' : ''}>pad</option></select></label>`
      + F('Heading °', 'yawDeg', p.yawDeg, 5) + F('Length', 'lengthM', p.lengthM, 5) + F('Width', 'widthM', p.widthM, 1)
      + `<label>Surface <select data-f="surface">${SURFACE_NAMES.map((nm) => `<option ${p.surface === nm ? 'selected' : ''}>${nm}</option>`).join('')}</select></label>`
      + `<div class="formButtons"><button id="btnFlatten" class="primary">Flatten the ground under it</button></div>`
      + `<div class="formButtons"><button id="btnPadStart" class="ghost">Add a start on it</button></div>`;
  }
  if (kind === 'obstacle') {
    const o = j.obstacles[i];
    if (o.t === 'tree') f = F('Crown radius', 'r', o.r, 0.2) + F('Height', 'h', o.h, 0.5);
    if (o.t === 'building') f = F('Size N', 'sizeN', o.sizeN, 0.5) + F('Size E', 'sizeE', o.sizeE, 0.5) + F('Height', 'h', o.h, 0.2);
    if (o.t === 'pole') f = F('Radius', 'r', o.r, 0.02) + F('Height', 'h', o.h, 0.5);
    if (o.t === 'wire') f = F('Height a', 'a.up', o.a.up, 0.5) + F('Height b', 'b.up', o.b.up, 0.5) + F('Sag', 'sagM', o.sagM || 0, 0.1);
    if (o.t === 'gate') f = F('Heading °', 'yawDeg', o.yawDeg || 0, 5) + F('Width', 'widthM', o.widthM, 0.1) + F('Height', 'heightM', o.heightM, 0.1) + F('Base above ground', 'baseM', o.baseM || 0, 0.5);
  }
  if (!f) return '';
  return `<hr style="border-color:var(--line)"><h3>Selected: ${kind}</h3>${f}`;
}

function bindPanel() {
  const P = $('#edPanel');

  P.onclick = async (ev) => {
    const b = ev.target.closest('button');
    if (!b) {
      const item = ev.target.closest('.item');
      if (item) selectFromItem(item);
      return;
    }
    if (b.dataset.bmode) { E.brush.mode = b.dataset.bmode; renderPanel(); }
    if (b.dataset.cls != null) { E.brush.cls = +b.dataset.cls; renderPanel(); }
    if (b.dataset.obj) { E.obj.kind = b.dataset.obj; E.wirePending = null; renderPanel(); }
    if (b.dataset.stand != null) standAt(E.json.sites[+b.dataset.stand]);
    if (b.dataset.delSite != null) { E.sel = { kind: 'site', i: +b.dataset.delSite }; deleteSelection(); }
    if (b.dataset.delStart != null) { E.sel = { kind: 'start', i: +b.dataset.delStart }; deleteSelection(); }
    if (b.dataset.delPad != null) { E.sel = { kind: 'pad', i: +b.dataset.delPad }; deleteSelection(); }
    if (b.id === 'btnFlatten') flattenPad();
    if (b.id === 'btnPadStart') padStart();
    if (b.id === 'btnVsPilot') { runViewshed(E.json.pilot.n, E.json.pilot.e, eyeVal()); renderPanel(); }
    if (b.id === 'btnVsClear') { E.viewshed = null; E.needsDraw = true; renderPanel(); }
    if (b.id === 'btnVsStand') standAt(E.viewshed);
    if (b.id === 'btnPropose') proposeSpots(b);
    if (b.dataset.useProp != null) {
      const s = proposeSpots.list[+b.dataset.useProp];
      metaAction(() => {
        E.json.sites = E.json.sites || [];
        E.json.sites.push({ id: s.suggested.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: s.suggested, n: r1(s.n), e: r1(s.e) });
      });
      renderPanel();
    }
  };

  P.onchange = (ev) => {
    const el = ev.target;
    if (el.name === 'radiusM') { E.brush.radiusM = +el.value; renderPanel(); return; }
    if (el.name === 'strengthM') { E.brush.strengthM = +el.value; renderPanel(); return; }
    if (el.name === 'eyeM' && E.viewshed) { runViewshed(E.viewshed.n, E.viewshed.e, +el.value || 1.7); renderPanel(); return; }
    if (el.id === 'chkClasses') { E.showClasses = el.checked; renderBase(0, 0, E.cols - 1, E.rows - 1); return; }
    if (el.name in E.obj) { E.obj[el.name] = el.type === 'number' || el.type === 'range' ? +el.value : el.value; if (el.type === 'range') renderPanel(); return; }
    if (el.name === 'roof') { E.obj.roof = el.value; return; }
    if (el.dataset.f) fieldEdit(el);
  };

  const strip = $('#horizonStrip');
  if (strip && E.viewshed) drawHorizonStrip(strip);
}

function selectFromItem(item) {
  if (item.dataset.pick === 'pilot') E.sel = { kind: 'pilot', i: 0 };
  if (item.dataset.site != null) E.sel = { kind: 'site', i: +item.dataset.site };
  if (item.dataset.start != null) E.sel = { kind: 'start', i: +item.dataset.start };
  if (item.dataset.pad != null) E.sel = { kind: 'pad', i: +item.dataset.pad };
  renderPanel();
  E.needsDraw = true;
}

function eyeVal() { return +(document.querySelector('#edPanel [name=eyeM]')?.value) || 1.7; }

function fieldEdit(el) {
  const { kind, i } = E.sel || {};
  if (!kind) return;
  const f = el.dataset.f;
  const val = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? +el.value : el.value);
  metaAction(() => {
    const j = E.json;
    const tgt = kind === 'pilot' ? j.pilot : kind === 'site' ? j.sites[i] : kind === 'start' ? j.starts[i]
      : kind === 'pad' ? j.pads[i] : kind === 'gate' ? j.gates[i] : j.obstacles[i];
    if (kind === 'pilot' && (f === 'n' || f === 'e')) { // field edit of the pilot moves it with its rule
      const n = f === 'n' ? val : j.pilot.n, e = f === 'e' ? val : j.pilot.e;
      movePilotTo(n, e);
      return;
    }
    if (f.includes('.')) { const [a, b] = f.split('.'); tgt[a][b] = val; }
    else if (f === 'held') { if (val) tgt.held = true; else delete tgt.held; }
    else tgt[f] = val;
    if (kind === 'start' && f === 'speedMs' && val === 0) delete tgt.speedMs; // speed 0 means prop hang — only keep it when meant
  });
  renderPanel();
}

function movePilotTo(n, e) {
  const j = E.json;
  const old = { ...j.pilot };
  const dn = n - old.n, de = e - old.e;
  if (j.home && j.home.n === old.n && j.home.e === old.e) j.home = { ...j.home, n: r1(n), e: r1(e) };
  j.pilot = { ...j.pilot, n: r1(n), e: r1(e) };
  j.starts = (j.starts || []).map((s) => s.anchor === 'map' ? s : { ...s, n: r1(s.n + dn), e: r1(s.e + de) });
}

function standAt(spot) {
  if (!spot) return;
  metaAction(() => movePilotTo(spot.n, spot.e));
  pilotMovedNote();
  renderPanel();
}

function flattenPad() {
  const p = E.json.pads[E.sel.i];
  const level = elevAt(p.n, p.e);
  const cs = Math.cos((p.yawDeg * Math.PI) / 180), sn = Math.sin((p.yawDeg * Math.PI) / 180);
  const snap = E.elev.slice();
  let x0 = E.cols, y0 = E.rows, x1 = -1, y1 = -1;
  for (let r = 0; r < E.rows; r++) {
    for (let c = 0; c < E.cols; c++) {
      const [n, e] = NEofCR(c, r);
      const dn = n - p.n, de = e - p.e;
      const along = Math.abs(dn * cs + de * sn), across = Math.abs(-dn * sn + de * cs);
      const k = Math.max(0, Math.min(1, Math.min(1 - (along - p.lengthM / 2) / 15, 1 - (across - p.widthM / 2) / 15)));
      if (k <= 0) continue;
      const i = idx(c, r);
      E.elev[i] = E.elev[i] * (1 - k) + level * k;
      x0 = Math.min(x0, c); y0 = Math.min(y0, r); x1 = Math.max(x1, c); y1 = Math.max(y1, r);
    }
  }
  if (x1 < x0) return;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const pre = new Float32Array(w * h), post = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    pre.set(snap.subarray(idx(x0, y0 + r), idx(x0, y0 + r) + w), r * w);
    post.set(E.elev.subarray(idx(x0, y0 + r), idx(x0, y0 + r) + w), r * w);
  }
  pushUndo({ type: 'heights', x: x0, y: y0, w, h, pre, post });
  E.dirty.heights = true;
  renderBase(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  if (E.viewshed) runViewshed(E.viewshed.n, E.viewshed.e, E.viewshed.eyeM);
  toast(`Flattened to ${level.toFixed(1)} m, feathered over 15 m. Save to keep it.`);
}

function padStart() {
  const p = E.json.pads[E.sel.i];
  const cs = Math.cos((p.yawDeg * Math.PI) / 180), sn = Math.sin((p.yawDeg * Math.PI) / 180);
  metaAction(() => {
    E.json.starts = E.json.starts || [];
    E.json.starts.push({
      id: `runway-${E.json.starts.length}`, name: 'On the runway',
      n: r1(p.n - (p.lengthM / 2 - 8) * cs), e: r1(p.e - (p.lengthM / 2 - 8) * sn),
      yawDeg: p.yawDeg, aglM: 0, anchor: 'map',
    });
    E.sel = { kind: 'start', i: E.json.starts.length - 1 };
  });
  setTool('starts');
}

async function proposeSpots(btn) {
  btn.disabled = true;
  btn.textContent = 'Reading the heightfield…';
  try {
    const r = await api(`/api/map/${E.id}/propose?count=6`);
    proposeSpots.list = r.sites;
    $('#proposals').innerHTML = r.sites.length
      ? r.sites.map((s, i) => `
        <div class="item">☆ ${esc(s.suggested)}
          <span class="spacer"></span><span class="mono">${s.open}/16 open</span>
          <button data-use-prop="${i}">+ add</button>
        </div>`).join('')
      : '<span class="note">Nothing qualified — this map is all walls. Try the View tool to hunt by hand.</span>';
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
  btn.textContent = 'Propose spots for me';
}
proposeSpots.list = [];

/* --------------------------------------------------------------- save */
async function save() {
  if (!editorDirty()) return toast('Nothing to save.');
  const btn = $('#edSave');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    if (E.dirty.heights) {
      const r = await fetch(`/api/map/${E.id}/heights`, { method: 'PUT', body: E.elev.buffer.slice(0) });
      if (!r.ok) throw new Error((await r.json()).error || 'heights save failed');
      E.dirty.heights = false;
    }
    if (E.dirty.surface && E.surf) {
      const r = await fetch(`/api/map/${E.id}/surface`, { method: 'PUT', body: E.surf.buffer.slice(0) });
      if (!r.ok) throw new Error((await r.json()).error || 'surface save failed');
      E.dirty.surface = false;
    }
    const j = E.json;
    const r = await api(`/api/map/${E.id}/meta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: j.name, region: j.region, rangeM: j.rangeM,
        pilot: j.pilot, home: j.home, sites: j.sites || [], starts: j.starts || [],
        pads: j.pads || [], obstacles: j.obstacles || [], gates: j.gates || [],
      }),
    });
    E.json = r.json;
    E.dirty.meta = false;

    // a fresh thumbnail, from the rendered terrain
    const t = document.createElement('canvas');
    t.width = 256; t.height = 256;
    t.getContext('2d').drawImage(E.base, 0, 0, 256, 256);
    const blob = await new Promise((res) => t.toBlob(res, 'image/jpeg', 0.82));
    if (blob) await fetch(`/api/map/${E.id}/thumb`, { method: 'PUT', body: blob });

    let msg = `Saved. Field elevation ${r.datum.ground} m.`;
    if (r.problems && r.problems.length) msg += ` ⚠ ${r.problems.length} problem(s): ${r.problems[0]}`;
    const probs = !!(r.problems && r.problems.length);

    /* Publish it. The add is scoped to this map's folder and the index, so
       another session's dirty files in the same working copy are left alone. */
    if (publishOnSave()) {
      btn.textContent = 'Publishing…';
      try {
        const p = await api('/api/publish', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [E.id], message: `Edit ${E.id} in the map builder` }),
        });
        msg += p.pushed
          ? ' Published — the public library updates when Pages rebuilds, a minute or two.'
          : ` Committed but NOT pushed: ${p.error || 'push failed'}`;
        if (!p.pushed) toast(msg, true);
        else toast(msg, probs);
      } catch (e) {
        // the save stands: say which half failed, and leave the rest alone
        toast(`${msg} Publish failed: ${e.message} — the file is saved, and the sim can read this library live.`, true);
      }
    } else {
      toast(msg, probs);
    }
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
  btn.disabled = false;
  syncSaveLabel();
}
