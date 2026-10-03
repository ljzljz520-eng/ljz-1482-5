'use strict';
/**
 * 三坐标版本化时间模型 —— 全系统的核心不变量。
 *
 * 三个量绝不能用同一个“秒数”表示：
 *   1) gameMs   比赛计时（相对开赛，毫秒；走表/停表/广告期间冻结/重置）
 *   2) mediaUs  时间轴媒体时间（相对该时间轴版本起点，微秒；广告、重置、替换后不连续）
 *   3) frame    素材内帧位置（帧号整数；VFR 下帧间隔不恒定，帧号↔PTS 非线性）
 *
 * 绑定关系全部带版本：
 *   mediaUs --(timelineVersionId + segments)--> 某 materialVersion 的 srcStartUs
 *   srcStartUs --(materialVersionId + VFR PTS 表)--> frame
 *   mediaUs --(clockSegments)--> gameMs
 *
 * 任意坐标都可单独持久化/展示，转换必须经过显式映射并声明所用版本。
 */
const store = require('./store');

const US_PER_MS = 1000n;

function bi(v) { return typeof v === 'bigint' ? v : BigInt(v); }

/* ---------------- VFR：帧号 <-> 素材 PTS(微秒) ---------------- */

/**
 * VFR 模型（按素材版本生成，确定性可复现）：
 *   base = 1e6/fps
 *   p(f) = f*base + base*amp*period/(2π) * (1 - cos(2π f / period))
 * 帧间隔 base*(1 + amp*sin(…)) 在 base*(1±amp) 间周期变化（永远为正、单调）；
 * 整数个周期后偏移归零，故素材总时长严格 = frameCount/fps，平均帧率等于标称帧率，
 * 但任何局部位置都不能用“帧号 × 常数”反推 PTS。
 * 另在 vfrDropFrames 列出的帧号后插入空洞（模拟直播断流造成的 PTS 跳跃）。
 */
function framePtsUs(mv, frame) {
  const fps = mv.fpsNominal || 30;
  const amp = mv.vfrAmp ?? 0.12;
  const period = mv.vfrPeriod || 12;
  const base = 1e6 / fps;
  let p = Math.round(
    frame * base + base * amp * period / (2 * Math.PI) * (1 - Math.cos((2 * Math.PI * frame) / period))
  );
  for (const f of mv.vfrDropFrames || []) if (frame > f) p += mv.vfrDropUs || 400000;
  return p;
}

/** 给定素材版本的持续时长（由 frameCount 决定） */
function durationUs(mv) { return framePtsUs(mv, mv.frameCount); }

/** 帧号 -> 该帧呈现 PTS（微秒） */
function frameToMedia(mv, frame) {
  if (frame < 0 || frame > mv.frameCount) {
    return { ok: false, reason: 'frame_out_of_range', frame, frameCount: mv.frameCount };
  }
  return { ok: true, ptsUs: framePtsUs(mv, frame), frame };
}

/** 素材 PTS(微秒) -> 帧位置（返回最近帧及误差；绝不四舍五入成“精确秒数”） */
function mediaToFrame(mv, ptsUs) {
  if (ptsUs < 0 || ptsUs > durationUs(mv)) {
    return { ok: false, reason: 'pts_out_of_range', ptsUs, durationUs: durationUs(mv) };
  }
  let lo = 0, hi = mv.frameCount;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (framePtsUs(mv, mid) <= ptsUs) lo = mid; else hi = mid - 1;
  }
  const f = lo;
  const ptsF = framePtsUs(mv, f);
  const ptsN = f < mv.frameCount ? framePtsUs(mv, f + 1) : ptsF;
  return {
    ok: true, frame: f,
    ptsUs: ptsF,
    nextPtsUs: ptsN,
    snapErrorUs: ptsUs - ptsF,          // 正数：请求位置落后于最近帧多少
    frameDurationUs: ptsN - ptsF,
  };
}

/* ---------------- 时间轴版本：mediaUs <-> 素材片段 ---------------- */

