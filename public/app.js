'use strict';
/* eslint-disable */
const $ = s => document.querySelector(s);
const api = async (p, opt) => {
  const r = await fetch(p, { headers: { 'content-type': 'application/json' }, ...opt });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { details: j.details });
  return j;
};
const post = (p, body, headers) => api(p, { method: 'POST', body: JSON.stringify(body || {}), headers });
const patch = (p, body) => api(p, { method: 'PATCH', body: JSON.stringify(body || {}) });
const del = (p, body) => api(p, { method: 'DELETE', body: JSON.stringify(body || {}) });

const fmtUs = us => (us == null ? '–' : (us / 1e6).toFixed(6) + ' s');
const fmtGame = ms => {
  if (ms == null) return '–';
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return `${m}′${s.toFixed(2).padStart(5, '0')}″`;
};

let S = null, tvId = null;
/* 播放器状态：current 描述“当前寻址”，所有三个坐标都显式保存，永不互相冒充 */
const cur = {
  segmentId: null, materialVersionId: null, materialId: null,
  mediaUs: 0, frame: 0, srcPtsUs: 0, gameMs: null,
  fileAvailable: true, fps: 30, vfr: false, playing: false,
};

async function load(keepTv) {
  if (!keepTv || !tvId) {
    const s0 = await fetch('/api/state').then(r => r.json());
    tvId = s0.selectedTimelineVersionId;
  }
  S = await api('/api/state?tv=' + encodeURIComponent(tvId));
  render();
}

/* ---------------- 版本 Tab ---------------- */
function renderTabs() {
  $('#versionTabs').innerHTML = S.timelineVersions.map(t =>
    `<div class="tab ${t.id === tvId ? 'active' : ''}" data-tv="${t.id}" title="${t.label}">
       v${t.version} ${t.isProduction ? '<span class="prod">●生产</span>' : ''}<br><small>${t.label.slice(0, 22)}</small>
     </div>`).join('');
  $('#versionTabs').querySelectorAll('.tab').forEach(el =>
    el.onclick = () => { tvId = el.dataset.tv; load(true); });
  $('#revBadge').textContent = 'store rev ' + S.rev;
}

/* ---------------- 时间轴 ---------------- */
function segClass(s) {
  if (s.kind === 'gap') return 'gap';
  if (s.role === 'advertisement') return 'ad';
  if (s.role === 'replay_package') return 'replay';
  if (s.role === 'alternate_angle') return 'alt';
  return 'program';
}
function segLabel(s) {
  if (s.kind === 'gap') return (s.gapKind === 'ad' ? '广告' : s.gapKind === 'rights' ? '权利缺口' : '断流') + ' ' + (s.durationUs / 60e6).toFixed(0) + '′';
  const mv = S.materialVersions.find(v => v.id === s.materialVersionId);
  const mat = S.materials.find(m => m.id === mv.materialId);
  return `${mat ? mat.name.slice(0, 6) : '?'} ${(s.tlStartUs / 60e6).toFixed(0)}′`;
}

