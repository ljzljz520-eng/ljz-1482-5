'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');
const tm = require('./time_model');
const reconcile = require('./reconcile');
const worker = require('./worker');

const MINm = 60 * 1000;

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4e6) reject(Object.assign(new Error('payload too large'), { status: 413 })); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function productionTvId() {
  const m = store.one('matches', () => true);
  return m.currentTimelineVersionId;
}

/* ---------- 读模型 ---------- */

function clipView(clip, tvId) {
  const res = tm.resolveClip(clip, tvId);
  return {
    ...strip(clip),
    resolution: {
      status: res.status, blockers: res.blockers, conflictType: res.conflictType,
      reason: res.reason, pieces: res.pieces, gapPieces: res.gapPieces, warnings: res.warnings,
      licensing: res.licensing, titles: res.titles, candidates: res.candidates,
    },
  };
}

function strip(row) {
  const { deleted, ...rest } = row;
  return { ...rest, deleted: !!deleted };
}

function state(tvId) {
  tvId = tvId || productionTvId();
  const match = store.one('matches', () => true);
  const timeline = store.one('timelines', t => t.matchId === match.id);
  const tvs = store.find('timelineVersions', () => true).sort((a, b) => a.version - b.version);
  return {
    rev: store.load().rev,
    selectedTimelineVersionId: tvId,
    match: strip(match),
    materials: store.all('materials').map(strip),
    materialVersions: store.all('materialVersions').map(strip),
    timeline: timeline ? strip(timeline) : null,
    timelineVersions: tvs.map(t => ({ ...strip(t), isProduction: t.id === match.currentTimelineVersionId })),
    segments: store.find('segments', s => s.timelineVersionId === tvId)
      .sort((a, b) => a.tlStartUs - b.tlStartUs).map(strip),
    clockSegments: tm.clockSegmentsOf(tvId).map(strip),
    scoreStates: store.all('scoreStates').map(strip),
    players: store.all('players').map(strip),
    playerTags: store.all('playerTags').map(strip),
    events: store.all('events').map(strip),
    grants: store.all('grants').map(strip),
    clips: store.find('clips', c => !c.deleted).sort((a, b) => a.position - b.position).map(c => clipView(c, tvId)),
    clipTombstones: store.find('clips', c => c.deleted).map(strip),
    titles: store.all('titles').filter(t => !t.deleted).map(strip),
    jobs: store.all('jobs').map(strip),
    packages: store.all('packages').map(strip),
  };
}

/* ---------- 命令 ---------- */

function createClip(body) {
  const pos = store.find('clips', c => !c.deleted).reduce((m, c) => Math.max(m, c.position || 0), 0) + 10;
  if (body.binding === 'fixed') {
    const mv = store.get('materialVersions', body.materialVersionId);
    if (!mv) throw Object.assign(new Error('material version not found'), { status: 400 });
    const fin = Number(body.frameIn), fout = Number(body.frameOut);
    if (!Number.isInteger(fin) || !Number.isInteger(fout) || fin >= fout) {
      throw Object.assign(new Error('固定镜头必须给出整数 frameIn/frameOut'), { status: 400 });
    }
    return store.insert('clips', {
      name: body.name || '固定源镜头', binding: 'fixed', reelId: body.reelId || 'reel_main',
      position: pos, status: 'planned', materialVersionId: mv.id,
      frameInBaseline: fin, frameOutBaseline: fout,
      srcPtsInUs: tm.framePtsUs(mv, fin), srcPtsOutUs: tm.framePtsUs(mv, fout),
      baselineTimelineVersionId: body.baselineTimelineVersionId || productionTvId(),
      createdAt: Date.now(), deleted: false,
    });
  }
  const gin = Number(body.gameInMs), gout = Number(body.gameOutMs);
  if (!Number.isFinite(gin) || !Number.isFinite(gout) || gin >= gout) {
    throw Object.assign(new Error('直播镜头必须给出 gameInMs/gameOutMs（比赛计时，毫秒）'), { status: 400 });
  }
  return store.insert('clips', {
    name: body.name || '直播镜头', binding: 'live', reelId: body.reelId || 'reel_main',
    position: pos, status: 'planned', gameInMs: gin, gameOutMs: gout,
    createdAt: Date.now(), deleted: false,
  });
}

