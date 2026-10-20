// server.mjs — the map builder's local web app.
//
// `flmap serve LIB` starts this. It serves the GUI in web/, the map library
// itself (with CORS, so Flightline on another port can read it as a library
// URL), and a small API over the same lib/ code the CLI uses. Everything
// stays on this machine: the only network traffic is the elevation and
// imagery fetches a build makes, and those go through the CLI as a child
// process so the GUI streams the same progress lines a terminal would show.
//
// The one piece of map logic that lives here rather than in the client is
// the datum rule, because it has cost bugs twice before (see sites.mjs):
// every save re-reads the ground under the pilot and sets fieldElevM and
// origin.datumElevM to it, so the altimeter always reads zero at your feet
// no matter what the editor moved or sculpted.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMap, writeMap, writeIndex, mapKind, SURFACE_NAMES, MAX_SIDE, encodeHeights } from './maps.mjs';
import { proposeSites } from './sites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
const BIN = path.join(HERE, '..', 'bin', 'flmap.mjs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.u16': 'application/octet-stream', '.u8': 'application/octet-stream',
};

const ID_OK = /^[a-z0-9][a-z0-9_-]*$/i;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const bad = (res, msg) => json(res, 400, { error: msg });

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(`body over ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Bilinear ground sample at local (n, e), from a readMap result. */
function groundAt(m, n, e) {
  const g = m.json.grid;
  const o = g.originNE || [((g.rows - 1) * g.cell) / 2, -((g.cols - 1) * g.cell) / 2];
  const fc = Math.max(0, Math.min(g.cols - 1, (e - o[1]) / g.cell));
  const fr = Math.max(0, Math.min(g.rows - 1, (o[0] - n) / g.cell));
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = Math.min(g.cols - 1, c0 + 1), r1 = Math.min(g.rows - 1, r0 + 1);
  const tc = fc - c0, tr = fr - r0;
  const at = (c, r) => m.elevAt(c, r);
  return at(c0, r0) * (1 - tc) * (1 - tr) + at(c1, r0) * tc * (1 - tr)
    + at(c0, r1) * (1 - tc) * tr + at(c1, r1) * tc * tr;
}

/** Apply the datum rule to a map.json object, given its folder on disk. */
function settleDatum(dir, j) {
  const m = readMap(dir);
  const pilot = j.pilot || { n: 0, e: 0 };
  const ground = +groundAt(m, +pilot.n || 0, +pilot.e || 0).toFixed(2);
  const before = { fieldElevM: j.fieldElevM, datumElevM: j.origin && j.origin.datumElevM };
  j.fieldElevM = ground;
  if (j.origin) j.origin.datumElevM = ground;
  return { ground, before };
}

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', env: gitEnv, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, stderr, code: err ? err.code : 0 }));
  });
}

/* Fields the editor is allowed to write into map.json. Everything else —
   format, grid, origin lat/lon, attribution — is the builder's, not the
   editor's, and a save cannot touch it. */
const META_FIELDS = ['name', 'region', 'rangeM', 'pilot', 'home', 'sites', 'starts', 'pads', 'obstacles', 'gates', 'surfaceClasses'];

export function startServer(opts = {}) {
  const libDir = path.resolve(opts.libDir || '.');
  if (!fs.existsSync(libDir) || !fs.statSync(libDir).isDirectory()) {
    throw new Error(`${libDir} is not a directory`);
  }
  const port = opts.port != null ? opts.port : 5183;
  const host = opts.host || '127.0.0.1';
  const quiet = !!opts.quiet;
  const say = (...a) => { if (!quiet) console.log(...a); };

  let building = null; // one build at a time; this names the id underway

  const mapDir = (id) => {
    if (!ID_OK.test(id)) return null;
    const dir = path.join(libDir, id);
    if (!dir.startsWith(libDir + path.sep)) return null;
    return dir;
  };
  const terrainDir = (id, res) => {
    const dir = mapDir(id);
    if (!dir || !fs.existsSync(path.join(dir, 'map.json'))) { json(res, 404, { error: `no map "${id}"` }); return null; }
    if (mapKind(dir) !== 'terrain') { bad(res, `"${id}" is a Frag Zone arena — this editor edits terrain maps`); return null; }
    return dir;
  };

  /* Stream a CLI child's output as NDJSON lines, then a done/error record. */
  function streamChild(res, args, onDone) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const child = spawn(process.execPath, [BIN, ...args], { cwd: path.join(HERE, '..') });
    const emit = (obj) => res.write(JSON.stringify(obj) + '\n');
    // keep partial lines until their newline arrives
    let carry = '';
    const onChunk = (d) => {
      carry += d.toString();
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const s of lines) emit({ t: 'log', s });
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('close', (code) => {
      if (carry) emit({ t: 'log', s: carry });
      try { if (onDone) onDone(code, emit); } catch (e) { emit({ t: 'error', s: e.message }); }
      if (code === 0) emit({ t: 'done' });
      else emit({ t: 'error', s: `exited with code ${code}` });
      res.end();
    });
    return child;
  }

  function serveFile(res, file, extraHeaders = {}) {
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...extraHeaders,
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = decodeURIComponent(u.pathname);

    try {
      /* ------------------------------------------------ the library files */
      if (p.startsWith('/library/')) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
          return res.end();
        }
        const rel = p.slice('/library/'.length);
        const file = path.resolve(libDir, rel);
        if (!file.startsWith(libDir + path.sep) && file !== libDir) { res.writeHead(403); return res.end(); }
        const target = rel === '' || rel.endsWith('/') ? path.join(file, 'index.json') : file;
        return serveFile(res, target, { 'Access-Control-Allow-Origin': '*' });
      }

      /* -------------------------------------------------------- the API */
      if (p.startsWith('/api/')) {
        // GET /api/library — the index plus each terrain map's flying bits
        if (p === '/api/library' && req.method === 'GET') {
          if (!fs.existsSync(path.join(libDir, 'index.json'))) writeIndex(libDir);
          const idx = JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8'));
          for (const m of idx.maps) {
            try {
              const j = JSON.parse(fs.readFileSync(path.join(libDir, m.id, 'map.json'), 'utf8'));
              m.pilot = j.pilot; m.sites = (j.sites || []).length; m.starts = (j.starts || []).length;
              m.pads = (j.pads || []).length; m.obstaclesN = (j.obstacles || []).length;
              if (fs.existsSync(path.join(libDir, m.id, 'thumb.jpg'))) m.thumb = `${m.id}/thumb.jpg`;
            } catch { /* index entry stands on its own */ }
          }
          return json(res, 200, { libDir, surfaceNames: SURFACE_NAMES, building, ...idx });
        }

        if (p === '/api/status' && req.method === 'GET') {
          const st = await git(libDir, ['status', '--porcelain']);
          const br = await git(libDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
          const ahead = await git(libDir, ['rev-list', '--count', '@{upstream}..HEAD']);
          return json(res, 200, {
            git: st.ok,
            branch: br.stdout.trim(),
            dirty: st.stdout.split('\n').filter(Boolean).map((l) => ({ st: l.slice(0, 2).trim(), path: l.slice(3) })),
            ahead: +ahead.stdout.trim() || 0,
          });
        }

        if (p === '/api/publish' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const ids = Array.isArray(body.ids) ? body.ids.filter((i) => ID_OK.test(i)) : [];
          if (!ids.length) return bad(res, 'publish wants {ids: [...]} — which maps to commit');
          const message = String(body.message || '').trim() || `Edit ${ids.join(', ')} in the map builder`;
          // Scoped add: only the named map folders and the index. Other
          // sessions may have this tree dirty for their own reasons, and
          // their changes are not ours to commit.
          const add = await git(libDir, ['add', '--', 'index.json', ...ids.map((i) => `${i}/`)]);
          if (!add.ok) return json(res, 500, { error: `git add: ${add.stderr}` });
          const commit = await git(libDir, ['commit', '-m', message]);
          if (!commit.ok && !/nothing to commit/.test(commit.stdout + commit.stderr)) {
            return json(res, 500, { error: `git commit: ${commit.stderr || commit.stdout}` });
          }
          let pushed = false, pushOut = '';
          if (body.push !== false) {
            const push = await git(libDir, ['push']);
            pushed = push.ok; pushOut = (push.stderr || push.stdout).trim();
            if (!push.ok) return json(res, 200, { committed: true, pushed: false, error: `git push: ${pushOut}` });
          }
          return json(res, 200, { committed: true, pushed, detail: (commit.stdout + '\n' + pushOut).trim() });
        }

        if (p === '/api/probe' && req.method === 'GET') {
          streamChild(res, ['probe']);
          return;
        }

        // POST /api/build — run the CLI, stream its lines
        if (p === '/api/build' && req.method === 'POST') {
          if (building) return json(res, 409, { error: `already building "${building}"` });
          const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const id = String(b.id || '');
          if (!ID_OK.test(id)) return bad(res, `"${id}" is not a usable map id (letters, digits, dashes)`);
          const lat = +b.lat, lon = +b.lon;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return bad(res, 'lat and lon are required');
          const out = mapDir(id);
          const args = ['build', '--center', `${lat},${lon}`, '--out', out, '--id', id,
            '--size', String(Math.max(256, Math.min(16384, +b.sizeM || 2048))),
            '--cell', String(Math.max(0.5, Math.min(64, +b.cellM || 4)))];
          if (b.name) args.push('--name', String(b.name));
          if (b.region) args.push('--region', String(b.region));
          if (b.source) args.push('--source', String(b.source));
          if (b.classify) args.push('--classify');
          if (b.waterBelow != null && b.waterBelow !== '') args.push('--water-below', String(+b.waterBelow));
          if (b.snowAbove != null && b.snowAbove !== '') args.push('--snow-above', String(+b.snowAbove));
          if (b.color) args.push('--color', b.color === true ? 'naip' : String(b.color));
          building = id;
          streamChild(res, args, (code) => {
            building = null;
            if (code === 0) writeIndex(libDir);
          });
          return;
        }

        // POST /api/new — a blank synthetic map to build up in the editor
        if (p === '/api/new' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const id = String(b.id || '');
          if (!ID_OK.test(id)) return bad(res, `"${id}" is not a usable map id (letters, digits, dashes)`);
          const dir = mapDir(id);
          if (fs.existsSync(dir)) return bad(res, `"${id}" already exists`);
          const sizeM = Math.max(256, Math.min(16384, +b.sizeM || 1024));
          let cell = Math.max(0.5, Math.min(64, +b.cellM || 2));
          let posts = Math.round(sizeM / cell) + 1;
          if (posts > MAX_SIDE) { cell = sizeM / (MAX_SIDE - 1); posts = MAX_SIDE; }
          const base = Number.isFinite(+b.baseElevM) ? +b.baseElevM : 1400;
          const amp = Number.isFinite(+b.amplitudeM) ? +b.amplitudeM : 40;
          const elevM = synthTerrain(String(b.preset || 'flat'), posts, cell, base, amp);
          const r = writeMap({
            dir, id, name: String(b.name || id), region: b.region ? String(b.region) : undefined,
            author: b.author ? String(b.author) : undefined,
            attribution: 'Synthetic terrain, drawn in the map builder.', license: 'CC0-1.0',
            builder: 'flightline-map-builder (gui)',
            elevM, cols: posts, rows: posts, cell,
            lat: Number.isFinite(+b.lat) ? +b.lat : 37.6775, lon: Number.isFinite(+b.lon) ? +b.lon : -113.0628,
            pilot: { n: 0, e: 0 },
            starts: [
              { id: 'pad', name: 'On the pad', n: 8, e: 1.5, yawDeg: 0, aglM: 0, anchor: 'pilot' },
              { id: 'launch', name: 'In your hand', n: 0.6, e: 0.45, yawDeg: 0, aglM: 1.7, anchor: 'pilot', held: true },
              { id: 'air', name: 'In the air, 60 m', n: -200, e: 120, yawDeg: 270, aglM: 60, speedMs: 16, anchor: 'pilot' },
            ],
          });
          writeIndex(libDir);
          return json(res, 200, { id, dir, cols: posts, rows: posts, cell, bytes: r.bytes });
        }

        // per-map routes: /api/map/<id>/<action>
        const mm = p.match(/^\/api\/map\/([^/]+)(?:\/([a-z]+))?$/);
        if (mm) {
          const id = mm[1], action = mm[2] || '';
          const dir = terrainDir(id, res);
          if (!dir) return;

          if (!action && req.method === 'GET') {
            return json(res, 200, JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8')));
          }

          if (action === 'propose' && req.method === 'GET') {
            const q = u.searchParams;
            const r = proposeSites(dir, {
              count: +q.get('count') || 6, skyDeg: +q.get('sky') || 12,
              reachM: +q.get('reach') || 800, apartM: +q.get('apart') || 600,
            });
            return json(res, 200, { total: r.total, sites: r.sites });
          }

          if (action === 'heights' && req.method === 'PUT') {
            const body = await readBody(req);
            const j = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
            const g = j.grid;
            if (body.length !== g.cols * g.rows * 4) {
              return bad(res, `heights body is ${body.length} bytes, expected ${g.cols}x${g.rows} Float32 = ${g.cols * g.rows * 4}`);
            }
            const elev = new Float32Array(body.buffer, body.byteOffset, g.cols * g.rows);
            const enc = encodeHeights(elev);
            fs.writeFileSync(path.join(dir, 'height.u16'), Buffer.from(enc.values.buffer, enc.values.byteOffset, enc.values.byteLength));
            g.heights = {
              ...g.heights, file: 'height.u16', type: 'uint16le',
              scale: +enc.scale.toPrecision(10), offset: +enc.offset.toFixed(4),
              min: +enc.min.toFixed(2), max: +enc.max.toFixed(2),
            };
            // write the new scale/offset BEFORE sampling, or settleDatum
            // decodes the new raw values with the old scale — found by test
            fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(j, null, 2) + '\n');
            const datum = settleDatum(dir, j); // ground may have moved under the pilot
            fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(j, null, 2) + '\n');
            writeIndex(libDir);
            return json(res, 200, { min: enc.min, max: enc.max, stepMm: +(enc.scale * 1000).toFixed(2), datum });
          }

          if (action === 'surface' && req.method === 'PUT') {
            const body = await readBody(req);
            const j = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
            const g = j.grid;
            if (body.length !== g.cols * g.rows) {
              return bad(res, `surface body is ${body.length} bytes, expected ${g.cols * g.rows}`);
            }
            for (let i = 0; i < body.length; i++) {
              if (body[i] >= SURFACE_NAMES.length) return bad(res, `byte ${i} holds class ${body[i]}, which is not defined`);
            }
            fs.writeFileSync(path.join(dir, 'surface.u8'), body);
            g.surface = { file: 'surface.u8', type: 'uint8' };
            fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(j, null, 2) + '\n');
            writeIndex(libDir);
            return json(res, 200, { ok: true });
          }

          if (action === 'thumb' && req.method === 'PUT') {
            const body = await readBody(req, 4 * 1024 * 1024);
            fs.writeFileSync(path.join(dir, 'thumb.jpg'), body);
            return json(res, 200, { ok: true });
          }

          if (action === 'meta' && req.method === 'POST') {
            const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
            const j = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
            for (const k of META_FIELDS) {
              if (!(k in b)) continue;
              if (b[k] == null || (Array.isArray(b[k]) && !b[k].length)) delete j[k];
              else j[k] = b[k];
            }
            // the format keeps empty arrays for these two
            j.obstacles = Array.isArray(b.obstacles) ? b.obstacles : j.obstacles || [];
            j.gates = Array.isArray(b.gates) ? b.gates : j.gates || [];
            const datum = settleDatum(dir, j);
            fs.writeFileSync(path.join(dir, 'map.json'), JSON.stringify(j, null, 2) + '\n');
            writeIndex(libDir);
            const check = readMap(dir);
            return json(res, 200, { json: j, datum, problems: check.problems });
          }

          if (action === 'delete' && req.method === 'POST') {
            fs.rmSync(dir, { recursive: true });
            writeIndex(libDir);
            return json(res, 200, { ok: true });
          }
        }

        return json(res, 404, { error: `no such API route: ${req.method} ${p}` });
      }

      /* ------------------------------------------------------ the GUI */
      const file = p === '/' ? 'index.html' : p.slice(1);
      const resolved = path.resolve(WEB, file);
      if (!resolved.startsWith(WEB + path.sep) && resolved !== path.join(WEB, 'index.html')) {
        res.writeHead(403); return res.end();
      }
      return serveFile(res, resolved);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const got = server.address().port;
      say(`Map builder: http://${host === '0.0.0.0' ? 'localhost' : host}:${got}`);
      say(`Library:     ${libDir}`);
      say(`The sim can read this library live at http://localhost:${got}/library/`);
      resolve({ server, port: got, libDir });
    });
  });
}