function renderTimeline() {
  const segs = S.segments;
  const total = segs.reduce((m, s) => Math.max(m, s.tlStartUs + s.durationUs), 0);
  const bar = $('#timelineBar');
  bar.innerHTML = '<div id="tlPlayhead" class="tl-playhead" style="left:0%"></div>';
  for (const s of segs) {
    const d = document.createElement('div');
    d.className = 'tl-seg ' + segClass(s);
    d.style.width = (s.durationUs / total * 100) + '%';
    d.textContent = segLabel(s);
    d.title = `${s.kind === 'gap' ? '缺口' : '节目'} ${fmtUs(s.tlStartUs)}–${fmtUs(s.tlStartUs + s.durationUs)}\n源起 ${s.srcStartUs != null ? fmtUs(s.srcStartUs) : '—'}`;
    d.onclick = ev => {
      const rect = bar.getBoundingClientRect();
      const us = Math.round((ev.clientX - rect.left) / rect.width * total);
      seek(us);
    };
    bar.appendChild(d);
  }
  bar.onclick = ev => {
    if (ev.target !== bar) return;
    const rect = bar.getBoundingClientRect();
    seek(Math.round((ev.clientX - rect.left) / rect.width * total));
  };
  $('#tlSummary').textContent = `共 ${segs.length} 段，时间轴长 ${(total / 60e6).toFixed(0)}′（媒体时间）`;

  const cb = $('#clockBar');
  cb.innerHTML = '';
  for (const c of S.clockSegments) {
    const d = document.createElement('div');
    d.className = 'clock-run ' + (c.running ? '' : 'clock-stop');
    d.style.left = (c.tlStartUs / total * 100) + '%';
    d.style.width = ((c.tlEndUs - c.tlStartUs) / total * 100) + '%';
    d.textContent = `${fmtGame(c.gameStartMs)}→${fmtGame(c.gameEndMs)}`;
    d.title = `clockSegment ${c.id}（${c.period}）`;
    cb.appendChild(d);
  }
  updatePlayhead();
}

/* ---------------- 合成播放器 ---------------- */
const ctx = () => stage.getContext('2d');
const stage = $('#stage');

function findSegAt(us) {
  return S.segments.find(s => us >= s.tlStartUs && us < s.tlStartUs + s.durationUs)
    || S.segments[S.segments.length - 1];
}

function applyMediaUs(us) {
  us = Math.max(0, Math.min(us, S.segments.reduce((m, s) => Math.max(m, s.tlStartUs + s.durationUs), 0) - 1));
  const s = findSegAt(us);
  cur.segmentId = s.id;
  cur.mediaUs = us;
  if (s.kind === 'gap') {
    cur.materialVersionId = null; cur.materialId = null; cur.fileAvailable = true;
    cur.frame = null; cur.srcPtsUs = null;
  } else {
    const mv = S.materialVersions.find(v => v.id === s.materialVersionId);
    cur.materialVersionId = mv.id; cur.materialId = mv.materialId;
    cur.fileAvailable = mv.fileAvailable; cur.fps = mv.fpsNominal;
    cur.vfr = !!mv.vfrAmp || (mv.vfrDropFrames || []).length > 0;
    const src = s.srcStartUs + (us - s.tlStartUs);
    const f = mediaToFrame(mv, src);
    cur.frame = f.frame; cur.srcPtsUs = f.ptsUs; cur.snap = f.snapErrorUs; cur.fdur = f.frameDurationUs;
  }
  const g = gameAt(us);
  cur.gameMs = g ? g.gameMs : null;
}

/* 与服务端完全相同的确定性 VFR 公式（前端本地复算，保证预览帧=任务包帧） */
function framePtsUs(mv, f) {
  const fps = mv.fpsNominal || 30, amp = mv.vfrAmp ?? 0, period = mv.vfrPeriod || 12, base = 1e6 / fps;
  let p = Math.round(f * base + base * amp * period / (2 * Math.PI) * (1 - Math.cos(2 * Math.PI * f / period)));
  for (const d of mv.vfrDropFrames || []) if (f > d) p += mv.vfrDropUs || 400000;
  return p;
}
function mediaToFrame(mv, pts) {
  let lo = 0, hi = mv.frameCount;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (framePtsUs(mv, m) <= pts) lo = m; else hi = m - 1; }
  const p = framePtsUs(mv, lo), pn = lo < mv.frameCount ? framePtsUs(mv, lo + 1) : p;
  return { frame: lo, ptsUs: p, snapErrorUs: pts - p, frameDurationUs: pn - p };
}
function gameAt(us) {
  const c = S.clockSegments.find(x => us >= x.tlStartUs && us < x.tlEndUs)
    || S.clockSegments.find(x => us === x.tlEndUs);
  if (!c) return null;
  const spanUs = c.tlEndUs - c.tlStartUs, spanMs = c.gameEndMs - c.gameStartMs;
  return { gameMs: Math.round(c.gameStartMs + (us - c.tlStartUs) / spanUs * spanMs), running: c.running, period: c.period };
}

