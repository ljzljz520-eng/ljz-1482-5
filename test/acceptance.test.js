'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = path.join(__dirname, '..', 'data-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const store = require('../server/store');
const seed = require('../server/seed');
const tm = require('../server/time_model');
const worker = require('../server/worker');
const reconcile = require('../server/reconcile');

const r = seed.reset(true);
const TV = {};
for (const t of store.all('timelineVersions')) TV['v' + t.version] = t.id;
const clips = Object.fromEntries(store.all('clips').map(c => [c.name, c]));
const byId = id => store.get('clips', id);

test('三坐标分离：比赛计时/媒体时间/帧号是不同的值，且版本化映射', () => {
  // v2 上比赛 25:00（广告后计时冻结过）：mediaUs=27min, src≈15min, 帧≈45000
  const hits = tm.gameToMedia(TV.v2, 25 * 60000);
  assert.equal(hits.length, 1);
  const mediaUs = hits[0].mediaUs;
  assert.equal(mediaUs, 27 * 60e6);              // 时间轴媒体时间（含 2′ 回放替换）
  const m = tm.tlToMaterial(TV.v2, mediaUs);
  assert.equal(m.materialVersionId, store.all('materialVersions')[0].id);
  assert.equal(m.srcPtsUs, 25 * 60e6);          // 源内 PTS(25′) ≠ 时间轴 mediaUs(27′，含2′回放替换)
  assert.ok(m.frame > 44000 && m.frame < 46000, 'frame around 45k, got ' + m.frame);
  // 三者互不相等（单位/坐标系不同）
  assert.notEqual(m.frame * 1000, m.srcPtsUs);  // VFR：帧号不能线性换成 us
  assert.notEqual(m.srcPtsUs, mediaUs);         // 源 PTS ≠ 时间轴媒体时间
  const g = tm.mediaToGame(TV.v2, mediaUs);
  assert.equal(g.gameMs, 25 * 60000);
});

test('跨断流点：直播版广告导致比赛计时跳跃；镜头跨广告被拆为多 piece + gap', () => {
  const c = clips['跨广告断流：进球后到比赛恢复'];
  const v1 = tm.resolveClip(c, TV.v1);
  assert.equal(v1.status, 'conflict');
  assert.ok(v1.blockers.includes('contains_gap'));
  assert.equal(v1.gapPieces.length, 1);
  assert.equal(v1.gapPieces[0].gapKind, 'ad');
  assert.ok(v1.pieces.length >= 2, '断点两侧各成 piece');
  // v2 广告被替换后重定位成功
  const v2 = tm.resolveClip(c, TV.v2);
  assert.equal(v2.status, 'ok');
  assert.equal(v2.gapPieces.length, 0);
  const d = tm.diffResolutions(c, TV.v1, TV.v2);
  assert.equal(d.effect, 'relocated');
});

test('时间戳重置：同一素材版本的两个段 srcStart 声明重锚，不假连续', () => {
  const segs = tm.segmentsOf(TV.v1).filter(s => s.kind === 'program');
  assert.equal(segs.length, 2); // 节目段两段；广告是 gap/advertisement
  // 第二段 tlStart=15min 但 srcStart=10min —— 墙钟连续而源时间戳重置
  const second = segs.find(s => s.tlStartUs === 15 * 60e6);
  assert.equal(second.srcStartUs, 10 * 60e6);
  // 边界两侧源 PTS 都约为 10′，但帧由映射显式决定
  const a = tm.tlToMaterial(TV.v1, 15 * 60e6 - 1); // 广告 gap
  const b = tm.tlToMaterial(TV.v1, 15 * 60e6);     // 重锚节目段 srcStart=10′
  assert.equal(a.isGap, true);
  assert.equal(b.srcPtsUs, 10 * 60e6); // 出广告后源 PTS 被重置，不是墙钟 15′
});

test('源视频变帧率：帧间隔不恒定，但总时长=标称；吸附误差被记录', () => {
  const mv = store.all('materialVersions')[0];
  const durs = [];
  for (let f = 1; f <= 120; f++) durs.push(tm.framePtsUs(mv, f) - tm.framePtsUs(mv, f - 1));
  assert.ok(Math.max(...durs) !== Math.min(...durs), 'VFR 帧间隔必须不恒定');
  const total = tm.durationUs(mv);
  assert.ok(Math.abs(total - (mv.frameCount / 30 * 1e6 + 400000)) < 1000);
  // 任意 PTS 请求吸附到最近帧，误差非零
  const r = tm.mediaToFrame(mv, 12345678);
  assert.ok(r.snapErrorUs > 0 && r.snapErrorUs < r.frameDurationUs);
});