function trimFixedClip(clip, body) {
  const mv = store.get('materialVersions', clip.materialVersionId);
  const patch = {};
  if (body.frameIn != null) patch.frameInBaseline = Number(body.frameIn);
  if (body.frameOut != null) patch.frameOutBaseline = Number(body.frameOut);
  if (!Number.isInteger(patch.frameInBaseline ?? clip.frameInBaseline)
      || !Number.isInteger(patch.frameOutBaseline ?? clip.frameOutBaseline)) {
    throw Object.assign(new Error('帧号必须为整数'), { status: 400 });
  }
  const fin = patch.frameInBaseline ?? clip.frameInBaseline;
  const fout = patch.frameOutBaseline ?? clip.frameOutBaseline;
  if (fin >= fout) throw Object.assign(new Error('frameIn 必须小于 frameOut'), { status: 400 });
  patch.srcPtsInUs = tm.framePtsUs(mv, fin);
  patch.srcPtsOutUs = tm.framePtsUs(mv, fout);
  patch.trimmedAt = Date.now();
  return store.update('clips', clip.id, patch);
}

function addTitle(body) {
  const clip = store.get('clips', body.clipId);
  if (!clip || clip.deleted) throw Object.assign(new Error('clip not found'), { status: 404 });
  return store.insert('titles', {
    clipId: clip.id, kind: body.kind || 'lower_third',
    text: String(body.text || ''), status: 'pending',
    anchorGameMs: body.anchorGameMs ?? clip.gameInMs ?? null,
    depsSnapshot: body.depsSnapshot || null, createdAt: Date.now(),
  });
}

function approveTitle(titleId) {
  const t = store.get('titles', titleId);
  if (!t) throw Object.assign(new Error('title not found'), { status: 404 });
  const check = reconcile.checkTitle({ ...t, status: 'approved' });
  if (check.changed) {
    throw Object.assign(new Error('依赖事实已变化，不能批准，请先复核文案'), {
      status: 409, details: check.reasons,
    });
  }
  return store.update('titles', titleId, { status: 'approved', approvedAt: Date.now(), reviewReasons: null });
}

function correctScore(body) {
  const gameMs = Number(body.gameMs), home = Number(body.home), away = Number(body.away);
  const prev = store.find('scoreStates', s => s.gameMs === gameMs && !s.superseded).slice(-1)[0];
  if (prev) store.update('scoreStates', prev.id, { superseded: true, supersededByScoreId: '__pending__' });
  const tagId = body.scorerTagId || (prev && prev.scorerTagId) || null;
  const row = store.insert('scoreStates', {
    gameMs, home, away, scorerTagId: tagId, source: body.source || 'manual-correction',
    supersedesScoreId: prev ? prev.id : null, superseded: false, createdAt: Date.now(),
  });
  if (prev) store.update('scoreStates', prev.id, { supersededByScoreId: row.id });
  const hits = reconcile.reconcileForGamePoint(gameMs);
  return { score: row, titleReviews: hits };
}

function correctTag(body) {
  const gameMs = Number(body.gameMs);
  const player = store.get('players', body.playerId);
  if (!player) throw Object.assign(new Error('player not found'), { status: 404 });
  const prev = store.find('playerTags', t => t.gameMs === gameMs
    && !store.one('playerTags', x => x.supersedesTagId === t.id)).slice(-1)[0];
  if (prev) store.update('playerTags', prev.id, { supersededByTagId: '__pending__' });
  const row = store.insert('playerTags', {
    gameMs, playerId: player.id, label: body.label || `${player.name}（${player.number}号）`,
    source: body.source || 'manual-correction', corrected: true,
    supersedesTagId: prev ? prev.id : null, createdAt: Date.now(),
  });
  if (prev) store.update('playerTags', prev.id, { supersededByTagId: row.id });
  const hits = reconcile.reconcileForGamePoint(gameMs, player.id);
  return { tag: row, titleReviews: hits };
}

function enqueueJob(body, idemKey) {
  const clip = store.get('clips', body.clipId);
  if (!clip) throw Object.assign(new Error('clip not found'), { status: 404 });
  if (body.timelineVersionId && !store.get('timelineVersions', body.timelineVersionId)) {
    throw Object.assign(new Error('timeline version not found'), { status: 400 });
  }
  const make = () => store.insert('jobs', {
    clipId: clip.id, timelineVersionId: body.timelineVersionId || productionTvId(),
    status: 'queued', idemKey: idemKey || null, requestedAt: Date.now(),
    deletedAtSnapshot: null,
  });
  if (idemKey) {
    const r = store.idempotent('job:' + idemKey, make);
    return { job: r.row, reused: r.reused };
  }
  return { job: make(), reused: false };
}

function deleteClip(clipId, reason) {
  const clip = store.get('clips', clipId);
  if (!clip) throw Object.assign(new Error('clip not found'), { status: 404 });
  store.softDelete('clips', clipId, reason || 'user');
  // 已排队作业保留；其完成时命中墓碑。运行中的下一时刻也会被墓碑化。
  return store.get('clips', clipId);
}

