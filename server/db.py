"""db.py — SQLite 模式与连接助手。所有写操作走事务。"""
import sqlite3, json, time, os

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'live',          -- live | vod | replacement
  status TEXT NOT NULL DEFAULT 'active',      -- active | withdrawn(后期替换下架)
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  version INTEGER NOT NULL,
  uri TEXT NOT NULL,                          -- 稳定存储定位符(非临时播放地址)
  content_sha256 TEXT NOT NULL,               -- 素材身份: 内容哈希
  fps_type TEXT NOT NULL DEFAULT 'cfr',       -- cfr | vfr
  frame_map TEXT NOT NULL DEFAULT '[]',       -- VFR: [[frame, pts_ms], ...]
  duration_ms INTEGER NOT NULL,
  created_at REAL NOT NULL,
  UNIQUE(asset_id, version)
);

CREATE TABLE IF NOT EXISTS timelines (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
  version INTEGER NOT NULL,                   -- 单调递增, 映射可更新
  note TEXT DEFAULT '',
  created_at REAL NOT NULL,
  UNIQUE(asset_id, version)
);

CREATE TABLE IF NOT EXISTS timeline_segments (
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL REFERENCES timelines(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                         -- content | ad | gap
  media_start_ms INTEGER NOT NULL,
  media_end_ms INTEGER NOT NULL,
  frame_start INTEGER NOT NULL,
  frame_end INTEGER NOT NULL,
  reset INTEGER NOT NULL DEFAULT 0,           -- 时间戳重置
  match_period TEXT,                          -- 仅 content 段
  match_clock_start_ms INTEGER,
  match_clock_end_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_seg_timeline ON timeline_segments(timeline_id, seq);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, number INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL REFERENCES timelines(id),  -- 标注时的时间轴版本
  media_ms INTEGER NOT NULL,                  -- 媒体时间(该时间轴版本下)
  frame INTEGER NOT NULL,                     -- 帧位置
  period TEXT NOT NULL,                       -- 比赛计时(语义锚点)
  clock_ms INTEGER NOT NULL,
  type TEXT NOT NULL,                         -- goal|foul|card|sub|chance...
  team TEXT DEFAULT '',
  score_home INTEGER, score_away INTEGER,     -- 事件发生时的比分快照
  note TEXT DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,        -- 订正次数
  created_at REAL NOT NULL, updated_at REAL NOT NULL,
  deleted_at REAL
);
CREATE INDEX IF NOT EXISTS idx_events_match ON events(match_id);

CREATE TABLE IF NOT EXISTS event_players (
  event_id TEXT NOT NULL REFERENCES events(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  role TEXT NOT NULL DEFAULT 'actor',         -- actor|assist|carded...
  PRIMARY KEY(event_id, player_id, role)
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  name TEXT NOT NULL,
  anchor_mode TEXT NOT NULL DEFAULT 'tracking', -- pinned=固定源片段 | tracking=跟随可更新直播时间轴
  asset_id TEXT NOT NULL REFERENCES assets(id),
  -- 解析后的入出点(总是同时存三坐标 + 解析所用时间轴版本)
  timeline_id TEXT NOT NULL REFERENCES timelines(id),
  in_media_ms INTEGER NOT NULL, in_frame INTEGER NOT NULL,
  out_media_ms INTEGER NOT NULL, out_frame INTEGER NOT NULL,
  -- 语义锚点(tracking 模式重定位依据): 比赛计时
  in_period TEXT, in_clock_ms INTEGER, out_period TEXT, out_clock_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'ready',       -- ready | broken | conflict
  created_at REAL NOT NULL, updated_at REAL NOT NULL,
  deleted_at REAL                             -- 软删除: 坏链接保留可见
);
CREATE INDEX IF NOT EXISTS idx_clips_match ON clips(match_id);

CREATE TABLE IF NOT EXISTS clip_events (
  clip_id TEXT NOT NULL REFERENCES clips(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY(clip_id, event_id)
);

CREATE TABLE IF NOT EXISTS clip_issues (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id),
  kind TEXT NOT NULL,   -- span_gap | license_partial | anchor_ambiguous | anchor_unmappable
                        -- | anchor_in_gap | source_withdrawn | unlicensed
  detail TEXT NOT NULL DEFAULT '{}',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_clip ON clip_issues(clip_id, resolved);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  media_start_ms INTEGER NOT NULL,            -- 许可只覆盖部分时段
  media_end_ms INTEGER NOT NULL,
  rights TEXT NOT NULL DEFAULT 'highlight',
  valid_until REAL,                           -- 时间维度有效期(可空)
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS copy_items (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id),
  text TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'zh',
  status TEXT NOT NULL DEFAULT 'draft',       -- draft|approved|needs_review|rejected
  source_hash TEXT NOT NULL,                  -- 由关联事件(比分/球员)计算; 事件变则失配
  approved_by TEXT, approved_at REAL,
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copy_clip ON copy_items(clip_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'package',
  clip_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,       -- 并发裁切幂等
  status TEXT NOT NULL DEFAULT 'queued',      -- queued|running|done|orphaned|failed
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,                                -- 完成时的包清单(JSON)
  created_at REAL NOT NULL, started_at REAL, finished_at REAL
);
-- 同一镜头同时只允许一个排队/执行中的作业(并发裁切互斥)
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_clip
  ON jobs(clip_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  clip_id TEXT NOT NULL,
  manifest TEXT NOT NULL,                     -- 剪辑师任务包(含入出点/素材身份/版本)
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS relocations (      -- 重定位审计日志
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL,
  from_timeline TEXT NOT NULL, to_timeline TEXT NOT NULL,
  outcome TEXT NOT NULL,                      -- relocated | conflict
  detail TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL
);
"""

def connect(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path, timeout=30, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con

def init(path):
    con = connect(path)
    con.executescript(SCHEMA)
    return con

def now():
    return time.time()

def tx(con):
    """显式事务上下文管理器。"""
    class _Tx:
        def __enter__(self):
            con.execute("BEGIN IMMEDIATE")
            return con
        def __exit__(self, exc, *_):
            con.execute("ROLLBACK" if exc else "COMMIT")
            return False
    return _Tx()

def rows(con, sql, args=()):
    return [dict(r) for r in con.execute(sql, args).fetchall()]

def row(con, sql, args=()):
    r = con.execute(sql, args).fetchone()
    return dict(r) if r else None

def j(v):
    return json.dumps(v, ensure_ascii=False)
