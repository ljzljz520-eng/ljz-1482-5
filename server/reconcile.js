'use strict';
/**
 * 标题复核：比分订正或球员标签变化必须触发相关标题复核。
 * 规则：
 *  - 标题以比赛计时锚点（anchorGameMs）与所依赖事实（depsSnapshot）关联；
 *  - 出现更新的、未作废的比分状态/球员标签，且其 gameMs 命中标题锚点区间（±2000ms），
 *    或显式引用同一球员，则把非草稿的已批准标题打回 review_required；
 *  - 导出口只接受 status=approved，复核中的文案绝不出现在任务包里。
 */
const store = require('./store');

function currentScoreAt(gameMs) {
  const rows = store.find('scoreStates', s => !s.superseded && s.gameMs <= gameMs)
    .sort((a, b) => b.gameMs - a.gameMs);
  return rows[0] || null;
}

function currentTagAt(gameMs) {
  const rows = store.find('playerTags', t => !t.corrected || true)
    .filter(t => !store.one('playerTags', x => x.supersedesTagId === t.id && !x.superseded))
    .filter(t => Math.abs(t.gameMs - gameMs) <= 2000)
    .sort((a, b) => b.createdAt - a.createdAt);
  return rows[0] || null;
}

/**
 * 对单个标题做事实核对；若发现依赖事实已变化，把 approved -> review_required。
 * 返回 {changed, reasons[]}
 */
function checkTitle(title) {
  if (title.status !== 'approved') return { changed: false, reasons: [] };
  const reasons = [];
  const snap = title.depsSnapshot || {};
  if (typeof snap.home === 'number' || typeof snap.away === 'number') {
    const cur = currentScoreAt(title.anchorGameMs);
    if (cur && (cur.home !== snap.home || cur.away !== snap.away)) {
      reasons.push({ kind: 'score_changed', from: { home: snap.home, away: snap.away }, to: { home: cur.home, away: cur.away } });
    }
  }
  if (snap.scorerLabel) {
    const cur = currentTagAt(title.anchorGameMs);
    if (cur && cur.label !== snap.scorerLabel) {
      reasons.push({ kind: 'player_tag_changed', from: snap.scorerLabel, to: cur.label, tagId: cur.id });
    }
  }
  if (snap.playerId) {
    const newer = store.one('playerTags', t => t.playerId === snap.playerId
      && t.supersedesTagId && !t.superseded
      && Math.abs(t.gameMs - title.anchorGameMs) <= 5000);
    if (newer) reasons.push({ kind: 'player_tag_correction', tagId: newer.id, to: newer.label });
  }
  if (reasons.length) {
    store.update('titles', title.id, {
      status: 'review_required', reviewReasons: reasons, reviewRequiredAt: Date.now(),
    });
  }
  return { changed: reasons.length > 0, reasons };
}

function reconcileAll() {
  const out = [];
  for (const t of store.find('titles', x => !x.deleted)) {
    const r = checkTitle(t);
    if (r.changed) out.push({ titleId: t.id, reasons: r.reasons });
  }
  return out;
}

/** 新订正落库时：只复核锚点命中的标题（增量） */
function reconcileForGamePoint(gameMs, playerId) {
  const out = [];
  for (const t of store.find('titles', x => !x.deleted)) {
    if (Math.abs(t.anchorGameMs - gameMs) <= 5000 || (playerId && (t.depsSnapshot || {}).playerId === playerId)) {
      const r = checkTitle(t);
      if (r.changed) out.push({ titleId: t.id, reasons: r.reasons });
    }
  }
  return out;
}

module.exports = { checkTitle, reconcileAll, reconcileForGamePoint, currentScoreAt };
