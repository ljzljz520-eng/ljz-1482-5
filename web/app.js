/* 赛事直播切片策划台 — 前端逻辑 */
let S = null;                 // 全量状态
let curAsset = null;
let playMs = 0;               // 当前媒体时间(三坐标联动的基准)
let playing = false, lastTick = 0;
let selIn = null, selOut = null;

const $ = id => document.getElementById(id);
const api = async (m, p, b) => {
  const r = await fetch(p, {method: m, headers: {"Content-Type": "application/json"},
    body: b ? JSON.stringify(b) : undefined});
  const j = await r.json();
  if (!r.ok) { alert((j.error || r.status) + (j.candidates ? "\n候选: " + JSON.stringify(j.candidates) : "")); throw j; }
  return j;
};
const fmtMs = ms => { const s = Math.floor(ms/1000); return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}.${String(Math.floor(ms%1000/100))}`; };
const fmtClock = (p, c) => `${p} ${String(Math.floor(c/60000)).padStart(2,"0")}:${String(Math.floor(c/1000)%60).padStart(2,"0")}`;

function latestTl(assetId) {
  const tls = S.timelines.filter(t => t.asset_id === assetId);
  return tls.sort((a,b) => b.version - a.version)[0];
}
function versionOf(tl) { return S.asset_versions.find(v => v.id === tl.asset_version_id); }

/* 客户端三坐标换算(与服务端同一模型) */
function segAt(tl, ms) {
  return tl.segments.find((s,i) => ms >= s.media_start_ms && (ms < s.media_end_ms || i === tl.segments.length-1));
}
function mediaToFrame(tl, ms) {
  const v = versionOf(tl), fm = v ? JSON.parse(v.frame_map || "[]") : [];
  if (fm.length > 1) {
    for (let i = fm.length - 1; i >= 0; i--) {
      if (ms >= fm[i][1]) {
        if (i+1 < fm.length) { const [f0,t0]=fm[i],[f1,t1]=fm[i+1];
          return Math.floor(f0 + (ms-t0)*(f1-f0)/Math.max(1,t1-t0)); }
        return fm[i][0];
      }
    }
  }
  const s = segAt(tl, ms); if (!s) return null;
  return s.frame_start + Math.floor((ms - s.media_start_ms) * (s.frame_end - s.frame_start) / Math.max(1, s.media_end_ms - s.media_start_ms));
}
function mediaToClock(tl, ms) {
  const s = segAt(tl, ms);
  if (!s || s.kind !== "content" || s.match_period == null) return null;
  const f = (ms - s.media_start_ms) / Math.max(1, s.media_end_ms - s.media_start_ms);
  return [s.match_period, Math.round(s.match_clock_start_ms + f * (s.match_clock_end_ms - s.match_clock_start_ms))];
}

async function refresh() {
  S = await api("GET", "/api/state");
  if (!curAsset || !S.assets.find(a => a.id === curAsset)) curAsset = S.assets[0]?.id;
  renderAll();
}

function renderAll() {
  /* 素材选择 */
  $("assetSel").innerHTML = S.assets.map(a =>
    `<option value="${a.id}" ${a.id===curAsset?"selected":""}>${a.name}${a.status==="withdrawn"?" (已下架)":""}</option>`).join("");
  const tl = latestTl(curAsset);
  const v = tl && versionOf(tl);
  $("assetMeta").textContent = tl ? `时间轴 v${tl.version} · 素材版本 v${v.version} · ${v.fps_type.toUpperCase()} · ${v.content_sha256}` : "无时间轴";
  $("tlInfo").textContent = tl ? `— ${tl.note}` : "";
  /* 球员下拉 */
  $("evPlayer").innerHTML = S.players.map(p => `<option value="${p.id}">${p.name}(${p.team})</option>`).join("");
  renderTimeline(tl); renderPlayer(tl);
  renderEvents(); renderClips(); renderCopy(); renderJobs(); renderRelocs();
}

function renderTimeline(tl) {
  const bar = $("timelineBar");
  if (!tl) { bar.innerHTML = ""; return; }
  const dur = tl.segments[tl.segments.length-1].media_end_ms;
  let html = tl.segments.map(s =>
    `<div class="seg ${s.kind}" style="left:${s.media_start_ms/dur*100}%;width:${(s.media_end_ms-s.media_start_ms)/dur*100}%" title="${s.kind}${s.reset?" · 时间戳重置":""}"></div>`).join("");
  for (const e of S.events.filter(e => e.timeline_id === tl.id))
    html += `<div class="evt-mark" style="left:${e.media_ms/dur*100}%" title="${e.type} ${fmtClock(e.period,e.clock_ms)}"></div>`;
  for (const c of S.clips.filter(c => c.timeline_id === tl.id && !c.deleted_at))
    html += `<div class="clip-range" style="left:${c.in_media_ms/dur*100}%;width:${(c.out_media_ms-c.in_media_ms)/dur*100}%" title="${c.name}"></div>`;
  if (selIn != null && selOut != null)
    html += `<div class="clip-range" style="left:${Math.min(selIn,selOut)/dur*100}%;width:${Math.abs(selOut-selIn)/dur*100}%"></div>`;
  html += `<div class="playhead" id="ph" style="left:${playMs/dur*100}%"></div>`;
  bar.innerHTML = html;
  bar.onclick = ev => {
    const r = bar.getBoundingClientRect();
    playMs = Math.round((ev.clientX - r.left) / r.width * dur);
    renderAll();
  };
}

function renderPlayer(tl) {
  const cv = $("player"), ctx = cv.getContext("2d");
  ctx.fillStyle = "#05070c"; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!tl) return;
  const seg = segAt(tl, playMs);
  const frame = mediaToFrame(tl, playMs);
  const ck = mediaToClock(tl, playMs);
  ctx.fillStyle = seg ? (seg.kind === "content" ? "#7fd4ff" : seg.kind === "ad" ? "#ff8a8a" : "#999") : "#555";
  ctx.font = "bold 26px monospace"; ctx.textAlign = "center";
  const label = !seg ? "无信号" : seg.kind === "ad" ? "广告插播" : seg.kind === "gap" ? "断流" : "比赛画面";
  ctx.fillText(label, cv.width/2, 60);
  ctx.font = "16px monospace"; ctx.fillStyle = "#dde3ee";
  ctx.fillText(`FRAME ${frame ?? "—"}`, cv.width/2, 130);
  ctx.fillText(`PTS ${fmtMs(playMs)}`, cv.width/2, 160);
  ctx.fillText(ck ? fmtClock(ck[0], ck[1]) : "无比赛计时", cv.width/2, 190);
  if (seg && seg.reset) { ctx.fillStyle = "#f6c344"; ctx.fillText("⚠ 本段起点有时间戳重置", cv.width/2, 230); }
  $("cClock").textContent = ck ? fmtClock(ck[0], ck[1]) : "—";
  $("cMedia").textContent = fmtMs(playMs);
  $("cFrame").textContent = frame ?? "—";
}

function renderEvents() {
  $("eventList").innerHTML = S.events.map(e => `
    <li><b>${e.type}</b> ${fmtClock(e.period, e.clock_ms)}
      比分 ${e.score_home ?? "?"}-${e.score_away ?? "?"}
      ${e.players.map(p => `${p.name}(${p.role})`).join("、")}
      <small class="mono">rev${e.revision} · 媒体${fmtMs(e.media_ms)} · 帧${e.frame}</small>
      <button class="ghost" onclick="correctScore('${e.id}')">订正比分</button>
    </li>`).join("");
}

function issueBadges(c) {
  return c.issues.map(i => `<span class="badge issue" title='${JSON.stringify(i.detail)}'>${i.kind}</span>`).join("");
}

function renderClips() {
  $("clipList").innerHTML = S.clips.map(c => `
    <li class="${c.deleted_at ? "deleted" : ""}">
      <div class="row"><b>${c.name}</b>
        <span class="badge ${c.status}">${c.status}</span>
        <span class="badge ${c.anchor_mode === "pinned" ? "draft" : "ready"}">${c.anchor_mode === "pinned" ? "固定源片段" : "跟随时间轴"}</span>
        ${c.deleted_at ? '<span class="badge broken">已删除(坏链接保留)</span>' : ""}
        ${issueBadges(c)}</div>
      <small class="mono">入 媒体${fmtMs(c.in_media_ms)} 帧${c.in_frame} ${c.in_period ? fmtClock(c.in_period, c.in_clock_ms) : ""}
        → 出 媒体${fmtMs(c.out_media_ms)} 帧${c.out_frame} ${c.out_period ? fmtClock(c.out_period, c.out_clock_ms) : ""}
        · 时间轴v${(S.timelines.find(t=>t.id===c.timeline_id)||{}).version ?? "?"}</small>
      <div class="row">
        <button class="ghost" onclick="genCopy('${c.id}')">生成文案</button>
        <button class="ghost" onclick="relocate('${c.id}')">重定位</button>
        <button onclick="exportClip('${c.id}')">导出任务包</button>
        <button class="warn" onclick="delClip('${c.id}')">删除</button>
      </div>
    </li>`).join("");
}

function renderCopy() {
  const items = [];
  for (const c of S.clips) for (const cp of c.copy) items.push({c, cp});
  $("copyList").innerHTML = items.map(({c, cp}) => `
    <li><div class="row"><span class="badge ${cp.status}">${cp.status}</span>
      <b>${c.name}</b> <small class="mono">hash ${cp.source_hash}</small></div>
      <div>${cp.text}</div>
      <div class="row">
        <button class="ghost" onclick="copyAct('${cp.id}','approve')">批准</button>
        <button class="ghost" onclick="copyAct('${cp.id}','reject')">拒绝</button>
      </div></li>`).join("") || '<li class="muted">暂无文案</li>';
}

function renderJobs() {
  $("jobList").innerHTML = S.jobs.map(j => {
    const pkg = S.packages.find(p => p.job_id === j.id);
    return `<li><div class="row"><span class="badge ${j.status}">${j.status}</span>
      <small class="mono">${j.id} · 键 ${j.idempotency_key}</small>
      ${pkg ? `<button class="ghost" onclick="viewPkg('${pkg.id}')">查看任务包</button>` : ""}
      ${j.status === "orphaned" ? '<span class="badge orphaned">完成晚于删除</span>' : ""}
      </div></li>`;
  }).join("") || '<li class="muted">暂无作业</li>';
}

function renderRelocs() {
  $("relocList").innerHTML = S.relocations.map(r =>
    `<li><span class="badge ${r.outcome === "conflict" ? "conflict" : "ready"}">${r.outcome}</span>
     <small class="mono">${r.clip_id}</small> ${r.detail}</li>`).join("") || '<li class="muted">暂无重定位记录</li>';
}

/* ---- 动作 ---- */
window.correctScore = async id => {
  const h = prompt("新比分-主队", "1"), a = prompt("新比分-客队", "1");
  if (h == null) return;
  const r = await api("PATCH", `/api/events/${id}`, {score_home: +h, score_away: +a});
  if (r.copy_flagged_for_review.length) alert(`已打回 ${r.copy_flagged_for_review.length} 条文案待复核`);
  refresh();
};
window.genCopy = async cid => { await api("POST", `/api/clips/${cid}/copy`, {}); refresh(); };
window.copyAct = async (id, action) => { await api("POST", `/api/copy/${id}`, {action, by: "主编"}); refresh(); };
window.delClip = async id => { await api("POST", `/api/clips/${id}/delete`, {}); refresh(); };
window.relocate = async id => {
  const r = await api("POST", `/api/clips/${id}/relocate`, {});
  if (r.reason === "ambiguous") {
    const pick = prompt("计时重复,候选媒体位置:\n" +
      r.candidates.map((c,i) => `${i}: ${fmtMs(c.media_ms)}${c.reset?" (重置段)":""}`).join("\n") + "\n输入序号选定");
    if (pick != null) {
      const c = r.candidates[+pick];
      const clip = S.clips.find(x => x.id === id);
      const dur = clip.out_media_ms - clip.in_media_ms;
      await api("POST", `/api/clips/${id}/relocate`,
        {chosen_in_media_ms: c.media_ms, chosen_out_media_ms: c.media_ms + dur});
    }
  }
  refresh();
};
window.exportClip = async cid => {
  const r = await api("POST", "/api/jobs",
    {clip_id: cid, idempotency_key: "exp-" + cid});
  pollJob(r.id);
};
window.viewPkg = async pid => {
  const m = await api("GET", `/api/packages/${pid}`);
  $("pkgView").textContent = JSON.stringify(m, null, 2);
};
async function pollJob(id) {
  const t = setInterval(async () => {
    const j = await api("GET", `/api/jobs/${id}`);
    if (!["queued", "running"].includes(j.status)) {
      clearInterval(t);
      if (j.result) $("pkgView").textContent = JSON.stringify(JSON.parse(j.result), null, 2);
      refresh();
    }
  }, 300);
}

$("btnPlay").onclick = () => { playing = !playing; $("btnPlay").textContent = playing ? "⏸ 暂停" : "▶ 播放"; lastTick = performance.now(); };
$("btnBack").onclick = () => { playMs = Math.max(0, playMs - 10000); renderAll(); };
$("btnFwd").onclick = () => { playMs += 10000; renderAll(); };
$("assetSel").onchange = e => { curAsset = e.target.value; playMs = 0; selIn = selOut = null; renderAll(); };
$("btnSetIn").onclick = () => { selIn = playMs; $("inOutView").textContent = `入 ${fmtMs(selIn)} / 出 ${selOut==null?"—":fmtMs(selOut)}`; renderAll(); };
$("btnSetOut").onclick = () => { selOut = playMs; $("inOutView").textContent = `入 ${selIn==null?"—":fmtMs(selIn)} / 出 ${fmtMs(selOut)}`; renderAll(); };

$("btnAddEvent").onclick = async () => {
  const tl = latestTl(curAsset); if (!tl) return;
  const ck = mediaToClock(tl, playMs);
  const body = {match_id: "M2026-10-03", asset_id: curAsset, timeline_id: tl.id,
    at_media_ms: playMs, type: $("evType").value, team: $("evTeam").value,
    score_home: +$("evScoreH").value, score_away: +$("evScoreA").value,
    players: [{player_id: $("evPlayer").value, role: $("evRole").value}]};
  if (ck) { body.at_period = ck[0]; body.at_clock_ms = ck[1]; }
  await api("POST", "/api/events", body); refresh();
};

$("btnMakeClip").onclick = async () => {
  if (selIn == null || selOut == null) return alert("先设入出点");
  const tl = latestTl(curAsset);
  const evts = S.events.filter(e => e.timeline_id === tl.id &&
    e.media_ms >= Math.min(selIn,selOut) && e.media_ms <= Math.max(selIn,selOut)).map(e => e.id);
  const ckIn = mediaToClock(tl, Math.min(selIn, selOut)), ckOut = mediaToClock(tl, Math.max(selIn, selOut));
  const body = {match_id: "M2026-10-03", asset_id: curAsset, timeline_id: tl.id,
    name: $("clipName").value, anchor_mode: $("anchorMode").value,
    in_media_ms: Math.min(selIn,selOut), out_media_ms: Math.max(selIn,selOut), event_ids: evts};
  if (ckIn) { body.in_period = ckIn[0]; body.in_clock_ms = ckIn[1]; }
  if (ckOut) { body.out_period = ckOut[0]; body.out_clock_ms = ckOut[1]; }
  await api("POST", "/api/clips", body); selIn = selOut = null;
  $("inOutView").textContent = "未设置"; refresh();
};

/* ---- 运维演练 ---- */
function cfrMap(dur) { const m = []; for (let t = 0; t <= dur; t += 10000) m.push([t/1000*25, t]); return m; }
$("btnPubV2").onclick = async () => {
  const av = await api("POST", `/api/assets/${curAsset}/versions`,
    {uri: "s3://media/liveA/20261003-clean.ts", duration_ms: 6000000,
     fps_type: "cfr", frame_map: cfrMap(6000000)});
  const r = await api("POST", `/api/assets/${curAsset}/timelines`, {
    asset_version_id: av.id, note: "v2 后补净信号(去广告/去断流)",
    segments: [
      {kind:"content",media_start_ms:0,media_end_ms:2700000,frame_start:0,frame_end:67500,
       match:{period:"1H",clock_start_ms:0,clock_end_ms:2700000}},
      {kind:"content",media_start_ms:2700000,media_end_ms:5400000,frame_start:67500,frame_end:135000,
       match:{period:"2H",clock_start_ms:0,clock_end_ms:2700000}},
      {kind:"content",media_start_ms:5400000,media_end_ms:6000000,frame_start:135000,frame_end:150000,
       match:{period:"ET1",clock_start_ms:0,clock_end_ms:600000}}]});
  alert("v2已发布, 重定位: " + JSON.stringify(r.relocation)); refresh();
};
$("btnPubV3").onclick = async () => {
  const av = await api("POST", `/api/assets/${curAsset}/versions`,
    {uri: "s3://media/liveA/20261003-reset.ts", duration_ms: 5400000,
     fps_type: "cfr", frame_map: cfrMap(5400000)});
  const r = await api("POST", `/api/assets/${curAsset}/timelines`, {
    asset_version_id: av.id, note: "v3 时间戳重置: 1H计时重复出现",
    segments: [
      {kind:"content",media_start_ms:0,media_end_ms:2700000,frame_start:0,frame_end:67500,
       match:{period:"1H",clock_start_ms:0,clock_end_ms:2700000}},
      {kind:"content",media_start_ms:2700000,media_end_ms:5400000,frame_start:67500,frame_end:135000,
       reset:true, match:{period:"1H",clock_start_ms:0,clock_end_ms:2700000}}]});
  alert("v3已发布(计时重复), 重定位: " + JSON.stringify(r.relocation)); refresh();
};
$("btnWithdraw").onclick = async () => { await api("POST", `/api/assets/${curAsset}/withdraw`, {}); refresh(); };
$("btnCorrect").onclick = async () => {
  const ev = S.events.find(e => e.type === "goal");
  if (ev) { const r = await api("PATCH", `/api/events/${ev.id}`, {score_home: 1, score_away: 1});
    alert(`订正完成, 打回复核文案 ${r.copy_flagged_for_review.length} 条`); refresh(); }
};
$("btnRefresh").onclick = refresh;

/* 播放循环 */
setInterval(() => {
  if (!playing || !S) return;
  const now = performance.now();
  playMs += now - lastTick; lastTick = now;
  const tl = latestTl(curAsset);
  if (tl) playMs = Math.min(playMs, tl.segments[tl.segments.length-1].media_end_ms);
  renderTimeline(tl); renderPlayer(tl);
}, 100);

refresh();