function segmentsOf(tvId) {
  return store.find('segments', s => s.timelineVersionId === tvId)
    .sort((a, b) => a.tlStartUs - b.tlStartUs);
}

/** 找到覆盖时间轴 mediaUs 的段（空洞段 kind=gap 也参与） */
function findSegment(segs, mediaUs) {
  for (const s of segs) {
    if (mediaUs >= s.tlStartUs && mediaUs < s.tlStartUs + s.durationUs) return s;
  }
  const last = segs[segs.length - 1];
  if (last && mediaUs === last.tlStartUs + last.durationUs) return last;
  return null;
}

/**
 * 时间轴坐标 -> 素材坐标。
 * 返回素材版本 id、源内 PTS、帧（若为 gap 则 isGap）。
 */
function tlToMaterial(tvId, mediaUs) {
  const tv = store.get('timelineVersions', tvId);
  if (!tv) return { ok: false, reason: 'unknown_timeline_version' };
  const seg = findSegment(segmentsOf(tvId), mediaUs);
  if (!seg) return { ok: false, reason: 'outside_timeline', mediaUs };
  const offset = mediaUs - seg.tlStartUs;
  if (seg.kind === 'gap') {
    return {
      ok: true, isGap: true, segment: seg, timelineVersionId: tvId,
      gapKind: seg.gapKind || 'unknown', mediaUs,
    };
  }
  const mv = store.get('materialVersions', seg.materialVersionId);
  const srcPts = seg.srcStartUs + offset;
  const fr = mediaToFrame(mv, srcPts);
  return {
    ok: fr.ok, ...fr,
    segment: seg, materialVersionId: mv.id, materialId: mv.materialId,
    timelineVersionId: tvId, srcPtsUs: srcPts, mediaUs,
    reason: fr.ok ? undefined : fr.reason,
  };
}

/** 素材（指定版本）内 PTS -> 该时间轴版本的 mediaUs；可落在多个段（替换重排时） */
function materialToTl(tvId, materialVersionId, srcPtsUs) {
  const hits = [];
  for (const s of segmentsOf(tvId)) {
    if (s.kind === 'gap' || s.materialVersionId !== materialVersionId) continue;
    if (srcPtsUs >= s.srcStartUs && srcPtsUs < s.srcStartUs + s.durationUs) {
      hits.push({ mediaUs: s.tlStartUs + (srcPtsUs - s.srcStartUs), segment: s });
    }
  }
  return hits;
}

/* ---------------- 比赛计时：mediaUs <-> gameMs ---------------- */

function clockSegmentsOf(tvId) {
  return store.find('clockSegments', c => c.timelineVersionId === tvId)
    .sort((a, b) => a.tlStartUs - b.tlStartUs);
}

function mediaToGame(tvId, mediaUs) {
  // 边界规则：clock 段可能不覆盖广告/冻结区（如 v1 的 10–15′），
  // 恰好落在某段终点时回退到该段；整体结束点回退到最后一段。
  const arr = clockSegmentsOf(tvId);
  let cs = arr.find(c => mediaUs >= c.tlStartUs && mediaUs < c.tlEndUs);
  if (!cs) cs = arr.find(c => mediaUs === c.tlEndUs);
  if (!cs) return { ok: false, reason: 'no_clock_segment' };
  const spanUs = BigInt(cs.tlEndUs - cs.tlStartUs);
  const spanMs = BigInt(cs.gameEndMs - cs.gameStartMs);
  const frac = spanUs === 0n ? 0n : BigInt(mediaUs - cs.tlStartUs) * spanMs / spanUs;
  return {
    ok: true, clockSegmentId: cs.id,
    gameMs: cs.gameStartMs + Number(frac),
    running: cs.running, period: cs.period,
  };
}

function gameToMedia(tvId, gameMs) {
  const hits = [];
  for (const cs of clockSegmentsOf(tvId)) {
    if (gameMs >= cs.gameStartMs && gameMs < cs.gameEndMs) {
      const spanUs = BigInt(cs.tlEndUs - cs.tlStartUs);
      const spanMs = BigInt(cs.gameEndMs - cs.gameStartMs);
      const frac = spanMs === 0n ? 0n : BigInt(gameMs - cs.gameStartMs) * spanUs / spanMs;
      hits.push({ mediaUs: cs.tlStartUs + Number(frac), clockSegment: cs });
    }
  }
  return hits;
}

