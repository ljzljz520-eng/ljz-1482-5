"""
app.py — 赛事直播切片策划系统 API + 静态站点 + 内嵌工作器。
零依赖: Python 3.11 stdlib。运行: python3 server/app.py [port]
"""
import json, os, re, sys, threading, time, hashlib, secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db, timing, conform, worker

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
DB_PATH = os.environ.get("CLIP_DB", os.path.join(ROOT, "data", "clips.db"))
PKG_DIR = os.path.join(ROOT, "data", "packages")

CON = None  # 主连接(每请求开新连接避免线程争用, 见 get_con)
_LOCK = threading.Lock()


def get_con():
    con = db.connect(DB_PATH)
    return con


def uid(prefix):
    return f"{prefix}_{secrets.token_hex(5)}"


# ---------------- 业务动作 ----------------

def api_create_asset(b):
    con = get_con()
    aid = uid("ast")
    with db.tx(con):
        con.execute("INSERT INTO assets VALUES(?,?,?,?,?)",
                    (aid, b["name"], b.get("kind", "live"), "active", db.now()))
    return {"id": aid}, 201


def api_add_version(asset_id, b):
    """注册素材版本(可含 VFR 帧表)。后补素材 = 新版本注册后触发 conform。"""
    con = get_con()
    ver_no = db.row(con, "SELECT COALESCE(MAX(version),0)+1 AS v FROM asset_versions WHERE asset_id=?",
                    (asset_id,))["v"]
    vid = uid("av")
    with db.tx(con):
        con.execute("""INSERT INTO asset_versions
            (id,asset_id,version,uri,content_sha256,fps_type,frame_map,duration_ms,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (vid, asset_id, ver_no, b["uri"], b.get("content_sha256") or
             hashlib.sha256(b["uri"].encode()).hexdigest()[:16],
             b.get("fps_type", "cfr"), db.j(b.get("frame_map", [])),
             int(b["duration_ms"]), db.now()))
    return {"id": vid, "version": ver_no}, 201


def api_publish_timeline(asset_id, b):
    """发布新时间轴版本(广告插入/时间戳重置/后期替换都会产出版本)。
    发布后: tracking 镜头自动重定位, 歧义/不可映射 -> 冲突提示。"""
    con = get_con()
    ver_no = db.row(con, "SELECT COALESCE(MAX(version),0)+1 AS v FROM timelines WHERE asset_id=?",
                    (asset_id,))["v"]
    tid = uid("tl")
    with db.tx(con):
        con.execute("INSERT INTO timelines VALUES(?,?,?,?,?,?)",
                    (tid, asset_id, b["asset_version_id"], ver_no,
                     b.get("note", ""), db.now()))
        for i, s in enumerate(b["segments"]):
            m = s.get("match") or {}
            con.execute("""INSERT INTO timeline_segments
                (id,timeline_id,seq,kind,media_start_ms,media_end_ms,frame_start,frame_end,
                 reset,match_period,match_clock_start_ms,match_clock_end_ms)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (uid("seg"), tid, i, s["kind"], int(s["media_start_ms"]), int(s["media_end_ms"]),
                 int(s["frame_start"]), int(s["frame_end"]), 1 if s.get("reset") else 0,
                 m.get("period"), m.get("clock_start_ms"), m.get("clock_end_ms")))
    results = conform.conform_asset(con, asset_id)
    return {"id": tid, "version": ver_no, "relocation": results}, 201


def api_withdraw_asset(asset_id):
    """源下架(后期替换)。pinned 镜头变 broken 但保留可见。"""
    con = get_con()
    with db.tx(con):
        con.execute("UPDATE assets SET status='withdrawn' WHERE id=?", (asset_id,))
        for c in db.rows(con, "SELECT * FROM clips WHERE asset_id=? AND deleted_at IS NULL",
                         (asset_id,)):
            if c["anchor_mode"] == "pinned":
                con.execute("UPDATE clips SET status='broken', updated_at=? WHERE id=?",
                            (db.now(), c["id"]))
            conform.evaluate_clip(con, c)
    return {"ok": True}, 200


