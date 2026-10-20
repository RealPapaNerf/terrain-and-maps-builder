// app.js — shell, library home, the real-terrain builder, and publishing.
// The editor itself is editor.js.

import { openEditor, closeEditor, editorDirty } from './editor.js';

const $ = (s) => document.querySelector(s);
const SIM_URL = 'http://localhost:5178';
const LIB_URL = `${location.origin}/library/`;

export async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

let toastTimer = 0;
export function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}

/* Read an NDJSON stream, calling onLine per record. */
export async function stream(url, opts, onLine) {
  const r = await fetch(url, opts);
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `${r.status} ${r.statusText}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let carry = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += dec.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop();
    for (const l of lines) if (l.trim()) onLine(JSON.parse(l));
  }
  if (carry.trim()) onLine(JSON.parse(carry));
}

/* ------------------------------------------------------------- routing */
const views = ['home', 'build', 'new', 'edit'];
function show(view, crumb = '') {
  for (const v of views) $(`#view-${v}`).hidden = v !== view;
  $('#crumb').textContent = crumb;
}

async function route() {
  const h = location.hash || '#home';
  if (!h.startsWith('#edit/')) closeEditor();
  if (h.startsWith('#edit/')) {
    const id = h.slice(6);
    show('edit', '');
    try { await openEditor(id); } catch (e) { toast(e.message, true); location.hash = '#home'; }
  } else if (h === '#build') {
    show('build', 'New map from real terrain');
    initPickMap();
  } else if (h === '#new') {
    show('new', 'New blank map');
  } else {
    show('home', '');
    renderHome();
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (editorDirty()) e.preventDefault(); });

/* --------------------------------------------------------------- home */
async function renderHome() {
  $('#libUrl').textContent = LIB_URL;
  let lib, status;
  try { lib = await api('/api/library'); } catch (e) { toast(e.message, true); return; }
  try { status = await api('/api/status'); } catch { status = { dirty: [] }; }
  const dirtyIds = new Set(status.dirty.map((d) => d.path.split('/')[0]));

  const cards = $('#cards');
  cards.innerHTML = '';
  for (const m of lib.maps) {
    const el = document.createElement('div');
    el.className = 'card';
    const arena = m.kind === 'arena';
    const extent = m.extentM ? `${(m.extentM[0] / 1000).toFixed(1)} km` : '';
    el.innerHTML = `
      <div class="thumb" ${m.thumb ? `style="background-image:url('/library/${m.thumb}?t=${Date.now()}')"` : ''}>${m.thumb ? '' : (arena ? '🧱' : '⛰')}</div>
      <div class="body">
        <h3>${esc(m.name)} ${dirtyIds.has(m.id) ? '<span class="dirtyDot" title="Has unpublished changes">●</span>' : ''}</h3>
        <div class="meta">${esc(m.region || '')}</div>
        <div class="meta">${arena
          ? `Frag Zone arena — ${m.brushes} brushes, ${m.spawns} spawns`
          : `${extent} at ${m.cell} m · ${m.reliefM} m relief${m.hasColor ? ' · imagery' : ''}${m.obstaclesN ? ` · ${m.obstaclesN} objects` : ''}`}</div>
        ${m.problems ? `<div class="warn">⚠ ${m.problems.length} problem(s) — open it to see</div>` : ''}
      </div>
      <div class="row">
        ${arena ? '<span class="badge">edit in Frag Zone</span>' : `<button data-edit="${m.id}">Edit</button>`}
        <span class="spacer"></span>
        <button class="ghost danger" data-del="${m.id}" title="Delete this map from the library folder">Delete</button>
      </div>`;
    cards.appendChild(el);
  }
  if (!lib.maps.length) cards.innerHTML = '<p class="note">The library is empty — build your first map.</p>';

  cards.onclick = async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.edit) location.hash = `#edit/${b.dataset.edit}`;
    if (b.dataset.del) {
      const id = b.dataset.del;
      if (!confirm(`Delete "${id}" from the library folder?\n\nIf it was already published, the next publish will delete it from the public library too.`)) return;
      try { await api(`/api/map/${id}/delete`, { method: 'POST' }); toast(`Deleted ${id}.`); renderHome(); }
      catch (e) { toast(e.message, true); }
    }
  };
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('#brand').onclick = () => { location.hash = '#home'; };
$('#btnNewReal').onclick = () => { location.hash = '#build'; };
$('#btnNewBlank').onclick = () => { location.hash = '#new'; };
$('#btnCopyLib').onclick = async () => {
  try { await navigator.clipboard.writeText(LIB_URL); toast('Library URL copied — paste it into Flightline, Settings → Map.'); }
  catch { toast(LIB_URL); }
};