/* ---------------- 直播式镜头（比赛计时锚点）在指定时间轴版本上重定位 ---------------- */

function gapReason(seg) {
  if (seg.gapKind === 'ad') return 'crosses_advertisement';
  if (seg.gapKind === 'rights') return 'crosses_rights_gap';
  if (seg.gapKind === 'break') return 'crosses_stream_break';
  return 'crosses_gap';
}

/**
 * 解析镜头区间到 pieces（连续可裁的素材段）。
 * 输入是比赛计时区间 [gameInMs, gameOutMs] + 时间轴版本。
 * 步骤：gameMs→（可能多个）mediaUs 区间 → 逐微秒分界切分 → 每片映射到素材帧。
 */
function resolveLiveClip(clip, tvId) {
  const inHits = gameToMedia(tvId, clip.gameInMs);
  const outHits = gameToMedia(tvId, clip.gameOutMs);
  const warnings = [];

  if (inHits.length > 1 || outHits.length > 1) {
    return {
      ok: false, status: 'conflict', clipId: clip.id, timelineVersionId: tvId,
      conflictType: 'ambiguous_clock_mapping',
      reason: '同一比赛计时在该版本中映射到多个媒体位置（后补素材重叠期），需要人工选择重定位目标',
      candidates: { gameIn: inHits, gameOut: outHits },
      pieces: [],
    };
  }
  if (inHits.length === 0 || outHits.length === 0) {
    return {
      ok: false, status: 'conflict', clipId: clip.id, timelineVersionId: tvId,
      conflictType: 'clock_unmapped',
      reason: `比赛计时区间在该版本无对应媒体（${inHits.length === 0 ? '入点' : '出点'}失联）`,
      pieces: [],
    };
  }

  let a = inHits[0].mediaUs;
  let b = outHits[0].mediaUs;
  if (b < a) [a, b] = [b, a];

  // 收集区间内的段边界
  const segs = segmentsOf(tvId);
  const cuts = new Set([a, b]);
  for (const s of segs) {
    const sEnd = s.tlStartUs + s.durationUs;
    if (s.tlStartUs > a && s.tlStartUs < b) cuts.add(s.tlStartUs);
    if (sEnd > a && sEnd < b) cuts.add(sEnd);
  }
  const bounds = [...cuts].sort((x, y) => x - y);

  const pieces = [];
  const gapPieces = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const pStart = bounds[i], pEnd = bounds[i + 1];
    const seg = findSegment(segs, pStart + (pEnd > pStart ? 1 : 0)) || findSegment(segs, pStart);
    if (!seg) continue;
    const clockIn = mediaToGame(tvId, pStart);
    const clockOut = mediaToGame(tvId, pEnd);
    if (seg.kind === 'gap') {
      gapPieces.push({
        timelineStartUs: pStart, timelineEndUs: pEnd, durationUs: pEnd - pStart,
        gameInMs: clockIn.gameMs, gameOutMs: clockOut.gameMs, gapKind: seg.gapKind,
      });
      warnings.push({ code: gapReason(seg), gapKind: seg.gapKind, startUs: pStart, endUs: pEnd });
      continue;
    }
    const mv = store.get('materialVersions', seg.materialVersionId);
    const inMap = mediaToFrame(mv, seg.srcStartUs + (pStart - seg.tlStartUs));
    const outMap = mediaToFrame(mv, seg.srcStartUs + (pEnd - seg.tlStartUs));
    if (!inMap.ok || !outMap.ok) {
      return { ok: false, status: 'conflict', conflictType: 'frame_mapping_failed', pieces: [] };
    }
    pieces.push({
      kind: 'program',
      materialId: mv.materialId,
      materialVersionId: mv.id,
      segmentId: seg.id,
      timelineStartUs: pStart,
      timelineEndUs: pEnd,
      srcPtsInUs: inMap.ptsUs,
      srcPtsOutUs: outMap.ptsUs,
      frameIn: inMap.frame,
      frameOut: outMap.frame,
      inSnapErrorUs: inMap.snapErrorUs,
      outSnapErrorUs: outMap.snapErrorUs,
      fpsNominal: mv.fpsNominal,
      vfr: !!(mv.vfrAmp && mv.vfrAmp > 0) || (mv.vfrDropFrames || []).length > 0,
      fileAvailable: mv.fileAvailable,
      fileUri: mv.fileUri,
      fileSha256: mv.fileSha256,
      gameInMs: clockIn.gameMs, gameOutMs: clockOut.gameMs,
    });
  }

  // 许可
  const licensing = evaluateLicensing(clip, pieces);
  const titles = attachedTitles(clip.id);
  const allTitlesApproved = titles.every(t => t.status === 'approved');

  let status = 'ok';
  const blockers = [];
  if (pieces.length === 0) { status = 'conflict'; blockers.push('no_program_material'); }
  if (gapPieces.length) blockers.push('contains_gap');
  if (pieces.some(p => !p.fileAvailable)) blockers.push('broken_media_link');
  if (!licensing.fullyLicensed) blockers.push('license_gap');
  if (!allTitlesApproved) blockers.push('unapproved_titles');

  if (blockers.length) status = 'conflict';

  return {
    ok: status === 'ok', status, clipId: clip.id, timelineVersionId: tvId,
    gameInMs: clip.gameInMs, gameOutMs: clip.gameOutMs,
    pieces, gapPieces, warnings, blockers,
    licensing, titles: titles.map(t => ({ id: t.id, text: t.text, status: t.status, kind: t.kind })),
  };
}