def _resolve_point(con, timeline_id, b, prefix):
    """把入/出点输入(媒体毫秒 或 比赛计时)解析为三坐标。"""
    tl, segs, ver = conform.load_timeline(con, timeline_id)
    if not tl:
        raise ApiErr(404, "timeline not found")
    if f"{prefix}_media_ms" in b and b[f"{prefix}_media_ms"] is not None:
        ms = int(b[f"{prefix}_media_ms"])
        frame = timing.media_to_frame(segs, ver["frame_map"], ms)
        try:
            period, clock = timing.media_to_match_clock(segs, ms)
        except timing.MapError:
            period, clock = b.get(f"{prefix}_period"), b.get(f"{prefix}_clock_ms")
        return {"media_ms": ms, "frame": frame, "period": period, "clock_ms": clock}
    period, clock = b[f"{prefix}_period"], int(b[f"{prefix}_clock_ms"])
    hit = timing.match_clock_to_media(segs, period, clock)  # 可能抛 AmbiguousMap
    frame = timing.media_to_frame(segs, ver["frame_map"], hit["media_ms"])
    return {"media_ms": hit["media_ms"], "frame": frame, "period": period, "clock_ms": clock}


def api_create_event(b):
    """标注事件: 同时记录三坐标 + 语义锚点。"""
    con = get_con()
    tl = conform.latest_timeline(con, b["asset_id"]) if not b.get("timeline_id") else \
        db.row(con, "SELECT * FROM timelines WHERE id=?", (b["timeline_id"],))
    try:
        p = _resolve_point(con, tl["id"], b, "at")
    except timing.AmbiguousMap as e:
        raise ApiErr(409, "ambiguous match clock", {"candidates": e.candidates})
    except timing.MapError as e:
        raise ApiErr(422, f"cannot map point: {e.reason}")
    eid = uid("ev")
    with db.tx(con):
        con.execute("""INSERT INTO events
            (id,match_id,timeline_id,media_ms,frame,period,clock_ms,type,team,
             score_home,score_away,note,revision,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)""",
            (eid, b["match_id"], tl["id"], p["media_ms"], p["frame"],
             p["period"], p["clock_ms"], b["type"], b.get("team", ""),
             b.get("score_home"), b.get("score_away"), b.get("note", ""),
             db.now(), db.now()))
        for pl in b.get("players", []):
            con.execute("INSERT INTO event_players VALUES(?,?,?)",
                        (eid, pl["player_id"], pl.get("role", "actor")))
    return {"id": eid, "at": p}, 201


def api_patch_event(event_id, b):
    """比分订正 / 球员标签变化 -> 相关镜头文案自动转 needs_review。"""
    con = get_con()
    ev = db.row(con, "SELECT * FROM events WHERE id=?", (event_id,))
    if not ev:
        raise ApiErr(404, "event not found")
    fields, args = [], []
    for k in ("score_home", "score_away", "type", "team", "note"):
        if k in b:
            fields.append(f"{k}=?"); args.append(b[k])
    with db.tx(con):
        if fields:
            con.execute(f"UPDATE events SET {', '.join(fields)}, revision=revision+1, "
                        f"updated_at=? WHERE id=?", (*args, db.now(), event_id))
        if "players" in b:
            con.execute("DELETE FROM event_players WHERE event_id=?", (event_id,))
            for pl in b["players"]:
                con.execute("INSERT INTO event_players VALUES(?,?,?)",
                            (event_id, pl["player_id"], pl.get("role", "actor")))
        affected = db.rows(con, "SELECT clip_id FROM clip_events WHERE event_id=?", (event_id,))
        flagged = []
        for c in affected:
            flagged += conform.refresh_copy_status(con, c["clip_id"])
    return {"ok": True, "revision": ev["revision"] + 1,
            "copy_flagged_for_review": flagged}, 200


def api_create_clip(b):
    """创建镜头。anchor_mode: pinned(固定源片段) | tracking(跟随可更新时间轴)。"""
    con = get_con()
    tl = conform.latest_timeline(con, b["asset_id"]) if not b.get("timeline_id") else \
        db.row(con, "SELECT * FROM timelines WHERE id=?", (b["timeline_id"],))
    try:
        pin = _resolve_point(con, tl["id"], b, "in")
        pout = _resolve_point(con, tl["id"], b, "out")
    except timing.AmbiguousMap as e:
        raise ApiErr(409, "ambiguous match clock", {"candidates": e.candidates})
    except timing.MapError as e:
        raise ApiErr(422, f"cannot map point: {e.reason}")
    if pout["media_ms"] <= pin["media_ms"]:
        raise ApiErr(422, "out must be after in")
    cid = uid("clip")
    with db.tx(con):
        con.execute("""INSERT INTO clips
            (id,match_id,name,anchor_mode,asset_id,timeline_id,
             in_media_ms,in_frame,out_media_ms,out_frame,
             in_period,in_clock_ms,out_period,out_clock_ms,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)""",
            (cid, b["match_id"], b["name"], b.get("anchor_mode", "tracking"),
             b["asset_id"], tl["id"], pin["media_ms"], pin["frame"],
             pout["media_ms"], pout["frame"],
             pin["period"], pin["clock_ms"], pout["period"], pout["clock_ms"],
             db.now(), db.now()))
        for eid in b.get("event_ids", []):
            con.execute("INSERT INTO clip_events VALUES(?,?)", (cid, eid))
        clip = db.row(con, "SELECT * FROM clips WHERE id=?", (cid,))
        conform.evaluate_clip(con, clip)
    return {"id": cid, "in": pin, "out": pout}, 201


