'use strict';
/**
 * 零依赖 JSON 文档存储。
 * 单进程 Node 的事件循环本身串行执行；所有写操作经 save() 同步刷盘，
 * 配合“读-改-写”函数内不 await，天然等价于串行事务。
 * 每次写文件递增 rev（乐观版本号），删除内容保留墓碑记录。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const TABLES = [
  'matches', 'materials', 'materialVersions',
  'timelines', 'timelineVersions', 'segments', 'clockSegments',
  'scoreStates', 'players', 'playerTags', 'events',
  'clips', 'clipResolutions', 'titles', 'grants', 'jobs', 'packages',
];

function emptyState() {
  const s = { rev: 0, seq: 0, idem: {} };
  for (const t of TABLES) s[t] = [];
  return s;
}

let state = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {
    state = emptyState();
  }
  return state;
}

function save() {
  state.rev += 1;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
}

function id(prefix) {
  state.seq += 1;
  return `${prefix}_${String(state.seq).padStart(4, '0')}`;
}

function all(table) { return load()[table]; }
function get(table, pk) { return load()[table].find(r => r.id === pk) || null; }
function find(table, pred) { return load()[table].filter(pred); }
function one(table, pred) { return load()[table].find(pred) || null; }

function insert(table, row) {
  const db = load();
  if (!row.id) row.id = id(table.endsWith('s') ? table.slice(0, -1) : table);
  db[table].push(row);
  save();
  return row;
}

function update(table, pk, patch) {
  const row = get(table, pk);
  if (!row) throw Object.assign(new Error(`${table} not found: ${pk}`), { status: 404 });
  Object.assign(row, patch);
  save();
  return row;
}

/** 软删除：保留墓碑，供“作业晚于删除到达”等场景裁决 */
function softDelete(table, pk, reason) {
  const row = get(table, pk);
  if (!row) throw Object.assign(new Error(`${table} not found: ${pk}`), { status: 404 });
  row.deleted = true;
  row.deletedAt = Date.now();
  row.deletedReason = reason || 'user';
  save();
  return row;
}

function reset(data) {
  state = data || emptyState();
  save();
  return state;
}

function idempotent(key, producer) {
  const db = load();
  const existing = db.idem[key];
  if (existing) return { row: existing.row, reused: true };
  const row = producer();
  db.idem[key] = { rowId: row.id, row };
  save();
  return { row, reused: false };
}

module.exports = { DATA_DIR, DB_FILE, TABLES, load, save, all, get, find, one, insert, update, softDelete, reset, idempotent, id };
