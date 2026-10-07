/* FRACTURE shared library — Cloudflare Worker + D1
   Stores recipes (numbers only) and songs (lists of recipe numbers). No text, no images, no accounts.
   Bindings: DB (D1 database). Variables: ALLOWED_ORIGINS (comma list, e.g. https://lampwrecked.github.io), SALT, ADMIN_KEY (secret). */

const LIMITS = { recipe: 30, song: 15, report: 40 };      // per visitor, per hour
const MAX_BODY = 300000;
const AUTO_HIDE_REPORTS = 3;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS recipes(id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, data TEXT NOT NULL, card TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS songs(id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, items TEXT NOT NULL, loops INTEGER NOT NULL, dots TEXT NOT NULL, reports INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS hits(ip TEXT NOT NULL, action TEXT NOT NULL, t INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS hits_ip ON hits(ip, action, t)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reports(ip TEXT NOT NULL, kind TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY(ip, kind, rid))`),
  ]);
  schemaReady = true;
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => { throw new HttpError(400, m); };

/* ---------- validation: rebuild a clean copy, keep only known numeric fields ---------- */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const inR = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;

function validRecipe(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) bad('RECIPE MALFORMED');
  if (!isInt(r.v, 1, 1000)) bad('BAD ENGINE VERSION');
  if (!Array.isArray(r.l) || r.l.length < 1 || r.l.length > 24) bad('1-24 LAYERS ONLY');
  let totalOps = 0;
  const l = r.l.map((x) => {
    if (!x || typeof x !== 'object') bad('LAYER MALFORMED');
    if (!isInt(x.i, 0, 13) || !inR(x.f, 10, 5000) || !inR(x.x, 0, 1) || !inR(x.y, 0, 1) || !isInt(x.s, 0, 4294967295)
      || !isInt(x.h, 0, 359) || !isInt(x.st, 0, 63) || !isInt(x.d, 1, 63) || !inR(x.ho, 0, 120) || !isInt(x.su, 0, 1)) bad('LAYER OUT OF RANGE');
    if (!Array.isArray(x.rt) || x.rt.length > 40 || x.rt.some((v) => v !== null && !inR(v, 0, 200))) bad('RINGS OUT OF RANGE');
    if (!Array.isArray(x.o) || x.o.length % 8 || x.o.length > 8 * 300) bad('EFFECTS MALFORMED');
    for (let i = 0; i < x.o.length; i += 8) {
      const [t, k, n, px, py, u, rr, q] = x.o.slice(i, i + 8);
      if (!inR(t, 0, 200) || !isInt(k, 0, 3) || !(n === null || isInt(n, 0, 14)) || !(px === null || inR(px, -2, 3)) || !(py === null || inR(py, -2, 3))
        || ((px === null) !== (py === null)) || !(u === null || inR(u, 0, 1)) || !inR(rr, 0, 10) || !(q === null || inR(q, 0, 2))) bad('EFFECT OUT OF RANGE');
    }
    totalOps += x.o.length / 8;
    return { i: x.i, f: x.f, x: x.x, y: x.y, s: x.s, h: x.h, st: x.st, d: x.d, ho: x.ho, rt: x.rt.slice(), su: x.su, o: x.o.slice() };
  });
  if (totalOps > 4000) bad('TOO MANY EFFECTS');
  return { v: r.v, l };
}

/* a song is a list of slots; each slot layers 1-4 recipes (with a volume step 0-2) that play together */
const SLOT_CAP = 48, SLOT_CARDS = 4;
function validSong(b) {
  const items = b && b.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 64) bad('1-64 SLOTS ONLY');
  return items.map((it, i) => {
    if (!it || !isInt(it.n, 1, 8) || ![0, 4, 8, 16].includes(it.t)) bad('SLOT OUT OF RANGE');
    let c = it.c;
    if (c === undefined && isInt(it.r, 1, 1e12)) c = [[it.r, 2]];          // older one-card form
    if (!Array.isArray(c) || c.length < 1 || c.length > SLOT_CARDS) bad('1-4 CARDS PER SLOT');
    c = c.map((x) => { if (!Array.isArray(x) || x.length !== 2 || !isInt(x[0], 1, 1e12) || !isInt(x[1], 0, 2)) bad('CARD OUT OF RANGE'); return [x[0], x[1]]; });
    if (new Set(c.map((x) => x[0])).size !== c.length) bad('SAME CARD TWICE IN A SLOT');
    return { c, n: it.n, t: i < items.length - 1 ? it.t : 0 };
  });
}

/* ---------- helpers ---------- */
async function visitor(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((env.SALT || 'fracture') + ip));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function rateLimit(db, who, action) {
  const now = Date.now(), hour = now - 3600e3;
  const row = await db.prepare('SELECT COUNT(*) AS n FROM hits WHERE ip=? AND action=? AND t>?').bind(who, action, hour).first();
  if (row.n >= LIMITS[action]) throw new HttpError(429, 'SLOW DOWN · TRY AGAIN LATER');
  await db.prepare('INSERT INTO hits(ip,action,t) VALUES(?,?,?)').bind(who, action, now).run();
  if (Math.random() < 0.02) await db.prepare('DELETE FROM hits WHERE t<?').bind(now - 86400e3).run();
}
async function body(req) {
  const len = +(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) bad('TOO LARGE');
  const txt = await req.text();
  if (txt.length > MAX_BODY) bad('TOO LARGE');
  try { return JSON.parse(txt); } catch (_) { bad('NOT JSON'); }
}
const page = (url, dflt, max) => Math.min(max, Math.max(0, parseInt(url.searchParams.get('limit') || dflt, 10) || dflt));
const off = (url) => Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

/* ---------- routes ---------- */
async function route(req, env, url) {
  const db = env.DB;
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  /* setup problems get a plain message instead of a generic server error */
  if (!db || typeof db.prepare !== 'function') throw new HttpError(500, 'SETUP: NO DATABASE CONNECTED · add a D1 binding named DB (Bindings tab), then deploy');
  try { await ensureSchema(db); }
  catch (e) { throw new HttpError(500, 'SETUP: DATABASE ERROR · ' + (e && e.message || e)); }

  if (m === 'GET' && p === '/') {
    const r = await db.prepare('SELECT (SELECT COUNT(*) FROM recipes) AS recipes, (SELECT COUNT(*) FROM songs) AS songs').first();
    return { ok: true, name: 'fracture library', recipes: r.recipes, songs: r.songs,
      allowed: (env.ALLOWED_ORIGINS || '(not set: any site may save)'), admin: env.ADMIN_KEY ? 'set' : 'NOT SET', salt: env.SALT ? 'set' : 'NOT SET' };
  }

  if (m === 'GET' && p === '/recipes') {
    const lim = page(url, 24, 60), o = off(url);
    const rs = await db.prepare('SELECT id,uses,card FROM recipes WHERE hidden=0 ORDER BY id DESC LIMIT ? OFFSET ?').bind(lim + 1, o).all();
    const rows = rs.results;
    return { items: rows.slice(0, lim).map((r) => ({ id: r.id, uses: r.uses, card: JSON.parse(r.card) })), more: rows.length > lim };
  }
  if (m === 'GET' && p === '/recipes/random') {
    const n = Math.min(24, Math.max(1, parseInt(url.searchParams.get('n') || '1', 10) || 1));
    const rs = await db.prepare('SELECT id,card FROM recipes WHERE hidden=0 ORDER BY RANDOM() LIMIT ?').bind(n).all();
    return { items: rs.results.map((r) => ({ id: r.id, card: JSON.parse(r.card) })) };
  }
  if (m === 'GET' && p === '/recipes/batch') {
    const ids = [...new Set((url.searchParams.get('ids') || '').split(',').map((v) => parseInt(v, 10)).filter((v) => v > 0))].slice(0, 50);
    if (!ids.length) return { items: [] };
    const rs = await db.prepare(`SELECT id,data FROM recipes WHERE hidden=0 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    return { items: rs.results.map((r) => ({ id: r.id, data: JSON.parse(r.data) })) };
  }
  let mm;
  if (m === 'GET' && (mm = p.match(/^\/recipes\/(\d+)$/))) {
    const r = await db.prepare('SELECT id,data,uses FROM recipes WHERE id=? AND hidden=0').bind(+mm[1]).first();
    if (!r) throw new HttpError(404, 'NOT FOUND');
    return { id: r.id, uses: r.uses, data: JSON.parse(r.data) };
  }
  if (m === 'POST' && p === '/recipes') {
    const rec = validRecipe(await body(req));
    await rateLimit(db, await visitor(req, env), 'recipe');
    const card = rec.l.map((l) => [l.i, l.x, l.y, l.s, l.h, l.st, l.d]);
    const r = await db.prepare('INSERT INTO recipes(created,data,card) VALUES(?,?,?) RETURNING id').bind(Date.now(), JSON.stringify(rec), JSON.stringify(card)).first();
    return { id: r.id };
  }

  if (m === 'GET' && p === '/songs') {
    const lim = page(url, 30, 60), o = off(url);
    const rs = await db.prepare('SELECT id,items,loops,dots FROM songs WHERE hidden=0 ORDER BY id DESC LIMIT ? OFFSET ?').bind(lim + 1, o).all();
    const rows = rs.results;
    return { items: rows.slice(0, lim).map((s) => ({ id: s.id, items: JSON.parse(s.items), loops: s.loops, dots: JSON.parse(s.dots) })), more: rows.length > lim };
  }
  if (m === 'GET' && (mm = p.match(/^\/songs\/(\d+)$/))) {
    const s = await db.prepare('SELECT id,items,loops,dots FROM songs WHERE id=? AND hidden=0').bind(+mm[1]).first();
    if (!s) throw new HttpError(404, 'NOT FOUND');
    return { id: s.id, items: JSON.parse(s.items), loops: s.loops, dots: JSON.parse(s.dots) };
  }
  if (m === 'POST' && p === '/songs') {
    const items = validSong(await body(req));
    const ids = [...new Set(items.flatMap((i) => i.c.map((x) => x[0])))];
    const rs = await db.prepare(`SELECT id,card FROM recipes WHERE hidden=0 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const cards = new Map(rs.results.map((r) => [r.id, JSON.parse(r.card)]));
    if (cards.size !== ids.length) bad('SONG USES A MISSING RECIPE');
    for (const it of items) if (it.c.reduce((a, x) => a + cards.get(x[0]).length, 0) > SLOT_CAP) bad('MORE THAN 48 LAYERS IN A SLOT');
    await rateLimit(db, await visitor(req, env), 'song');
    const loops = items.reduce((a, it, i) => a + it.n + (i < items.length - 1 ? it.t / 4 : 0), 0);
    const dots = items.map((it) => it.c.map((x) => (cards.get(x[0])[0] || [0, 0, 0, 0, 0])[4]));
    const r = await db.prepare('INSERT INTO songs(created,items,loops,dots) VALUES(?,?,?,?) RETURNING id').bind(Date.now(), JSON.stringify(items), loops, JSON.stringify(dots)).first();
    await db.prepare(`UPDATE recipes SET uses=uses+1 WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
    return { id: r.id };
  }

  if (m === 'POST' && p === '/report') {
    const b = await body(req);
    const kind = b.kind === 'song' ? 'song' : b.kind === 'recipe' ? 'recipe' : bad('BAD KIND');
    if (!isInt(b.id, 1, 1e12)) bad('BAD ID');
    const who = await visitor(req, env);
    await rateLimit(db, who, 'report');
    const ins = await db.prepare('INSERT OR IGNORE INTO reports(ip,kind,rid) VALUES(?,?,?)').bind(who, kind, b.id).run();
    if (ins.meta.changes) {
      const table = kind === 'song' ? 'songs' : 'recipes';
      await db.prepare(`UPDATE ${table} SET reports=reports+1, hidden=CASE WHEN reports+1>=? THEN 1 ELSE hidden END WHERE id=?`).bind(AUTO_HIDE_REPORTS, b.id).run();
    }
    return { ok: true };
  }

  if (m === 'POST' && p === '/admin/hide') {
    if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) throw new HttpError(403, 'NOT ALLOWED');
    const b = await body(req);
    const table = b.kind === 'song' ? 'songs' : b.kind === 'recipe' ? 'recipes' : bad('BAD KIND');
    if (!isInt(b.id, 1, 1e12)) bad('BAD ID');
    await db.prepare(`UPDATE ${table} SET hidden=? WHERE id=?`).bind(b.hidden === 0 ? 0 : 1, b.id).run();
    return { ok: true };
  }
  if (m === 'GET' && p === '/admin/reported') {
    if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) throw new HttpError(403, 'NOT ALLOWED');
    const r = await db.prepare('SELECT id,reports,hidden FROM recipes WHERE reports>0 ORDER BY reports DESC LIMIT 100').all();
    const s = await db.prepare('SELECT id,reports,hidden FROM songs WHERE reports>0 ORDER BY reports DESC LIMIT 100').all();
    return { recipes: r.results, songs: s.results };
  }

  throw new HttpError(404, 'NOT FOUND');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
    const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
    const cors = { 'Access-Control-Allow-Origin': allowOrigin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    /* writes only from the allowed site(s) */
    if (req.method === 'POST' && !allowed.includes('*') && !allowed.includes(origin)) {
      return new Response(JSON.stringify({ error: 'NOT ALLOWED FROM THIS SITE' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    let status = 200, out;
    try { out = await route(req, env, url); }
    catch (e) { status = e.status || 500; out = { error: e.status ? e.message : 'SERVER ERROR · ' + String(e && e.message || e).slice(0, 200) }; if (!e.status) console.error(e); }
    const headers = { ...cors, 'Content-Type': 'application/json' };
    if (req.method === 'GET' && status === 200) headers['Cache-Control'] = 'public, max-age=15';
    return new Response(JSON.stringify(out), { status, headers });
  },
};