/* -------------------------------------------------------------- probe */
$('#btnProbe').onclick = async () => {
  const dlg = $('#dlgProbe'), out = $('#probeOut');
  out.textContent = 'Probing…\n';
  dlg.showModal();
  try {
    await stream('/api/probe', {}, (l) => {
      if (l.t === 'log') out.textContent += l.s + '\n';
      out.scrollTop = out.scrollHeight;
    });
  } catch (e) { out.textContent += `\n${e.message}`; }
};
$('#probeClose').onclick = () => $('#dlgProbe').close();

/* ------------------------------------------------------------ publish */
$('#btnPublish').onclick = async () => {
  const dlg = $('#dlgPublish'), list = $('#pubList'), out = $('#pubOut');
  out.hidden = true; out.textContent = '';
  let status;
  try { status = await api('/api/status'); } catch (e) { return toast(e.message, true); }
  if (!status.git) return toast('The library folder is not a git repository.', true);
  const ids = [...new Set(status.dirty.map((d) => d.path.split('/')[0]).filter((p) => p && !p.includes('.')))];
  const index = status.dirty.some((d) => d.path === 'index.json');
  if (!ids.length && !index) {
    if (status.ahead > 0) {
      list.innerHTML = `<p class="note">Nothing new to commit, but ${status.ahead} commit(s) are waiting to be pushed.</p>`;
    } else {
      return toast('Nothing to publish — the library matches what is already public.');
    }
  } else {
    list.innerHTML = ids.map((id) =>
      `<label class="pubItem"><input type="checkbox" value="${id}" checked> ${id}</label>`).join('')
      + `<p class="note">On branch <code>${esc(status.branch)}</code>.</p>`;
  }
  $('#pubMsg').value = ids.length ? `Edit ${ids.join(', ')} in the map builder` : '';
  dlg.showModal();

  $('#pubGo').onclick = async () => {
    const picked = [...list.querySelectorAll('input:checked')].map((i) => i.value);
    out.hidden = false;
    out.textContent = 'Committing…\n';
    try {
      if (picked.length) {
        const r = await api('/api/publish', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: picked, message: $('#pubMsg').value }),
        });
        out.textContent += (r.detail || '') + (r.pushed ? '\nPushed. The public library updates when Pages rebuilds (a minute or two).' : `\n${r.error || 'Not pushed.'}`);
        if (r.pushed) { toast('Published.'); setTimeout(() => { dlg.close(); renderHome(); }, 1500); }
      } else {
        dlg.close();
      }
    } catch (e) { out.textContent += `\n${e.message}`; }
  };
  $('#pubCancel').onclick = () => dlg.close();
};

/* ----------------------------------------------- real-terrain builder */
let pick = null; // { map, marker, rect, center }
function initPickMap() {
  if (pick) { setTimeout(() => pick.map.invalidateSize(), 50); return; }
  const map = L.map('pickMap', { zoomControl: true }).setView([38.3, -112.5], 7);
  const imagery = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: 'USGS The National Map',
  }).addTo(map);
  const topo = L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: 'USGS The National Map',
  });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  });
  L.control.layers({ 'Aerial (USGS)': imagery, 'Topo (USGS)': topo, OpenStreetMap: osm }).addTo(map);
  pick = { map, marker: null, rect: null, center: null };

  map.on('click', (ev) => setCenter(ev.latlng));
  $('#buildForm').sizeM.addEventListener('change', updateRect);
  $('#buildForm').name.addEventListener('input', () => {
    const f = $('#buildForm');
    if (!f.id.dataset.touched) f.id.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  });
  $('#buildForm').id.addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  setTimeout(() => map.invalidateSize(), 50);
}