function seek(us) { applyMediaUs(us); renderCoords(); draw(); updatePlayhead(); }

function nudgeFrames(n) {
  if (cur.materialVersionId == null) { // 在缺口里按时间轴移动
    return seek(cur.mediaUs + n * 33333);
  }
  const mv = S.materialVersions.find(v => v.id === cur.materialVersionId);
  const s = S.segments.find(x => x.id === cur.segmentId);
  const target = Math.max(0, Math.min(mv.frameCount, cur.frame + n));
  const pts = framePtsUs(mv, target);
  const us = s.tlStartUs + (pts - s.srcStartUs);
  seek(us);
}

function draw() {
  const c = ctx();
  const s = S.segments.find(x => x.id === cur.segmentId);
  c.fillStyle = '#000'; c.fillRect(0, 0, stage.width, stage.height);

  if (!s || s.kind === 'gap') {
    c.fillStyle = '#1d242e'; c.fillRect(0, 0, stage.width, stage.height);
    c.strokeStyle = 'rgba(255,255,255,.15)'; c.lineWidth = 12;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(stage.width, stage.height); c.moveTo(stage.width, 0); c.lineTo(0, stage.height); c.stroke();
    c.fillStyle = '#c8d3df'; c.font = 'bold 26px sans-serif'; c.textAlign = 'center';
    c.fillText(s && s.gapKind === 'ad' ? '广告插入（无节目信号）' : s && s.gapKind === 'rights' ? '权利缺口：画面被撤回' : '断流缺口', stage.width / 2, 170);
    c.font = '15px monospace'; c.fillStyle = '#8b97a7';
    c.fillText(`mediaUs ${cur.mediaUs} µs   |   game ${fmtGame(cur.gameMs)}`, stage.width / 2, 210);
  } else {
    const mv = S.materialVersions.find(v => v.id === cur.materialVersionId);
    const mat = S.materials.find(m => m.id === cur.materialId);
    // 合成画面：随帧号变化的运动色块（VFR 下墙钟速度与帧不一致，刻意可见）
    const t = cur.frame / mv.fpsNominal;
    const hue = (cur.frame * 3) % 360;
    c.fillStyle = `hsl(${hue} 40% 14%)`; c.fillRect(0, 0, stage.width, stage.height);
    c.fillStyle = `hsl(${(hue + 120) % 360} 70% 55%)`;
    c.fillRect(60 + Math.sin(t * 2) * 120, 120 + Math.cos(t * 1.3) * 60, 150, 90);
    c.fillStyle = 'rgba(255,255,255,.08)';
    for (let i = 0; i < 6; i++) c.fillRect(0, i * 70 + (cur.frame % 70), stage.width, 2);
    c.fillStyle = '#fff'; c.font = 'bold 30px monospace'; c.textAlign = 'center';
    c.fillText(`FRAME ${cur.frame}`, stage.width / 2, 300);
    c.font = '16px monospace'; c.fillStyle = '#9fe0a0';
    c.fillText(`${mat.name} · ${mv.id} · ${cur.vfr ? 'VFR' : 'CFR'} ${cur.fps}fps`, stage.width / 2, 335);
    if ((mv.vfrDropFrames || []).length && cur.frame > mv.vfrDropFrames[0]) {
      c.fillStyle = '#d29922'; c.fillText('（已越过断流 PTS 空洞）', stage.width / 2, 365);
    }
  }
  $('#brokenOverlay').classList.toggle('hidden', cur.fileAvailable !== false);
  if (cur.fileAvailable === false) {
    const mv = S.materialVersions.find(v => v.id === cur.materialVersionId);
    $('#brokenDetail').textContent = `${mv.fileUri}（sha256 ${mv.fileSha256.slice(0, 16)}… 已登记，文件在档缺失）`;
  }
}