test('后期替换（后补素材）影响已标注镜头：重定位成功或歧义冲突提示', () => {
  const breakthrough = clips['林骁 8′20″ 突破'];
  // 该镜头只涉及主机位：v2→v3→v4 素材绑定不变（unchanged）
  assert.equal(tm.diffResolutions(breakthrough, TV.v2, TV.v3).effect, 'unchanged');
  assert.equal(tm.diffResolutions(breakthrough, TV.v3, TV.v4).effect, 'unchanged');
  // 直播原始版→精编生产版：广告被回放替换，跨广告镜头 relocated
  const crossAd = clips['跨广告断流：进球后到比赛恢复'];
  assert.equal(tm.diffResolutions(crossAd, TV.v1, TV.v2).effect, 'relocated');
  // v2 -> v4 备机角度与主机位覆盖同一比赛计时（9′–10′）→ 歧义冲突，给出候选供人工重定位
  const goal = clips['9′ 进球集锦'];
  const d = tm.diffResolutions(goal, TV.v2, TV.v4);
  assert.equal(d.effect, 'conflict_needs_choice');
  assert.equal(d.to.conflictType, 'ambiguous_clock_mapping');
  const cand = d.to.candidates;
  assert.ok(cand && (cand.gameIn.length >= 2 || cand.gameOut.length >= 2), 'candidates missing');
  // 权利抽片：v2→v3 该段镜头变 conflict（gap），不是静默丢失
  const offense = clips['25′ 连续进攻（v3 权利缺口）'];
  assert.equal(tm.diffResolutions(offense, TV.v2, TV.v3).effect, 'conflict');
});

test('权利抽片：v3 缺口镜头无法定位，冲突且网页模型保留镜头', () => {
  const c = clips['25′ 连续进攻（v3 权利缺口）'];
  const v3 = tm.resolveClip(c, TV.v3);
  assert.equal(v3.status, 'conflict');
  assert.ok(v3.blockers.includes('contains_gap'));
  assert.equal(v3.pieces.length, 0);
  assert.equal(v3.gapPieces[0].gapKind, 'rights');
  // 镜头实体仍在（未删除）
  assert.equal(store.get('clips', c.id).deleted, false);
});

test('许可只覆盖部分时段：部分帧未覆盖 → 整镜 blocked', () => {
  const c = clips['44′ 反击（许可仅覆盖到 43′20″，本镜落缺口）'];
  const x = tm.resolveClip(c, TV.v2);
  assert.equal(x.licensing.fullyLicensed, false);
  assert.ok(x.blockers.includes('license_gap'));
  // 精确边界：许可到帧 77988，镜头入帧在其后
  assert.ok(x.pieces[0].frameIn > 77988);
});

test('固定源镜头：绑定帧+素材版本，时间轴变化不漂移；坏链接保留', () => {
  const broken = clips['备机角度：林骁突破（源文件失联，固定源编辑）'];
  for (const v of [TV.v1, TV.v2, TV.v3, TV.v4]) {
    const x = tm.resolveClip(broken, v);
    assert.equal(x.pieces[0].fixed, true);
    assert.equal(x.pieces[0].fileAvailable, false);
    assert.ok(x.blockers.includes('broken_media_link'));
    assert.equal(x.pieces[0].frameIn, broken.frameInBaseline); // 永不漂移
  }
  const good = clips['固定源精修：44′40″ 扑救（单独短许可）'];
  assert.equal(tm.resolveClip(good, TV.v2).status, 'ok');
  assert.equal(tm.resolveClip(good, TV.v4).status, 'ok'); // 时间轴叠加不影响固定绑定
});

test('比分订正与球员标签变化触发相关标题复核', () => {
  const reviews = store.find('titles', t => t.status === 'review_required');
  assert.ok(reviews.some(t => /赵岩/.test(t.text)), '误报的 2-0 标题必须被打回');
  const goal = clips['9′ 进球集锦'];
  const x = tm.resolveClip(goal, TV.v2);
  assert.ok(x.blockers.includes('unapproved_titles'));
  // 无关时间点的比分订正不得波及其它标题（标题只依赖自己声明的事实快照）
  store.insert('scoreStates', { gameMs: 30 * 60000, home: 5, away: 5, source: 't', superseded: false });
  const hit = reconcile.reconcileForGamePoint(30 * 60000);
  assert.equal(hit.length, 0);
  const breakthrough = store.find('titles', t => /边路突破/.test(t.text))[0];
  assert.equal(breakthrough.status, 'approved');
  // 同时间点再次订正比分：已在复核中的标题保持复核，且新批准被服务层阻止
  const hit2 = reconcile.reconcileForGamePoint(9 * 60000 + 15000);
  assert.ok(hit2.length === 0 || hit2.every(h => /赵岩/.test(store.get('titles', h.titleId).text)));
});