function setCenter(latlng) {
  pick.center = latlng;
  $('#buildForm').center.value = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  if (!pick.marker) pick.marker = L.marker(latlng, { draggable: true }).addTo(pick.map)
    .on('drag', () => setCenter(pick.marker.getLatLng()));
  else pick.marker.setLatLng(latlng);
  updateRect();
}

function updateRect() {
  if (!pick || !pick.center) return;
  const sizeM = +$('#buildForm').sizeM.value;
  const half = sizeM / 2;
  const lat = pick.center.lat, lon = pick.center.lng;
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos((lat * Math.PI) / 180));
  const bounds = [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
  if (!pick.rect) pick.rect = L.rectangle(bounds, { color: '#4da3ff', weight: 2, fillOpacity: 0.06 }).addTo(pick.map);
  else pick.rect.setBounds(bounds);
  const posts = Math.round(sizeM / +$('#buildForm').cellM.value) + 1;
  $('#cellNote').textContent = posts > 1024 ? ` → the format caps a side at 1024 posts, so the cell will widen to ${(sizeM / 1023).toFixed(1)} m` : '';
}
$('#buildForm')?.cellM?.addEventListener('change', updateRect);

$('#buildForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (!pick || !pick.center) return toast('Click the map to pick a centre first.', true);
  const log = $('#buildLog');
  log.hidden = false; log.textContent = '';
  $('#btnBuild').disabled = true;
  $('#buildDone').hidden = true;
  const body = {
    id: f.id.value.trim(), name: f.name.value.trim(), region: f.region.value.trim(),
    lat: pick.center.lat, lon: pick.center.lng,
    sizeM: +f.sizeM.value, cellM: +f.cellM.value, source: f.source.value,
    color: f.color.checked ? 'naip' : false, classify: f.classify.checked,
    waterBelow: f.waterBelow.value === '' ? null : +f.waterBelow.value,
    snowAbove: f.snowAbove.value === '' ? null : +f.snowAbove.value,
  };
  let failed = false;
  try {
    await stream('/api/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, (l) => {
      if (l.t === 'log') log.textContent += l.s + '\n';
      if (l.t === 'error') { failed = true; log.textContent += `\nFAILED: ${l.s}\n`; }
      log.scrollTop = log.scrollHeight;
    });
  } catch (e) { failed = true; log.textContent += `\n${e.message}`; }
  $('#btnBuild').disabled = false;
  if (!failed) {
    $('#buildDone').hidden = false;
    $('#btnOpenBuilt').onclick = () => { location.hash = `#edit/${body.id}`; };
    toast(`Built ${body.id}.`);
  }
});

/* ---------------------------------------------------------- blank map */
$('#newForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const r = await api('/api/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: f.id.value.trim(), name: f.name.value.trim(), preset: f.preset.value,
        sizeM: +f.sizeM.value, baseElevM: +f.baseElevM.value, amplitudeM: +f.amplitudeM.value,
      }),
    });
    toast(`Created ${r.id} — ${r.cols}×${r.rows} posts at ${r.cell} m.`);
    location.hash = `#edit/${r.id}`;
  } catch (e) { toast(e.message, true); }
});
$('#newForm').name.addEventListener('input', () => {
  const f = $('#newForm');
  if (!f.id.dataset.touched) f.id.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
});
$('#newForm').id.addEventListener('input', (e) => { e.target.dataset.touched = '1'; });

/* --------------------------------------------------------------- go */
route();