function renderCoords() {
  const s = S.segments.find(x => x.id === cur.segmentId);
  const mv = cur.materialVersionId && S.materialVersions.find(v => v.id === cur.materialVersionId);
  $('#vFrame').textContent = cur.frame == null ? '缺口（无帧）' : `#${cur.frame} / ${mv.frameCount}`;
  $('#vFrameVer').textContent = mv ? `${mv.id} · ${cur.vfr ? 'VFR非线性' : '线性'}` : '–';
  $('#vPts').textContent = cur.srcPtsUs == null ? '–' : `${cur.srcPtsUs.toLocaleString()} µs`;
  $('#vPtsVer').textContent = mv ? `帧→PTS 经 ${mv.id} 映射` : '–';
  $('#vMedia').textContent = `${cur.mediaUs.toLocaleString()} µs`;
  $('#vMediaVer').textContent = S.timelineVersions.find(t => t.id === tvId).label.slice(0, 18);
  $('#vGame').textContent = fmtGame(cur.gameMs) + (cur.gameMs == null ? '' : ` (${cur.gameMs} ms)`);
  const g = cur.gameMs == null ? null : S.clockSegments.find(c => cur.mediaUs >= c.tlStartUs && cur.mediaUs < c.tlEndUs) || S.clockSegments.find(c => cur.mediaUs === c.tlEndUs);
  $('#vGameVer').textContent = g ? `${g.id} · ${g.running ? '走表' : '停表'} · ${g.period}` : '无 clock 段（广告未映射）';
  $('#snapNote').textContent = cur.snap != null
    ? `吸附误差 in=${cur.snap} µs；该帧时长 ${cur.fdur} µs（VFR，非 1/帧率常数）。入出点按帧交付，不用秒数。` : '';
  $('#vfrBadge').style.display = mv && cur.vfr ? '' : 'none';
  // 段选择器
  const sel = $('#segSelect');
  if (!sel.dataset.filled || sel.options.length !== S.segments.length) {
    sel.innerHTML = S.segments.map(x => `<option value="${x.id}">${segLabel(x)}</option>`).join('');
    sel.dataset.filled = '1';
  }
  sel.value = cur.segmentId;
}

function updatePlayhead() {
  const total = S.segments.reduce((m, s) => Math.max(m, s.tlStartUs + s.durationUs), 0);
  const ph = $('#tlPlayhead');
  if (ph) ph.style.left = (cur.mediaUs / total * 100) + '%';
}