def api_delete_clip(clip_id):
    """软删除: 坏链接保留在列表; 进行中的作业完成后落 orphaned。"""
    con = get_con()
    with db.tx(con):
        con.execute("UPDATE clips SET deleted_at=?, updated_at=? WHERE id=?",
                    (db.now(), db.now(), clip_id))
    return {"ok": True}, 200


def api_relocate_clip(clip_id, b):
    """手动重定位: 歧义时带 chosen_media_ms 选定候选。"""
    con = get_con()
    clip = db.row(con, "SELECT * FROM clips WHERE id=?", (clip_id,))
    if not clip:
        raise ApiErr(404, "clip not found")
    tl = conform.latest_timeline(con, clip["asset_id"])
    if b.get("chosen_in_media_ms") is not None and b.get("chosen_out_media_ms") is not None:
        _, segs, ver = conform.load_timeline(con, tl["id"])
        in_ms, out_ms = int(b["chosen_in_media_ms"]), int(b["chosen_out_media_ms"])
        with db.tx(con):
            con.execute("""UPDATE clips SET timeline_id=?, in_media_ms=?, in_frame=?,
                out_media_ms=?, out_frame=?, status='ready', updated_at=? WHERE id=?""",
                (tl["id"], in_ms, timing.media_to_frame(segs, ver["frame_map"], in_ms),
                 out_ms, timing.media_to_frame(segs, ver["frame_map"], out_ms),
                 db.now(), clip_id))
            for k in ("anchor_ambiguous", "anchor_unmappable"):
                conform.clear_issue(con, clip_id, k)
        conform.evaluate_clip(con, db.row(con, "SELECT * FROM clips WHERE id=?", (clip_id,)))
        return {"ok": True, "manual": True}, 200
    return conform.relocate_clip(con, clip, tl), 200


def api_add_license(b):
    con = get_con()
    lid = uid("lic")
    with db.tx(con):
        con.execute("INSERT INTO licenses VALUES(?,?,?,?,?,?,?)",
                    (lid, b["asset_id"], int(b["media_start_ms"]), int(b["media_end_ms"]),
                     b.get("rights", "highlight"), b.get("valid_until"), db.now()))
        for c in db.rows(con, "SELECT * FROM clips WHERE asset_id=? AND deleted_at IS NULL",
                         (b["asset_id"],)):
            conform.evaluate_clip(con, c)
    return {"id": lid}, 201


def api_gen_copy(clip_id, b):
    """依据关联事件生成标题文案(draft)。哈希随比分/球员变化而失效。"""
    con = get_con()
    clip = db.row(con, "SELECT * FROM clips WHERE id=?", (clip_id,))
    evs = db.rows(con, """SELECT e.* FROM events e JOIN clip_events ce ON ce.event_id=e.id
        WHERE ce.clip_id=? AND e.deleted_at IS NULL ORDER BY e.clock_ms""", (clip_id,))
    parts = []
    for e in evs:
        pls = db.rows(con, """SELECT p.name, ep.role FROM event_players ep
            JOIN players p ON p.id=ep.player_id WHERE ep.event_id=?""", (e["id"],))
        names = "、".join(p["name"] for p in pls) or "未知球员"
        score = (f" {e['score_home']}-{e['score_away']}"
                 if e["score_home"] is not None else "")
        parts.append(f"{timing.fmt_clock(e['period'], e['clock_ms'])} {names} {e['type']}{score}")
    text = b.get("text") or ("【集锦】" + "；".join(parts) if parts else f"【集锦】{clip['name']}")
    cid = uid("cpy")
    with db.tx(con):
        con.execute("""INSERT INTO copy_items
            (id,clip_id,text,lang,status,source_hash,created_at,updated_at)
            VALUES(?,?,?,?,'draft',?,?,?)""",
            (cid, clip_id, text, b.get("lang", "zh"),
             conform.clip_source_hash(con, clip_id), db.now(), db.now()))
    return {"id": cid, "text": text}, 201