/* ---------------- 固定源镜头（绑定素材版本+帧，不随时间轴漂移） ---------------- */

function resolveFixedClip(clip, tvId) {
  const mv = store.get('materialVersions', clip.materialVersionId);
  if (!mv) return { ok: false, status: 'conflict', conflictType: 'missing_material_version', pieces: [] };
  const inMap = mediaToFrame(mv, clip.srcPtsInUs);
  const outMap = mediaToFrame(mv, clip.srcPtsOutUs);
  const pieces = [];
  const blockers = [];
  // 固定镜头在“当前时间轴版本”上的引用位置（仅为引用坐标，绑定仍是素材版本+帧）
  const refsIn = materialToTl(tvId, mv.id, clip.srcPtsInUs);
  const refsOut = materialToTl(tvId, mv.id, clip.srcPtsOutUs);
  const refIn = refsIn[0] ? refsIn[0].mediaUs : null;
  const refOut = refsOut[0] ? refsOut[0].mediaUs : null;
  const gameIn = refIn != null ? mediaToGame(tvId, refIn) : null;
  const gameOut = refOut != null ? mediaToGame(tvId, refOut) : null;
  if (inMap.ok && outMap.ok) {
    pieces.push({
      kind: 'program', materialId: mv.materialId, materialVersionId: mv.id,
      srcPtsInUs: inMap.ptsUs, srcPtsOutUs: outMap.ptsUs,
      frameIn: inMap.frame, frameOut: outMap.frame,
      inSnapErrorUs: inMap.snapErrorUs, outSnapErrorUs: outMap.snapErrorUs,
      fpsNominal: mv.fpsNominal,
      vfr: !!(mv.vfrAmp && mv.vfrAmp > 0) || (mv.vfrDropFrames || []).length > 0,
      fileAvailable: mv.fileAvailable, fileUri: mv.fileUri, fileSha256: mv.fileSha256,
      timelineStartUs: refIn, timelineEndUs: refOut,
      gameInMs: gameIn && gameIn.ok ? gameIn.gameMs : null,
      gameOutMs: gameOut && gameOut.ok ? gameOut.gameMs : null,
      fixed: true,
    });
  } else blockers.push('frame_mapping_failed');

  // 全部引用（后补/重排后同一源位置可能在时间轴上出现多次）
  const refs = refsIn;
  const refClock = refs[0] ? mediaToGame(tvId, refs[0].mediaUs) : null;

  if (!mv.fileAvailable) blockers.push('broken_media_link');
  const licensing = evaluateLicensing(clip, pieces);
  if (!licensing.fullyLicensed) blockers.push('license_gap');
  const titles = attachedTitles(clip.id);
  if (!titles.every(t => t.status === 'approved')) blockers.push('unapproved_titles');

  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'conflict' : 'ok',
    clipId: clip.id, timelineVersionId: tvId,
    fixed: true, pieces, blockers, licensing,
    liveTimelineRefs: refs.map(r => ({ mediaUs: r.mediaUs, gameMs: refClock ? refClock.gameMs : null })),
    titles: titles.map(t => ({ id: t.id, text: t.text, status: t.status, kind: t.kind })),
  };
}