/* ---------------- Rundown ---------------- */
const blockerText = {
  contains_gap: '跨缺口（广告/断流/权利）', no_program_material: '无节目素材',
  broken_media_link: '素材坏链接', license_gap: '许可未覆盖', unapproved_titles: '含未批准文案',
  frame_mapping_failed: '帧映射失败', ambiguous_clock_mapping: '计时映射歧义', clock_unmapped: '计时失联',
};
function renderClips() {
  $('#reelStats').textContent = `${S.clips.length} 个镜头 · ${S.clips.filter(c => c.resolution.status === 'ok').length} 可出片 · ${S.clipTombstones.length} 墓碑`;
  $('#clipList').innerHTML = S.clips.map(c => {
    const r = c.resolution;
    const pieces = (r.pieces || []).map((p, i) =>
      `#${i + 1} ${p.materialVersionId} 帧${p.frameIn}–${p.frameOut} @${fmtGame(p.gameInMs)}${p.fileAvailable ? '' : ' 🔴断链'}`).join('\n');
    const gaps = (r.gapPieces || []).map(g => `△ ${g.gapKind} 缺口 ${fmtGame(g.gameInMs)}–${fmtGame(g.gameOutMs)}`).join('\n');
    return `<div class="clip">
      <div class="clip-head">
        <span class="pill ${c.binding === 'fixed' ? 'fixed' : 'live'}">${c.binding === 'fixed' ? '固定源' : '直播锚'}</span>
        <span class="clip-name">${c.position}. ${c.name}</span>
        <span class="pill ${r.status}">${r.status === 'ok' ? '可出片' : '冲突'}</span>
      </div>
      <div class="clip-meta">
        ${c.binding === 'fixed'
          ? `帧 ${c.frameInBaseline}–${c.frameOutBaseline} · ${c.materialVersionId}`
          : `比赛 ${fmtGame(c.gameInMs)}–${fmtGame(c.gameOutMs)}`}
        ${r.licensing ? (r.licensing.fullyLicensed ? '<span class="lic-ok"> · 许可全覆盖</span>' : '<span class="lic-no"> · 许可缺口</span>') : ''}
        ${r.conflictType ? ` · <span class="lic-no">${r.conflictType}</span>` : ''}
      </div>
      <div class="blocks">${(r.blockers || []).map(b => `<span class="block-tag ${b === 'contains_gap' ? 'warn' : ''}">${blockerText[b] || b}</span>`).join('')}</div>
      ${pieces || gaps ? `<div class="pieces">${[pieces, gaps].filter(Boolean).join('\n')}</div>` : ''}
      <div class="clip-actions">
        <button data-act="seek" data-id="${c.id}">预览入点</button>
        <button data-act="job" data-id="${c.id}">入队裁切</button>
        <button data-act="del" data-id="${c.id}">删除（保留墓碑）</button>
      </div>
    </div>`;
  }).join('') + S.clipTombstones.map(c =>
    `<div class="clip" style="opacity:.55"><div class="clip-head"><span class="pill deleted">已删除</span>
      <span class="clip-name">${c.name}</span></div><div class="clip-meta">墓碑保留 · 原因：${c.deletedReason || '–'} · 已入队作业完成时将产出 tombstone 包</div></div>`).join('');

  $('#clipList').querySelectorAll('button').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    try {
      if (b.dataset.act === 'seek') { seekClip(id); }
      if (b.dataset.act === 'job') { await post('/api/jobs', { clipId: id }); await load(true); }
      if (b.dataset.act === 'del') {
        if (confirm('软删除该镜头？已排队的作业将在完成时命中墓碑。')) { await del('/api/clips/' + id, { reason: 'ui' }); await load(true); }
      }
    } catch (e) { alert(e.message); }
  });
}

function seekClip(id) {
  const c = S.clips.find(x => x.id === id);
  if (c.binding === 'fixed') {
    // 固定镜头：帧是第一坐标，用基线时间轴上的引用位置预览（若当前版本无引用则停留在原段）
    const refs = c.resolution.pieces;
    if (refs[0]) {
      const seg = S.segments.find(s => s.materialVersionId === refs[0].materialVersionId);
      if (seg) { seek(seg.tlStartUs + (refs[0].srcPtsInUs - seg.srcStartUs)); return; }
    }
    return alert('当前时间轴版本无法定位该固定镜头的引用位置（镜头仍保留，帧绑定不变）。');
  }
  // 直播镜头：从比赛计时找当前版本的媒体位置
  const hits = gameToMediaLocal(c.gameInMs);
  if (!hits.length) return alert('入点比赛计时在当前版本失联（无法定位片段，镜头已保留）。');
  if (hits.length > 1) return alert('歧义：同一比赛计时在当前版本有多个媒体位置（后补素材重叠），需人工选择。');
  seek(hits[0]);
}
function gameToMediaLocal(gameMs) {
  const out = [];
  for (const cs of S.clockSegments) {
    if (gameMs >= cs.gameStartMs && gameMs < cs.gameEndMs) {
      out.push(Math.round(cs.tlStartUs + (gameMs - cs.gameStartMs) / (cs.gameEndMs - cs.gameStartMs) * (cs.tlEndUs - cs.tlStartUs)));
    }
  }
  return out;
}

/* ---------------- 比分 ---------------- */
function renderScores() {
  const latest = [...S.scoreStates].filter(x => !x.superseded).sort((a, b) => b.gameMs - a.gameMs)[0];
  $('#scoreNow').textContent = latest ? `${fmtGame(latest.gameMs)}  ${latest.home} : ${latest.away}` : '';
  $('#scoreList').innerHTML = [...S.scoreStates].sort((a, b) => a.gameMs - b.gameMs || a.id.localeCompare(b.id)).map(x =>
    `<div class="fact ${x.superseded ? 'superseded' : ''}"><span>${fmtGame(x.gameMs)} ${x.home}:${x.away}</span><span>${x.source}${x.superseded ? '（已订正）' : ''}</span></div>`).join('');
}