def api_set_copy(copy_id, b):
    con = get_con()
    c = db.row(con, "SELECT * FROM copy_items WHERE id=?", (copy_id,))
    if not c:
        raise ApiErr(404, "copy not found")
    action = b["action"]
    if action == "approve":
        cur = conform.clip_source_hash(con, c["clip_id"])
        if c["source_hash"] != cur:
            raise ApiErr(409, "copy is stale: 事件已订正, 请重新生成后再批准")
        con.execute("""UPDATE copy_items SET status='approved', approved_by=?,
            approved_at=?, updated_at=? WHERE id=?""",
            (b.get("by", "editor"), db.now(), db.now(), copy_id))
    elif action == "reject":
        con.execute("UPDATE copy_items SET status='rejected', updated_at=? WHERE id=?",
                    (db.now(), copy_id))
    elif action == "revert_to_draft":
        con.execute("UPDATE copy_items SET status='draft', updated_at=? WHERE id=?",
                    (db.now(), copy_id))
    return {"ok": True}, 200


def api_create_job(b):
    """创建裁切/打包作业。幂等键 + 每镜头活动作业互斥 -> 并发裁切安全。"""
    con = get_con()
    key = b.get("idempotency_key") or uid("idem")
    existing = db.row(con, "SELECT * FROM jobs WHERE idempotency_key=?", (key,))
    if existing:
        return {"id": existing["id"], "deduplicated": True,
                "status": existing["status"]}, 200
    active = db.row(con, "SELECT * FROM jobs WHERE clip_id=? AND status IN ('queued','running')",
                    (b["clip_id"],))
    if active:
        return {"id": active["id"], "deduplicated": True,
                "status": active["status"], "note": "clip already has active job"}, 200
    jid = uid("job")
    try:
        with db.tx(con):
            con.execute("INSERT INTO jobs (id,type,clip_id,idempotency_key,status,payload,created_at)"
                        " VALUES(?,?,?,?,'queued',?,?)",
                        (jid, b.get("type", "package"), b["clip_id"], key,
                         db.j(b.get("payload", {})), db.now()))
    except Exception as e:
        if "UNIQUE" in str(e):  # 并发撞键: 返回已存在的作业
            j2 = db.row(con, "SELECT * FROM jobs WHERE idempotency_key=?", (key,)) or \
                 db.row(con, "SELECT * FROM jobs WHERE clip_id=? AND status IN ('queued','running')",
                        (b["clip_id"],))
            return {"id": j2["id"], "deduplicated": True, "status": j2["status"]}, 200
        raise
    return {"id": jid, "status": "queued"}, 201


# ---------------- 状态聚合(前端) ----------------

def full_state():
    con = get_con()
    clips = db.rows(con, "SELECT * FROM clips ORDER BY created_at")  # 含软删除(坏链接保留)
    for c in clips:
        c["issues"] = db.rows(con,
            "SELECT kind, detail, resolved FROM clip_issues WHERE clip_id=? AND resolved=0",
            (c["id"],))
        for i in c["issues"]:
            i["detail"] = json.loads(i["detail"])
        c["events"] = db.rows(con, """SELECT e.* FROM events e JOIN clip_events ce
            ON ce.event_id=e.id WHERE ce.clip_id=?""", (c["id"],))
        c["copy"] = db.rows(con, "SELECT * FROM copy_items WHERE clip_id=?", (c["id"],))
    events = db.rows(con, "SELECT * FROM events WHERE deleted_at IS NULL ORDER BY clock_ms")
    for e in events:
        e["players"] = db.rows(con, """SELECT p.id, p.name, p.team, ep.role FROM event_players ep
            JOIN players p ON p.id=ep.player_id WHERE ep.event_id=?""", (e["id"],))
    tls = db.rows(con, "SELECT * FROM timelines ORDER BY asset_id, version")
    for t in tls:
        t["segments"] = db.rows(con,
            "SELECT * FROM timeline_segments WHERE timeline_id=? ORDER BY seq", (t["id"],))
    return {
        "assets": db.rows(con, "SELECT * FROM assets"),
        "asset_versions": db.rows(con, "SELECT * FROM asset_versions"),
        "timelines": tls,
        "players": db.rows(con, "SELECT * FROM players"),
        "events": events,
        "clips": clips,
        "licenses": db.rows(con, "SELECT * FROM licenses"),
        "jobs": db.rows(con, "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50"),
        "packages": db.rows(con, "SELECT id, job_id, clip_id, created_at FROM packages"),
        "relocations": db.rows(con, "SELECT * FROM relocations ORDER BY created_at DESC LIMIT 50"),
    }


