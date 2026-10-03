'use strict';
/**
 * 种子数据：一场 45 分钟的足球赛，四个时间轴版本覆盖全部验收场景：
 *  v1 直播原始版 —— 广告插入 + 断流后源时间戳重置
 *  v2 精编生产版 —— 广告被 B-roll 回放替换（当前生产版本）
 *  v3 权利抽片版 —— 中段节目源被权利方撤回（gap）
 *  v4 备机叠加版 —— 后期回传的备机角度与主机位覆盖同一比赛计时（映射歧义）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const tm = require('./time_model');

const MIN = 60e6;        // 微秒/分（媒体时间）
const MINm = 60 * 1000;  // 毫秒/分（比赛计时）

function materializeFile(fileUri, label, bytes = 2048) {
  const p = path.join(store.DATA_DIR, fileUri);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const buf = Buffer.alloc(bytes);
  buf.write(label.padEnd(32).slice(0, 32), 0);
  for (let i = 32; i < bytes; i++) buf[i] = (i * 73 + 17) & 0xff;
  fs.writeFileSync(p, buf);
  return { sha: crypto.createHash('sha256').update(buf).digest('hex'), bytes };
}

function reset(silent) {
  if (fs.existsSync(store.DB_FILE)) fs.rmSync(store.DB_FILE);
  fs.rmSync(path.join(store.DATA_DIR, 'packages'), { recursive: true, force: true });
  fs.mkdirSync(path.join(store.DATA_DIR, 'packages'), { recursive: true });
  fs.mkdirSync(path.join(store.DATA_DIR, 'media'), { recursive: true });
  built = false;
  store.reset();                 // 丢弃内存缓存，换成空 state
  return build(silent);
}

let built = false;
function build(silent) {
  if (built) throw new Error('seed.build 已在本进程执行过；请调用 reset()');
  const M = (us) => us;

  /* ---------------- 比赛 ---------------- */
  const match = store.insert('matches', {
    name: '城市联 vs 海湾FC', sport: 'football', halfMs: 45 * MINm,
    currentTimelineVersionId: null, createdAt: Date.now(),
  });

  /* ---------------- 素材文件（物理落盘 + sha；备机文件故意失联） ---------------- */
  const fMain = materializeFile('media/main-cam-v1.mfv', 'main-cam-v1');
  const fAd = materializeFile('media/ad-insert.mfv', 'ad-insert', 1024);
  const fB = materializeFile('media/broll-v1.mfv', 'broll-v1', 1024);
  const fAlt = materializeFile('media/alt-cam-v1.mfv', 'alt-cam-v1', 1024);
  fs.rmSync(path.join(store.DATA_DIR, 'media/alt-cam-v1.mfv')); // 模拟链接失效/未归档

  const matMain = store.insert('materials', { kind: 'program', name: '主机位 SDI 采集', sourceUri: 'sdi://enc-01/main', notes: '直播断流后源 PTS 重置，连续性由时间轴段映射声明' });
  const matAd = store.insert('materials', { kind: 'advertisement', name: '广告插播信号', sourceUri: 'sdi://ad-router' });
  const matB = store.insert('materials', { kind: 'broll', name: 'B-roll 回放包装', sourceUri: 'nas://graphics/broll' });
  const matAlt = store.insert('materials', { kind: 'program', name: '备用机位（后期回传）', sourceUri: 'https://ingest.example/alt-cam-9731', notes: '回传链接已失效，归档未完成' });

  const mvMain = store.insert('materialVersions', {
    materialId: matMain.id, version: 1, fpsNominal: 30, frameCount: 90000,
    vfrAmp: 0.12, vfrPeriod: 12, vfrDropFrames: [45000], vfrDropUs: 400000,
    fileUri: 'media/main-cam-v1.mfv', fileSha256: fMain.sha, fileBytes: fMain.bytes,
    fileAvailable: true, arrivedAfterBroadcast: false,
  });
  const mvAd = store.insert('materialVersions', {
    materialId: matAd.id, version: 1, fpsNominal: 30, frameCount: 9000,
    vfrAmp: 0, vfrPeriod: 0, vfrDropFrames: [],
    fileUri: 'media/ad-insert.mfv', fileSha256: fAd.sha, fileBytes: fAd.bytes,
    fileAvailable: true, arrivedAfterBroadcast: false,
  });
  const mvB = store.insert('materialVersions', {
    materialId: matB.id, version: 1, fpsNominal: 30, frameCount: 3600,
    vfrAmp: 0.08, vfrPeriod: 9, vfrDropFrames: [],
    fileUri: 'media/broll-v1.mfv', fileSha256: fB.sha, fileBytes: fB.bytes,
    fileAvailable: true, arrivedAfterBroadcast: false,
  });
  const mvAlt = store.insert('materialVersions', {
    materialId: matAlt.id, version: 1, fpsNominal: 30, frameCount: 1800,
    vfrAmp: 0.05, vfrPeriod: 7, vfrDropFrames: [],
    fileUri: 'media/alt-cam-v1.mfv', fileSha256: fAlt.sha, fileBytes: fAlt.bytes,
    fileAvailable: false, arrivedAfterBroadcast: true,
  });

  /* ---------------- 时间轴 ---------------- */
  const tl = store.insert('timelines', { matchId: match.id, name: '主时间轴' });
  const mkTv = (version, label, kind, notes) => store.insert('timelineVersions', {
    timelineId: tl.id, version, label, kind, notes,
    status: kind === 'live' ? 'superseded' : 'published', isProduction: false, publishedAt: Date.now(),
  });
  const tv1 = mkTv(1, '直播原始版（含广告插入；断流后源时间戳重置）', 'live');
  const tv2 = mkTv(2, '精编生产版（广告替换为 B-roll 回放）', 'post');
  const tv3 = mkTv(3, '权利抽片版（25′–31′ 节目源被撤回，形成缺口）', 'post');
  const tv4 = mkTv(4, '备机叠加版（后期回传备机角度，与主机位覆盖同一比赛计时）', 'post');

  const seg = (tvId, tlStart, dur, mv, srcStart, extra = {}) => store.insert('segments', {
    timelineVersionId: tvId, kind: 'program', tlStartUs: tlStart, durationUs: dur,
    materialVersionId: mv.id, srcStartUs: srcStart, ...extra,
  });
  const gap = (tvId, tlStart, dur, gapKind, note) => store.insert('segments', {
    timelineVersionId: tvId, kind: 'gap', tlStartUs: tlStart, durationUs: dur,
    gapKind, note,
  });
  const clk = (tvId, tlStart, tlEnd, gStart, gEnd, running, period) => store.insert('clockSegments', {
    timelineVersionId: tvId, tlStartUs: tlStart, tlEndUs: tlEnd,
    gameStartMs: gStart, gameEndMs: gEnd, running, period: period || (running ? 'P1' : 'stopped'),
  });

  /* v1：0–10′ 节目 → 10–15′ 广告 → 15–50′ 节目（源内 src 从 10′ 继续，体现重置后重锚） */
  seg(tv1.id, 0, 10 * MIN, mvMain, 0);
  // 广告信号占着媒体时间轴，但它不是节目画面：标记为 gap/advertisement（附素材身份仅供预览识别）
  store.insert('segments', {
    timelineVersionId: tv1.id, kind: 'gap', gapKind: 'ad',
    tlStartUs: 10 * MIN, durationUs: 5 * MIN,
    materialVersionId: mvAd.id, role: 'advertisement',
    note: '广告插入：节目镜头跨越此处时必须断开，不得拼接广告画面',
  });
  seg(tv1.id, 15 * MIN, 35 * MIN, mvMain, 10 * MIN, { note: '断流恢复后源 PTS 被重置为墙钟；srcStart=10′ 为重锚声明，不能假定与前段连续' });
  clk(tv1.id, 0, 10 * MIN, 0, 10 * MINm, true);
  clk(tv1.id, 15 * MIN, 50 * MIN, 10 * MINm, 45 * MINm, true); // 广告期间比赛计时不推进，出广告即跳到 10′

  /* v2：节目 0–10′ → B-roll 10–12′（比赛计时冻结） → 节目 12–47′ */
  seg(tv2.id, 0, 10 * MIN, mvMain, 0);
  seg(tv2.id, 10 * MIN, 2 * MIN, mvB, 0, { role: 'replay_package' });
  seg(tv2.id, 12 * MIN, 35 * MIN, mvMain, 10 * MIN, { replacesTimelineVersionId: tv1.id, replacesSegmentRole: 'advertisement' });
  clk(tv2.id, 0, 10 * MIN, 0, 10 * MINm, true);
  clk(tv2.id, 10 * MIN, 12 * MIN, 10 * MINm, 10 * MINm, false, 'replay');
  clk(tv2.id, 12 * MIN, 47 * MIN, 10 * MINm, 45 * MINm, true);

  /* v3：同 v2，但 25′–31′ 比赛时段源被权利方撤回 */
  seg(tv3.id, 0, 10 * MIN, mvMain, 0);
  seg(tv3.id, 10 * MIN, 2 * MIN, mvB, 0, { role: 'replay_package' });
  seg(tv3.id, 12 * MIN, 15 * MIN, mvMain, 10 * MIN);              // game 10′–25′
  gap(tv3.id, 27 * MIN, 6 * MIN, 'rights', '权利方撤回该时段主机位画面（25′–31′）');
  seg(tv3.id, 33 * MIN, 14 * MIN, mvMain, 31 * MIN);              // game 31′–45′
  clk(tv3.id, 0, 10 * MIN, 0, 10 * MINm, true);
  clk(tv3.id, 10 * MIN, 12 * MIN, 10 * MINm, 10 * MINm, false, 'replay');
  clk(tv3.id, 12 * MIN, 27 * MIN, 10 * MINm, 25 * MINm, true);
  clk(tv3.id, 27 * MIN, 33 * MIN, 25 * MINm, 31 * MINm, true, 'P1-audio-only');
  clk(tv3.id, 33 * MIN, 47 * MIN, 31 * MINm, 45 * MINm, true);

  /* v4：v2 全部内容 + 片尾追加 1′ 备机角度，重新标注为 9′–10′ 比赛计时 → 同一计时两处映射 */
  seg(tv4.id, 0, 10 * MIN, mvMain, 0);
  seg(tv4.id, 10 * MIN, 2 * MIN, mvB, 0, { role: 'replay_package' });
  seg(tv4.id, 12 * MIN, 35 * MIN, mvMain, 10 * MIN);
  seg(tv4.id, 47 * MIN, 1 * MIN, mvAlt, 0, { role: 'alternate_angle', note: '后期回传备机角度，片尾追加；其比赛计时标签与主机位 9′–10′ 重叠' });
  clk(tv4.id, 0, 10 * MIN, 0, 10 * MINm, true);
  clk(tv4.id, 10 * MIN, 12 * MIN, 10 * MINm, 10 * MINm, false, 'replay');
  clk(tv4.id, 12 * MIN, 47 * MIN, 10 * MINm, 45 * MINm, true);
  clk(tv4.id, 47 * MIN, 48 * MIN, 9 * MINm, 10 * MINm, false, 'alternate-angle');

  store.update('matches', match.id, { currentTimelineVersionId: tv2.id });

  /* ---------------- 球员与标签（带订正） ---------------- */
  const p10 = store.insert('players', { name: '林骁', number: 10, team: '城市联' });
  const p7 = store.insert('players', { name: '赵岩', number: 7, team: '城市联' });
  const p9 = store.insert('players', { name: '埃文斯', number: 9, team: '海湾FC' });

  // 原始标注（错误：把 9:15 的进球标成赵岩）
  const tagWrong = store.insert('playerTags', {
    gameMs: 9 * MINm + 15000, playerId: p7.id, label: '赵岩（7号）',
    source: 'live-logger', corrected: false, createdAt: Date.now() - 90000,
  });
  const tagFix = store.insert('playerTags', {
    gameMs: 9 * MINm + 15000, playerId: p10.id, label: '林骁（10号）',
    source: 'match-official-feed', corrected: true, supersedesTagId: tagWrong.id,
    createdAt: Date.now() - 30000,
  });
  store.update('playerTags', tagWrong.id, { supersededByTagId: tagFix.id });
  store.insert('playerTags', { gameMs: 8 * MINm + 20000, playerId: p9.id, label: '埃文斯（9号）', source: 'live-logger', corrected: false });

  /* ---------------- 比分状态（原始误报 + 订正） ---------------- */
  const s1 = store.insert('scoreStates', {
    gameMs: 9 * MINm + 15000, home: 2, away: 0, scorerTagId: tagWrong.id,
    source: 'live-logger', superseded: false, createdAt: Date.now() - 90000,
  });
  const s2 = store.insert('scoreStates', {
    gameMs: 9 * MINm + 15000, home: 1, away: 0, scorerTagId: tagFix.id,
    source: 'official', supersedesScoreId: s1.id, superseded: false,
    createdAt: Date.now() - 30000,
  });
  store.update('scoreStates', s1.id, { supersededByScoreId: s2.id, superseded: true });
  store.insert('scoreStates', { gameMs: 0, home: 0, away: 0, source: 'kickoff', superseded: false });

  /* ---------------- 事件 ---------------- */
  store.insert('events', {
    kind: 'goal', gameMs: 9 * MINm + 15000, label: '进球（直播误报：赵岩 2-0）',
    payload: { home: 2, away: 0, scorerPlayerId: p7.id, tagId: tagWrong.id },
    timelineVersionId: tv1.id, superseded: true, supersededByEvent: 'ev_fix',
  });
  store.insert('events', {
    kind: 'score_correction', gameMs: 9 * MINm + 15000, label: '比分/射手订正：林骁 1-0',
    payload: { home: 1, away: 0, scorerPlayerId: p10.id, tagId: tagFix.id, correctedScoreId: s1.id },
    timelineVersionId: tv2.id, superseded: false,
  });
  store.insert('events', { kind: 'whistle', gameMs: 25 * MINm, label: '25′ 比赛继续（v3 该画面已被权利方撤回）', payload: {}, timelineVersionId: tv2.id });
  store.insert('events', { kind: 'save', gameMs: 44 * MINm + 40000, label: '44:40 精彩扑救', payload: { playerId: p10.id }, timelineVersionId: tv2.id });

  /* ---------------- 镜头 ---------------- */
  const clip = (row, pos) => store.insert('clips', {
    reelId: 'reel_main', position: pos, binding: 'live', status: 'planned',
    createdAt: Date.now(), deleted: false, ...row,
  });
  const c1 = clip({ name: '9′ 进球集锦', gameInMs: 9 * MINm, gameOutMs: 10 * MINm }, 10);
  const c2 = clip({ name: '跨广告断流：进球后到比赛恢复', gameInMs: 9 * MINm + 30000, gameOutMs: 11 * MINm }, 20);
  const c3 = clip({ name: '25′ 连续进攻（v3 权利缺口）', gameInMs: 25 * MINm, gameOutMs: 26 * MINm }, 30);
  const c4 = clip({ name: '44′ 反击（许可仅覆盖到 43′20″，本镜落缺口）', gameInMs: 44 * MINm, gameOutMs: 44 * MINm + 30000 }, 40);
  const c5 = clip({ name: '林骁 8′20″ 突破', gameInMs: 8 * MINm + 20000, gameOutMs: 8 * MINm + 50000 }, 50);

  const fixedPts = (mv, inSec, outSec) => {
    // 固定镜头按“帧”定义（剪辑师拿到的是帧号），Pts 必须经 VFR 映射得到，而非秒数×帧率
    const fin = tm.mediaToFrame(mv, Math.round(inSec * 1e6)).frame;
    const fout = tm.mediaToFrame(mv, Math.round(outSec * 1e6)).frame;
    return {
      binding: 'fixed', name: '', reelId: 'reel_main', status: 'planned',
      materialVersionId: mv.id,
      frameInBaseline: fin, frameOutBaseline: fout,
      srcPtsInUs: tm.framePtsUs(mv, fin),
      srcPtsOutUs: tm.framePtsUs(mv, fout),
      baselineTimelineVersionId: tv2.id,
      createdAt: Date.now(), deleted: false,
    };
  };
  const c6 = store.insert('clips', { ...fixedPts(mvAlt, 10, 30), name: '备机角度：林骁突破（源文件失联，固定源编辑）', position: 60 });
  const c7 = store.insert('clips', { ...fixedPts(mvMain, 44 * MIN / 1e6 + 40, 44 * MIN / 1e6 + 55), name: '固定源精修：44′40″ 扑救（单独短许可）', position: 70 });

  /* ---------------- 标题 ---------------- */
  store.insert('titles', {
    clipId: c1.id, kind: 'lower_third', text: '赵岩 破门！比分 2-0', status: 'approved',
    anchorGameMs: 9 * MINm + 15000,
    depsSnapshot: { home: 2, away: 0, scorerLabel: '赵岩（7号）' },
    note: '依据直播误报批准；订正后将被打回复核',
  });
  store.insert('titles', {
    clipId: c1.id, kind: 'end_card', text: '半场战报 1-0（待审）', status: 'pending',
    anchorGameMs: 9 * MINm + 15000, depsSnapshot: null,
  });
  store.insert('titles', {
    clipId: c2.id, kind: 'lower_third', text: '广告回来 比赛继续', status: 'approved',
    anchorGameMs: 11 * MINm, depsSnapshot: { static: true },
  });
  store.insert('titles', {
    clipId: c5.id, kind: 'lower_third', text: '林骁 边路突破', status: 'approved',
    anchorGameMs: 8 * MINm + 20000,
    depsSnapshot: { playerLabel: '林骁（10号）', playerId: p10.id },
  });
  store.insert('titles', {
    clipId: c7.id, kind: 'lower_third', text: '林骁 精彩扑救', status: 'approved',
    anchorGameMs: 44 * MINm + 40000,
    depsSnapshot: { playerLabel: '林骁（10号）', playerId: p10.id },
  });

  /* ---------------- 许可（只覆盖部分帧段） ---------------- */
  const g = (materialId, mvId, frameIn, frameOut, status, extra = {}) => store.insert('grants', {
    materialId, materialVersionId: mvId, frameIn, frameOut,
    territory: 'CN', terms: 'master-clip-30s', status,
    validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z',
    deleted: false, ...extra,
  });
  g(matMain.id, mvMain.id, 0, 60000, 'active', { terms: 'highlight-bundle-A' });           // 主机位 0–20′
  g(matMain.id, mvMain.id, 60001, 77988, 'active', { terms: 'highlight-bundle-B' });       // 主机位 20′–43′20″（精确到 VFR 帧）
  g(matMain.id, mvMain.id, 80388, 80837, 'active', { terms: 'save-master-short', note: '仅覆盖 44′40″–44′55″ 的固定源精修镜' });
  // 主机位 77989–80387 帧（约43′20″–44′40″）无许可 → c4 落缺口
  g(matB.id, mvB.id, 0, 3600, 'active', { terms: 'replay-reuse' });
  g(matAlt.id, mvAlt.id, 0, 1800, 'revoked', { terms: 'post-show-alt-angle', note: '许可已撤销，且源文件失联' });
  // 广告素材无任何许可记录

  /* ---------------- 订正触发标题复核（误报的 2-0 标题被打回） ---------------- */
  require('./reconcile').reconcileAll();

  if (!silent) console.log('seed done. rev =', store.load().rev);
  return { match, timelineVersions: [tv1, tv2, tv3, tv4], clips: [c1, c2, c3, c4, c5, c6, c7] };
}

module.exports = { reset, build };

if (require.main === module) reset();