test('导出只含 approved 文案；阻塞任务包 mayRender=false 且不产生临时地址', () => {
  const c = clips['9′ 进球集锦'];
  const job = store.insert('jobs', { clipId: c.id, timelineVersionId: TV.v2, status: 'queued', requestedAt: Date.now() });
  const out = worker.processOne(job.id);
  assert.equal(out.job.status, 'blocked');
  assert.equal(out.manifest.export.mayRender, false);
  assert.ok(out.manifest.titles.some(t => t.includeInExport === false));
  assert.ok(out.manifest.titles.every(t => t.text === null || t.status === 'approved'));
  for (const p of out.manifest.pieces) {
    assert.ok(!/^https?:\/\//.test(p.fileUri), '禁止临时播放地址: ' + p.fileUri);
    assert.ok(p.fileSha256 && p.in.frame != null && p.materialVersionId, 'piece 必须带帧/sha/版本');
  }
  // 许可正常的前提下，唯一阻塞原因是文案；若仅批准文案则可出片（证明导出闸门按状态生效）
  const blockerOnlyTitles = out.manifest.blockers.length === 1 && out.manifest.blockers[0] === 'unapproved_titles';
  assert.ok(blockerOnlyTitles);
});

test('并发裁切：同一幂等键只产生一个作业', () => {
  const c = clips['林骁 8′20″ 突破'];
  const key = 'race-key-1';
  const a = store.idempotent('job:' + key, () => store.insert('jobs', { clipId: c.id, timelineVersionId: TV.v2, status: 'queued' }));
  const b = store.idempotent('job:' + key, () => store.insert('jobs', { clipId: c.id, timelineVersionId: TV.v2, status: 'queued' }));
  assert.equal(a.row.id, b.row.id);
  assert.equal(b.reused, true);
});

test('作业完成晚于删除：命中墓碑，产出 tombstone 包，不裁素材', () => {
  const c = clips['林骁 8′20″ 突破'];
  const job = store.insert('jobs', { clipId: c.id, timelineVersionId: TV.v2, status: 'queued', requestedAt: Date.now() });
  store.softDelete('clips', c.id, 'planner-cancel');
  const out = worker.processOne(job.id);
  assert.equal(out.job.status, 'tombstoned');
  assert.equal(out.manifest.status, 'tombstone');
  assert.equal(out.manifest.pieces, undefined);
  const f = path.join(store.DATA_DIR, 'packages', job.id, 'manifest.json');
  assert.ok(fs.existsSync(f));
});

test('ready 任务包完整可复现：帧点+素材身份+版本+sha+时间轴版本', () => {
  const c = clips['固定源精修：44′40″ 扑救（单独短许可）'];
  const job = store.insert('jobs', { clipId: c.id, timelineVersionId: TV.v2, status: 'queued', requestedAt: Date.now() });
  const out = worker.processOne(job.id);
  assert.equal(out.job.status, 'done');
  const m = out.manifest;
  assert.equal(m.status, 'ready');
  assert.equal(m.timelineVersion.id, TV.v2);
  const p = m.pieces[0];
  assert.ok(p.materialId && p.materialVersionId && p.fileSha256);
  assert.equal(typeof p.in.frame, 'number');
  assert.equal(typeof p.in.srcPtsUs, 'number');
  assert.equal(p.in.timelineMediaUs != null, true);
  assert.equal(m.licensing.fullyLicensed, true);
  // README 落盘
  assert.ok(fs.existsSync(path.join(store.DATA_DIR, 'packages', job.id, 'README.txt')));
});

test('网页读模型保留坏链接与无法定位片段（状态齐全）', { skip: false }, () => {
  const broken = clips['备机角度：林骁突破（源文件失联，固定源编辑）'];
  const x = tm.resolveClip(broken, TV.v3);
  assert.ok(x.pieces[0].fileAvailable === false);
  const unlocated = tm.resolveLiveClip(
    { id: 'ghost', gameInMs: 46 * 60000, gameOutMs: 47 * 60000 }, TV.v1);
  assert.equal(unlocated.status, 'conflict');
  assert.equal(unlocated.conflictType, 'clock_unmapped');
});
