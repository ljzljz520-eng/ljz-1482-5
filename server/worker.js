'use strict';
/**
 * 工作器：把裁切作业输出为剪辑师实际任务包（manifest.json + README）。
 *
 * 铁律：
 *  - 任务包含入点/出点的帧号、素材身份(materialId)、素材版本(materialVersionId)、
 *    源 PTS、时间轴版本、文件 sha256、断口/许可/标题信息——全部可复现；
 *  - 绝不输出“一组临时播放地址”（fileUri 仅为归档相对路径，非签名 URL）；
 *  - 镜头已删除：作业命中墓碑，写 tombstone 包，不裁任何素材；
 *  - 有阻塞（冲突/断链/许可缺口/未批准文案）：写 blocked 包并列出每个阻塞原因，供策划处理；
 *  - 断流点/缺口：piece 之间显式给出 gap，剪辑师按提示补料，不得静默拼接。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const tm = require('./time_model');

function latestScore(matchId, gameMs) {
  return store.find('scoreStates', s => !s.superseded && s.gameMs <= gameMs)
    .sort((a, b) => b.gameMs - a.gameMs)[0] || null;
}

function buildPackage(job) {
  const clip = store.get('clips', job.clipId);
  const tvId = job.timelineVersionId
    || store.one('matches', () => true).currentTimelineVersionId;
  const tv = store.get('timelineVersions', tvId);
  const pkgDir = path.join(store.DATA_DIR, 'packages', job.id);
  fs.mkdirSync(pkgDir, { recursive: true });

  const base = {
    schema: 'cut-task-package/v1',
    packageId: null,
    jobId: job.id,
    clipId: job && clip ? clip.id : job.clipId,
    clipName: clip ? clip.name : null,
    reelId: clip ? clip.reelId : null,
    position: clip ? clip.position : null,
    createdAt: new Date().toISOString(),
    storeRev: store.load().rev,
    binding: clip ? clip.binding : null,
    timelineVersion: tv ? { id: tv.id, version: tv.version, label: tv.label, kind: tv.kind } : null,
    reproducibility: {
      coordinates: ['frame(materialVersion)', 'srcPtsUs(materialVersion)', 'mediaUs(timelineVersion)', 'gameMs(clockSegment)'],
      note: '四个坐标分别存证；任何转换均经版本化映射。禁止用单一秒数互通。',
      frameModel: {
        ptsRule: 'framePtsUs(frame) = f*base + base*amp*period/2π*(1-cos(2πf/period)) (+dropUs per vfrDropFrames)',
        snap: '出点/入点附带 snapErrorUs，表示请求位置相对最近帧的偏差',
      },
    },
  };

  let manifest;
  if (!clip || clip.deleted) {
    manifest = {
      ...base,
      status: 'tombstone',
      reason: 'clip_deleted_before_processing',
      deletedReason: clip ? clip.deletedReason : null,
      deletedAt: clip ? new Date(clip.deletedAt).toISOString() : null,
      instruction: '该作业指向的镜头在作业完成前已被删除（完成晚于删除）。不要裁切、不要生成临时播放地址。',
    };
  } else {
    const res = tm.resolveClip(clip, tvId);
    const score = latestScore(store.one('matches', () => true).id, clip.anchorGameMs || clip.gameInMs || 0);
    const exportable = res.status === 'ok';
    manifest = {
      ...base,
      status: exportable ? 'ready' : 'blocked',
      blockers: exportable ? [] : res.blockers,
      conflict: res.conflictType ? { type: res.conflictType, reason: res.reason, candidates: res.candidates } : undefined,
      gameWindow: clip.binding === 'fixed' ? undefined : { gameInMs: clip.gameInMs, gameOutMs: clip.gameOutMs },
      scoreAtIn: score ? { home: score.home, away: score.away, source: score.source } : null,
      pieces: (res.pieces || []).map(p => ({
        role: p.fixed ? 'fixed_source' : 'program',
        materialId: p.materialId,
        materialVersionId: p.materialVersionId,
        fileUri: p.fileUri,                      // 归档相对路径，非临时 URL
        fileSha256: p.fileSha256,
        in: { frame: p.frameIn, srcPtsUs: p.srcPtsInUs, snapErrorUs: p.inSnapErrorUs,
              timelineMediaUs: p.timelineStartUs, gameMs: p.gameInMs },
        out: { frame: p.frameOut, srcPtsUs: p.srcPtsOutUs, snapErrorUs: p.outSnapErrorUs,
               timelineMediaUs: p.timelineEndUs, gameMs: p.gameOutMs },
        fpsNominal: p.fpsNominal, vfr: p.vfr,
        fileAvailable: p.fileAvailable,
      })),
      gaps: (res.gapPieces || []).map(g => ({
        kind: g.gapKind, timelineStartUs: g.timelineStartUs, timelineEndUs: g.timelineEndUs,
        durationUs: g.durationUs, gameInMs: g.gameInMs, gameOutMs: g.gameOutMs,
        instruction: g.gapKind === 'ad' ? '原始直播此处为广告；生产版以 B-roll 回放替换，按 pieces 拼接，禁止重新拼入广告'
          : g.gapKind === 'rights' ? '权利缺口：无可用节目画面，保留黑屏/图文占位，等待素材补入后重定位'
          : '断流缺口：按时间轴版本声明衔接',
      })),
      licensing: res.licensing,
      titles: (res.titles || []).map(t => ({ id: t.id, kind: t.kind, text: t.status === 'approved' ? t.text : null,
        status: t.status, includeInExport: t.status === 'approved',
        blockedReason: t.status === 'approved' ? null : `标题${t.status === 'review_required' ? '复核中' : '未批准'}，禁止混入导出` })),
      warnings: res.warnings,
      export: {
        mayRender: exportable,
        rules: [
          '仅可使用 approved 标题文案',
          '许可未覆盖的 piece 必须剔除或换料后重解析',
          '按 pieces 顺序与帧点生成 EDL；gap 不得静默跨越',
          '以 materialId+materialVersionId+frameIn/frameOut+sha256 复现，不接受临时播放地址',
        ],
      },
    };
  }

  manifest.packageId = crypto.createHash('sha1').update(JSON.stringify(manifest)).digest('hex').slice(0, 12);
  const json = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), json);
  fs.writeFileSync(path.join(pkgDir, 'README.txt'), renderReadme(manifest));
  return { manifest, pkgDir, json };
}

function fmtUs(us) { return (us / 1e6).toFixed(3) + 's'; }
function fmtGame(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${m}′${String(s).padStart(2, '0')}″`;
}

function renderReadme(m) {
  const L = [];
  L.push(`剪辑任务包 ${m.packageId}`);
  L.push(`镜头: ${m.clipName || m.clipId}（${m.binding === 'fixed' ? '固定源绑定' : '直播计时锚点'}）`);
  L.push(`时间轴版本: ${m.timelineVersion ? m.timelineVersion.version + ' - ' + m.timelineVersion.label : 'N/A'}`);
  L.push(`状态: ${m.status}${m.status === 'blocked' ? '（阻塞，禁止出片）' : m.status === 'tombstone' ? '（墓碑，停止处理）' : ''}`);
  if (m.blockers && m.blockers.length) L.push(`阻塞项: ${m.blockers.join(', ')}`);
  if (m.conflict) L.push(`冲突: [${m.conflict.type}] ${m.conflict.reason}`);
  L.push('');
  if (m.gameWindow) L.push(`比赛计时窗口: ${fmtGame(m.gameWindow.gameInMs)} – ${fmtGame(m.gameWindow.gameOutMs)}`);
  (m.pieces || []).forEach((p, i) => {
    L.push(`片段 ${i + 1}: 素材 ${p.materialId} / 版本 ${p.materialVersionId}`);
    L.push(`  入点 帧 ${p.in.frame}  PTS ${fmtUs(p.in.srcPtsUs)}  比赛 ${p.in.gameMs != null ? fmtGame(p.in.gameMs) : '-'}`);
    L.push(`  出点 帧 ${p.out.frame}  PTS ${fmtUs(p.out.srcPtsUs)}  比赛 ${p.out.gameMs != null ? fmtGame(p.out.gameMs) : '-'}`);
    L.push(`  文件 ${p.fileUri}  sha256=${p.fileSha256 ? p.fileSha256.slice(0, 16) + '…' : 'N/A'}  ${p.fileAvailable ? '在档' : '!! 文件失联 !!'}`);
    L.push(`  VFR=${p.vfr} 标称帧率=${p.fpsNominal}`);
  });
  (m.gaps || []).forEach(g => {
    L.push(`缺口 [${g.kind}] ${fmtUs(g.timelineStartUs)}–${fmtUs(g.timelineEndUs)}（比赛 ${fmtGame(g.gameInMs)}–${fmtGame(g.gameOutMs)}）: ${g.instruction}`);
  });
  if (m.licensing) L.push(`许可: ${m.licensing.fullyLicensed ? '全覆盖' : '存在未覆盖段 — 禁止整镜导出'}`);
  (m.titles || []).forEach(t => {
    L.push(`标题[${t.status}] ${t.includeInExport ? t.text : '（不导出：' + t.blockedReason + '）'}`);
  });
  return L.join('\n') + '\n';
}

function claimJob() {
  const job = store.one('jobs', j => j.status === 'queued');
  if (!job) return null;
  store.update('jobs', job.id, { status: 'running', startedAt: Date.now() });
  return store.get('jobs', job.id);
}

function processOne(jobId) {
  const job = jobId ? store.get('jobs', jobId) : claimJob();
  if (!job) return null;
  let result;
  try {
    result = buildPackage(job);
    const pkgRow = store.insert('packages', {
      jobId: job.id, clipId: job.clipId, dir: 'packages/' + job.id,
      status: result.manifest.status, packageId: result.manifest.packageId,
      blockers: result.manifest.blockers || [], createdAt: Date.now(),
    });
    store.update('jobs', job.id, {
      status: result.manifest.status === 'tombstone' ? 'tombstoned' : (result.manifest.status === 'ready' ? 'done' : 'blocked'),
      packageId: pkgRow.id, finishedAt: Date.now(),
    });
    return { job: store.get('jobs', job.id), package: pkgRow, manifest: result.manifest };
  } catch (e) {
    store.update('jobs', job.id, { status: 'failed', error: String(e && e.message || e), finishedAt: Date.now() });
    throw e;
  }
}

async function watch(intervalMs = 700) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const queued = store.find('jobs', j => j.status === 'queued').length;
    for (let i = 0; i < queued; i++) {
      const r = processOne();
      if (!r) break;
      console.log(`[worker] ${r.job.id} -> ${r.manifest.status} pkg=${r.package.id}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

if (require.main === module) {
  if (process.argv.includes('--watch')) {
    watch();
  } else {
    let n = 0;
    while (processOne()) n++;
    console.log(`processed ${n} job(s)`);
  }
}

module.exports = { buildPackage, processOne, watch };