/** Blank-map terrain. Deterministic, so a preset is reproducible. */
function synthTerrain(preset, posts, cell, baseElevM, ampM) {
  const elev = new Float64Array(posts * posts);
  const span = (posts - 1) * cell, half = span / 2;
  // a small fixed-seed value noise, enough texture that the ground reads as ground
  const rnd = mulberry(42);
  const G = 17;
  const lattice = Float64Array.from({ length: G * G }, () => rnd() * 2 - 1);
  const noise = (x, y) => {
    const gx = (x / span + 0.5) * (G - 3) + 1, gy = (y / span + 0.5) * (G - 3) + 1;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = smooth(gx - x0), ty = smooth(gy - y0);
    const v = (c, r) => lattice[r * G + c];
    return v(x0, y0) * (1 - tx) * (1 - ty) + v(x0 + 1, y0) * tx * (1 - ty)
      + v(x0, y0 + 1) * (1 - tx) * ty + v(x0 + 1, y0 + 1) * tx * ty;
  };
  for (let r = 0; r < posts; r++) {
    for (let c = 0; c < posts; c++) {
      const e = -half + c * cell, n = half - r * cell;
      let h = baseElevM;
      if (preset === 'hills') {
        h += ampM * (0.6 * noise(e, n) + 0.3 * noise(e * 2.3 + 500, n * 2.3) + 0.1 * noise(e * 5.1, n * 5.1 + 900));
      } else if (preset === 'ridge') {
        const d = Math.abs(e) / half; // a ridge running north-south through the middle
        h += ampM * 3 * Math.exp(-(d * d) * 8) + ampM * 0.15 * noise(e, n);
      } else if (preset === 'valley') {
        const d = Math.abs(e) / half;
        h += ampM * 3 * (1 - Math.exp(-(d * d) * 5)) + ampM * 0.15 * noise(e, n);
      }
      elev[r * posts + c] = h;
    }
  }
  // the pad itself stays flat and level, whatever the preset did
  const flat = baseElevM === elev[((posts - 1) >> 1) * posts + ((posts - 1) >> 1)] ? null : elev[((posts - 1) >> 1) * posts + ((posts - 1) >> 1)];
  if (flat != null) {
    for (let r = 0; r < posts; r++) for (let c = 0; c < posts; c++) {
      const e = -half + c * cell, n = half - r * cell;
      const d = Math.hypot(n, e);
      const k = Math.max(0, Math.min(1, 1 - (d - 25) / 20));
      if (k > 0) { const i = r * posts + c; elev[i] = elev[i] * (1 - k) + flat * k; }
    }
  }
  return elev;
}
const smooth = (t) => t * t * (3 - 2 * t);
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