/* ---------- 路由 ---------- */

async function handle(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return send(res, 200, state(url.searchParams.get('tv') || undefined));
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/reset') {
    require('./seed').reset(true);
    return send(res, 200, { ok: true, state: state() });
  }

  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'clips' && seg[3] === 'resolution') {
    const clip = store.get('clips', seg[2]);
    if (!clip) return send(res, 404, { error: 'not found' });
    const tvId = url.searchParams.get('tv') || productionTvId();
    return send(res, 200, tm.resolveClip(clip, tvId));
  }
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'clips' && seg[3] === 'diff') {
    const clip = store.get('clips', seg[2]);
    if (!clip) return send(res, 404, { error: 'not found' });
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!from || !to) return send(res, 400, { error: '需要 from/to 时间轴版本 id' });
    return send(res, 200, tm.diffResolutions(clip, from, to));
  }

  if (req.method === 'POST' && url.pathname === '/api/clips') {
    return send(res, 201, { clip: createClip(body) });
  }
  if (req.method === 'PATCH' && seg[0] === 'api' && seg[1] === 'clips' && seg[3] === 'trim') {
    const clip = store.get('clips', seg[2]);
    if (!clip || clip.deleted) return send(res, 404, { error: 'not found' });
    if (clip.binding !== 'fixed') return send(res, 400, { error: '只有固定源镜头可以帧级修剪' });
    return send(res, 200, { clip: trimFixedClip(clip, body) });
  }
  if (req.method === 'PATCH' && seg[0] === 'api' && seg[1] === 'clips' && seg[3] === 'reorder') {
    const clip = store.get('clips', seg[2]);
    if (!clip || clip.deleted) return send(res, 404, { error: 'not found' });
    return send(res, 200, { clip: store.update('clips', clip.id, { position: Number(body.position) }) });
  }
  if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'clips') {
    return send(res, 200, { clip: deleteClip(seg[2], body.reason) });
  }

  if (req.method === 'POST' && url.pathname === '/api/titles') return send(res, 201, { title: addTitle(body) });
  if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'titles' && seg[3] === 'approve') {
    try { return send(res, 200, { title: approveTitle(seg[2]) }); }
    catch (e) { return send(res, e.status || 500, { error: e.message, details: e.details }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/corrections/score') {
    return send(res, 200, correctScore(body));
  }
  if (req.method === 'POST' && url.pathname === '/api/corrections/player-tag') {
    return send(res, 200, correctTag(body));
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const idem = req.headers['idempotency-key'] || body.idempotencyKey;
    const r = enqueueJob(body, idem);
    return send(res, r.reused ? 200 : 201, r);
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs/run') {
    let n = 0, last = null;
    while (true) { const r = worker.processOne(); if (!r) break; n++; last = r; }
    return send(res, 200, { processed: n, last: last && { jobId: last.job.id, status: last.job.status, packageId: last.package.id } });
  }
  if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'jobs' && seg[3] === 'run') {
    const job = store.get('jobs', seg[2]);
    if (!job) return send(res, 404, { error: 'not found' });
    const r = worker.processOne(job.id);
    return send(res, 200, { job: r.job, package: r.package });
  }

  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'packages' && seg[2]) {
    const f = path.join(store.DATA_DIR, 'packages', seg[2], 'manifest.json');
    if (!fs.existsSync(f)) return send(res, 404, { error: 'package manifest not found' });
    return send(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
  }

  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'probe') {
    // 三坐标探针：给定时间轴 mediaUs，同时返回 比赛计时 / 素材身份与帧位置
    const tvId = url.searchParams.get('tv') || productionTvId();
    const mediaUs = Number(url.searchParams.get('mediaUs'));
    const m = tm.tlToMaterial(tvId, mediaUs);
    const g = tm.mediaToGame(tvId, mediaUs);
    return send(res, 200, { input: { timelineVersionId: tvId, mediaUs }, material: m, game: g });
  }

  return send(res, 404, { error: 'route not found', path: url.pathname });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handle(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      send(res, e.status || 500, { error: e.message || String(e) });
    }
  });
  return server;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.mfv': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  // /data/... 映射到 DATA_DIR（任务包/素材），但禁止访问 db.json
  let root = path.join(__dirname, '..', 'public');
  if (p.startsWith('/data/')) {
    if (p.includes('db.json')) { res.writeHead(403); return res.end('forbidden'); }
    root = store.DATA_DIR; p = p.slice('/data'.length);
  }
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 — 保留坏链接：该素材路径在档登记但文件缺失');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

module.exports = { createServer, state };