function resolveClip(clip, tvId) {
  return clip.binding === 'fixed' ? resolveFixedClip(clip, tvId) : resolveLiveClip(clip, tvId);
}

/** 比较镜头在两个时间轴版本上的解析结果（后补素材影响分析） */
function diffResolutions(clip, fromTvId, toTvId) {
  const a = resolveClip(clip, fromTvId);
  const b = resolveClip(clip, toTvId);
  const sig = r => (r.pieces || []).map(p => `${p.materialVersionId}@${p.frameIn}-${p.frameOut}`).join('|');
  const moved = sig(a) !== sig(b);
  let effect;
  if (!moved && a.status === b.status) effect = 'unchanged';
  else if (b.status === 'conflict' && b.conflictType === 'ambiguous_clock_mapping') effect = 'conflict_needs_choice';
  else if (b.status === 'conflict') effect = 'conflict';
  else if (moved) effect = 'relocated';
  else effect = 'status_only';
  return {
    clipId: clip.id, binding: clip.binding, effect,
    from: { timelineVersionId: fromTvId, status: a.status, pieces: a.pieces, blockers: a.blockers },
    to: { timelineVersionId: toTvId, status: b.status, pieces: b.pieces, blockers: b.blockers, conflictType: b.conflictType, reason: b.reason, candidates: b.candidates },
  };
}

/* ---------------- 许可 ---------------- */

function evaluateLicensing(clip, pieces) {
  const now = Date.now();
  const grants = store.find('grants', g => !g.deleted && g.status === 'active');
  const checked = [];
  let fullyLicensed = pieces.length > 0;
  for (const p of pieces) {
    let cover = null;
    for (const g of grants) {
      if (g.materialId !== p.materialId) continue;
      if (g.validFrom && now < Date.parse(g.validFrom)) continue;
      if (g.validUntil && now > Date.parse(g.validUntil)) continue;
      const gIn = g.frameIn == null ? 0 : g.frameIn;
      const gOut = g.frameOut == null ? Infinity : g.frameOut;
      const gMv = g.materialVersionId;
      if (gMv && gMv !== p.materialVersionId) continue;
      if (p.frameIn >= gIn && p.frameOut <= gOut) { cover = g; break; }
    }
    if (!cover) fullyLicensed = false;
    checked.push({
      materialVersionId: p.materialVersionId, frameIn: p.frameIn, frameOut: p.frameOut,
      licensed: !!cover, grantId: cover ? cover.id : null,
      territory: cover ? cover.territory : null, terms: cover ? cover.terms : null,
    });
  }
  return {
    fullyLicensed,
    pieces: checked,
    note: fullyLicensed ? undefined : '许可只覆盖部分时段/素材版本：整镜不得导出，或需拆条后仅导出已覆盖部分',
  };
}

/* ---------------- 标题 ---------------- */

function attachedTitles(clipId) {
  return store.find('titles', t => t.clipId === clipId && !t.deleted);
}

module.exports = {
  framePtsUs, durationUs, frameToMedia, mediaToFrame,
  segmentsOf, findSegment, tlToMaterial, materialToTl,
  mediaToGame, gameToMedia, clockSegmentsOf,
  resolveLiveClip, resolveFixedClip, resolveClip, diffResolutions,
  evaluateLicensing, attachedTitles,
};