/* ---------------- 标题 ---------------- */
function renderTitles() {
  const stText = { approved: '已批准', pending: '待审', review_required: '复核中', rejected: '驳回' };
  $('#titleList').innerHTML = S.titles.map(t => {
    const c = S.clips.find(x => x.id === t.clipId) || S.clipTombstones.find(x => x.id === t.clipId);
    return `<div class="title-item">
      <div><span class="st-${t.status}">●${stText[t.status] || t.status}</span> <span class="title-text">${t.text}</span></div>
      <div class="title-meta">${c ? c.name : t.clipId} · ${t.kind} · 锚点 ${fmtGame(t.anchorGameMs)}
        ${(t.reviewReasons || []).map(r => `<br>↳ 触发复核：${r.kind === 'score_changed' ? `比分 ${r.from.home}-${r.from.away}→${r.to.home}-${r.to.away}` : `球员标签 ${r.from}→${r.to}`}`).join('')}
      </div>
      ${t.status !== 'approved' ? `<div class="clip-actions"><button data-tid="${t.id}" class="approve-btn">批准（系统会先核对事实）</button></div>` : ''}
    </div>`;
  }).join('');
  $('#titleList').querySelectorAll('.approve-btn').forEach(b => b.onclick = async () => {
    try { await post('/api/titles/' + b.dataset.tid + '/approve', {}); await load(true); }
    catch (e) { alert('无法批准：' + e.message + (e.details ? '\n' + JSON.stringify(e.details) : '')); }
  });
  $('#ntClip').innerHTML = S.clips.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

/* ---------------- 作业/任务包 ---------------- */
function renderJobsPkgs() {
  $('#jobClipSel').innerHTML = S.clips.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const stColor = { queued: 'var(--dim)', running: 'var(--accent)', done: 'var(--good)', blocked: 'var(--bad)', failed: 'var(--bad)', tombstoned: 'var(--warn)' };
  $('#jobList').innerHTML = [...S.jobs].reverse().map(j =>
    `<div class="job"><span class="st" style="color:${stColor[j.status] || '#fff'}">${j.status}</span>
      <span style="flex:1">${j.clipId} → v${(S.timelineVersions.find(t => t.id === j.timelineVersionId) || {}).version || '?'}</span>
      ${j.packageId ? `<small>${j.packageId}</small>` : ''}</div>`).join('');
  $('#pkgList').innerHTML = [...S.packages].reverse().map(p =>
    `<details class="pkg"><summary><span class="pill ${p.status === 'ready' ? 'ok' : 'conflict'}">${p.status}</span> ${p.packageId} · ${p.jobId}
      <a href="/data/${p.dir}/manifest.json" target="_blank">manifest.json</a> · <a href="/data/${p.dir}/README.txt" target="_blank">README</a></summary>
      <pre data-dir="${p.dir}">点击加载 manifest…</pre></details>`).join('');
  $('#pkgList').querySelectorAll('details').forEach(d => d.ontoggle = async () => {
    if (!d.open) return;
    const pre = d.querySelector('pre');
    if (pre.dataset.loaded) return;
    pre.textContent = JSON.stringify(await api('/data/' + pre.dataset.dir + '/manifest.json').catch(e => ({ error: e.message })), null, 2);
    pre.dataset.loaded = '1';
  });
}

/* ---------------- 固定镜头修剪 ---------------- */
function renderFixed() {
  const fixed = S.clips.filter(c => c.binding === 'fixed');
  $('#fixClipSel').innerHTML = fixed.map(c => `<option value="${c.id}">${c.name}（帧 ${c.frameInBaseline}–${c.frameOutBaseline}）</option>`).join('');
  const sync = () => {
    const c = fixed.find(x => x.id === $('#fixClipSel').value);
    if (!c) return;
    $('#fixIn').value = c.frameInBaseline; $('#fixOut').value = c.frameOutBaseline;
    $('#fixInfo').textContent = `${c.materialVersionId} · 入PTS ${fmtUs(c.resolution.pieces[0] && c.resolution.pieces[0].srcPtsInUs)}（帧换算，非线性）`;
  };
  $('#fixClipSel').onchange = sync; sync();
}

/* ---------------- 主渲染 ---------------- */
function render() {
  renderTabs();
  renderTimeline();
  renderClips();
  renderScores();
  renderTitles();
  renderJobsPkgs();
  renderFixed();
  if (!cur.segmentId || !S.segments.find(s => s.id === cur.segmentId)) applyMediaUs(cur.mediaUs || 0);
  renderCoords(); draw();
}

/* ---------------- 事件 ---------------- */
$('#btnPlay').onclick = () => {
  cur.playing = !cur.playing;
  $('#btnPlay').textContent = cur.playing ? '⏸ 暂停' : '▶ 播放';
  let last = performance.now();
  const tick = now => {
    if (!cur.playing) return;
    const dt = now - last; last = now;
    // 播放按墙钟推进媒体时间；VFR 段帧推进不均匀（draw 中可见），缺口段无帧
    seek(Math.min(cur.mediaUs + dt * 1000, S.segments.reduce((m, s) => Math.max(m, s.tlStartUs + s.durationUs), 0) - 1));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
$('#nextFrame').onclick = () => nudgeFrames(1);
$('#prevFrame').onclick = () => nudgeFrames(-1);
$('#nextKey').onclick = () => seek(cur.mediaUs + 1e6);
$('#prevKey').onclick = () => seek(cur.mediaUs - 1e6);
$('#segSelect').onchange = e => {
  const s = S.segments.find(x => x.id === e.target.value);
  seek(s.tlStartUs + 1000);
};
$('#btnAddClip').onclick = async () => {
  try {
    await post('/api/clips', {
      name: $('#ncName').value || '新镜头',
      gameInMs: Math.round(parseFloat($('#ncInM').value) * 60000),
      gameOutMs: Math.round(parseFloat($('#ncOutM').value) * 60000),
    });
    await load(true);
  } catch (e) { alert(e.message); }
};
$('#btnCorrectScore').onclick = async () => {
  try {
    const r = await post('/api/corrections/score', {
      gameMs: Math.round(parseFloat($('#csM').value) * 60000),
      home: Number($('#csH').value), away: Number($('#csA').value), source: 'ui-correction',
    });
    await load(true);
    alert(r.titleReviews.length ? `已触发 ${r.titleReviews.length} 个标题复核` : '已订正（当前无已批准标题命中该时间点）');
  } catch (e) { alert(e.message); }
};
$('#btnAddTitle').onclick = async () => {
  try {
    const c = S.clips.find(x => x.id === $('#ntClip').value);
    await post('/api/titles', { clipId: c.id, text: $('#ntText').value, anchorGameMs: c.gameInMs ?? c.gameOutMs ?? null });
    $('#ntText').value = ''; await load(true);
  } catch (e) { alert(e.message); }
};
$('#btnEnqueue').onclick = async () => {
  try { await post('/api/jobs', { clipId: $('#jobClipSel').value }, { 'content-type': 'application/json', 'Idempotency-Key': 'ui-' + $('#jobClipSel').value + '-' + tvId }); await load(true); }
  catch (e) { alert(e.message); }
};
$('#btnRunAll').onclick = async () => { await post('/api/jobs/run', {}); await load(true); };
$('#btnTrim').onclick = async () => {
  const id = $('#fixClipSel').value;
  try {
    await patch(`/api/clips/${id}/trim`, { frameIn: Number($('#fixIn').value), frameOut: Number($('#fixOut').value) });
    await load(true);
  } catch (e) { alert(e.message); }
};
$('#btnReset').onclick = async () => {
  if (!confirm('重置全部演示数据？')) return;
  await post('/api/admin/reset', {});
  tvId = null; await load();
};

load();