class ApiErr(Exception):
    def __init__(self, code, msg, extra=None):
        super().__init__(msg)
        self.code, self.extra = code, extra or {}


def api_get_job(job_id):
    j = db.row(get_con(), "SELECT * FROM jobs WHERE id=?", (job_id,))
    if not j:
        raise ApiErr(404, "job not found")
    return j, 200


def api_get_package(pkg_id):
    p = db.row(get_con(), "SELECT * FROM packages WHERE id=?", (pkg_id,))
    if not p:
        raise ApiErr(404, "package not found")
    return json.loads(p["manifest"]), 200


ROUTES = [
    ("GET",  r"/api/state",                        lambda q, b: (full_state(), 200)),
    ("POST", r"/api/assets",                       lambda q, b: api_create_asset(b)),
    ("POST", r"/api/assets/([^/]+)/versions",      lambda q, b, m: api_add_version(m[0], b)),
    ("POST", r"/api/assets/([^/]+)/timelines",     lambda q, b, m: api_publish_timeline(m[0], b)),
    ("POST", r"/api/assets/([^/]+)/withdraw",      lambda q, b, m: (api_withdraw_asset(m[0]))),
    ("POST", r"/api/events",                       lambda q, b: api_create_event(b)),
    ("PATCH",r"/api/events/([^/]+)",               lambda q, b, m: api_patch_event(m[0], b)),
    ("POST", r"/api/clips",                        lambda q, b: api_create_clip(b)),
    ("POST", r"/api/clips/([^/]+)/delete",         lambda q, b, m: api_delete_clip(m[0])),
    ("POST", r"/api/clips/([^/]+)/relocate",       lambda q, b, m: api_relocate_clip(m[0], b)),
    ("POST", r"/api/clips/([^/]+)/copy",           lambda q, b, m: api_gen_copy(m[0], b)),
    ("POST", r"/api/copy/([^/]+)",                 lambda q, b, m: api_set_copy(m[0], b)),
    ("POST", r"/api/licenses",                     lambda q, b: api_add_license(b)),
    ("POST", r"/api/jobs",                         lambda q, b: api_create_job(b)),
    ("GET",  r"/api/jobs/([^/]+)",                 lambda q, b, m: api_get_job(m[0])),
    ("GET",  r"/api/packages/([^/]+)",             lambda q, b, m: api_get_package(m[0])),
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        fp = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
        if not fp.startswith(WEB) or not os.path.isfile(fp):
            self.send_error(404); return
        ctype = {".html": "text/html", ".js": "text/javascript",
                 ".css": "text/css"}.get(os.path.splitext(fp)[1], "text/plain")
        body = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, method):
        path = self.path.split("?")[0]
        if not path.startswith("/api/"):
            return self._static(path)
        body = {}
        if method in ("POST", "PATCH"):
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                body = json.loads(self.rfile.read(n).decode())
        try:
            for mth, pat, fn in ROUTES:
                if mth != method:
                    continue
                m = re.fullmatch(pat, path)
                if m:
                    res = fn(None, body, *([m.groups()] if m.groups() else []))
                    return self._send(res[1], res[0])
            raise ApiErr(404, "route not found")
        except ApiErr as e:
            self._send(e.code, {"error": str(e), **e.extra})
        except timing.MapError as e:
            self._send(422, {"error": str(e), "reason": e.reason})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    do_GET = lambda s: s._handle("GET")
    do_POST = lambda s: s._handle("POST")
    do_PATCH = lambda s: s._handle("PATCH")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8077
    db.init(DB_PATH)
    os.makedirs(PKG_DIR, exist_ok=True)
    wk = worker.Worker(DB_PATH, PKG_DIR)
    wk.start()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"serving http://127.0.0.1:{port}  db={DB_PATH}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        wk.stop()


if __name__ == "__main__":
    main()
