"""
conform.py — 一致性引擎:
  * 镜头解析/重定位(新时间轴版本、后补素材)
  * 冲突检测(时间戳重置歧义、锚点落入广告/断流、源下架)
  * 许可覆盖计算(许可只覆盖部分时段)
  * 文案源哈希(比分订正/球员标签变化 -> 触发复核)
"""
import hashlib, json
import db, timing


def load_timeline(con, timeline_id):
    tl = db.row(con, "SELECT * FROM timelines WHERE id=?", (timeline_id,))
    if not tl:
        return None, None, None
    segs = db.rows(con,
        "SELECT * FROM timeline_segments WHERE timeline_id=? ORDER BY seq", (timeline_id,))
    for s in segs:
        s["match"] = None
        if s["kind"] == "content" and s["match_period"]:
            s["match"] = {"period": s["match_period"],
                          "clock_start_ms": s["match_clock_start_ms"],
                          "clock_end_ms": s["match_clock_end_ms"]}
    ver = db.row(con, "SELECT * FROM asset_versions WHERE id=?", (tl["asset_version_id"],))
    if ver:
        ver["frame_map"] = json.loads(ver["frame_map"])
    return tl, segs, ver


def latest_timeline(con, asset_id):
    return db.row(con,
        "SELECT * FROM timelines WHERE asset_id=? ORDER BY version DESC LIMIT 1", (asset_id,))


def add_issue(con, clip_id, kind, detail):
    """同类未解决issue不重复插入。"""
    existing = db.row(con,
        "SELECT id FROM clip_issues WHERE clip_id=? AND kind=? AND resolved=0",
        (clip_id, kind))
    if existing:
        db.row(con, "UPDATE clip_issues SET detail=? WHERE id=?",
               (db.j(detail), existing["id"]))
        return existing["id"]
    iid = f"iss_{hashlib.sha1(f'{clip_id}{kind}{db.now()}'.encode()).hexdigest()[:10]}"
    con.execute("INSERT INTO clip_issues VALUES(?,?,?,?,0,?)",
                (iid, clip_id, kind, db.j(detail), db.now()))
    return iid


def clear_issue(con, clip_id, kind):
    con.execute("UPDATE clip_issues SET resolved=1 WHERE clip_id=? AND kind=? AND resolved=0",
                (clip_id, kind))


def license_coverage(con, asset_id, in_ms, out_ms):
    """返回 (covered_parts, uncovered_parts)。许可只覆盖部分时段时给出未覆盖区间。"""
    lics = db.rows(con, """SELECT * FROM licenses WHERE asset_id=?
        AND media_start_ms < ? AND media_end_ms > ?
        AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY media_start_ms""", (asset_id, out_ms, in_ms, db.now()))
    covered, cur = [], in_ms
    for L in lics:
        lo, hi = max(L["media_start_ms"], in_ms), min(L["media_end_ms"], out_ms)
        if lo >= hi or lo < cur:
            continue
        covered.append({"in_ms": lo, "out_ms": hi, "rights": L["rights"]})
        cur = hi
    uncovered, cur = [], in_ms
    for c in covered:
        if c["in_ms"] > cur:
            uncovered.append({"in_ms": cur, "out_ms": c["in_ms"]})
        cur = max(cur, c["out_ms"])
    if cur < out_ms:
        uncovered.append({"in_ms": cur, "out_ms": out_ms})
    return covered, uncovered


def evaluate_clip(con, clip):
    """重算镜头全部问题: 跨断流 / 许可部分覆盖 / 源下架。返回问题列表。"""
    issues = []
    asset = db.row(con, "SELECT * FROM assets WHERE id=?", (clip["asset_id"],))
    if asset and asset["status"] == "withdrawn":
        issues.append(("source_withdrawn",
                       {"asset_id": asset["id"], "note": "源已下架(后期替换), 链接保留但不可定位"}))
    else:
        clear_issue(con, clip["asset_id"] and clip["id"], "source_withdrawn")
    tl, segs, ver = load_timeline(con, clip["timeline_id"])
    if segs:
        _, skipped = timing.split_by_content(segs, clip["in_media_ms"], clip["out_media_ms"])
        if skipped:
            issues.append(("span_gap", {"skipped": skipped,
                "note": "镜头跨越广告/断流点, 任务包将拆分为多个内容子段"}))
        else:
            clear_issue(con, clip["id"], "span_gap")
    covered, uncovered = license_coverage(
        con, clip["asset_id"], clip["in_media_ms"], clip["out_media_ms"])
    if uncovered:
        issues.append(("license_partial", {"uncovered": uncovered,
                       "note": "许可只覆盖部分时段"}))
    else:
        clear_issue(con, clip["id"], "license_partial")
    for kind, detail in issues:
        add_issue(con, clip["id"], kind, detail)
    if not issues and clip["status"] != "ready":
        con.execute("UPDATE clips SET status='ready', updated_at=? WHERE id=? AND status!='broken'",
                    (db.now(), clip["id"]))
    return issues


def relocate_clip(con, clip, to_timeline):
    """tracking 镜头重定位到新时间轴版本。
    成功 -> 更新三坐标解析值; 失败 -> 记冲突issue, 镜头标 conflict, 旧值保留。"""
    _, segs, ver = load_timeline(con, to_timeline["id"])
    log = {"clip_id": clip["id"], "to_timeline": to_timeline["id"]}
    try:
        ain = timing.match_clock_to_media(segs, clip["in_period"], clip["in_clock_ms"])
        aout = timing.match_clock_to_media(segs, clip["out_period"], clip["out_clock_ms"])
    except timing.AmbiguousMap as e:
        add_issue(con, clip["id"], "anchor_ambiguous",
                  {"candidates": e.candidates, "note": "时间戳重置导致比赛计时重复, 需人工选择"})
        con.execute("UPDATE clips SET status='conflict', updated_at=? WHERE id=?",
                    (db.now(), clip["id"]))
        _log_relocation(con, clip, to_timeline, "conflict", {**log, "reason": "ambiguous"})
        return {"ok": False, "reason": "ambiguous", "candidates": e.candidates}
    except timing.MapError as e:
        add_issue(con, clip["id"], "anchor_unmappable",
                  {"reason": e.reason, "note": "后补素材未覆盖该比赛计时"})
        con.execute("UPDATE clips SET status='conflict', updated_at=? WHERE id=?",
                    (db.now(), clip["id"]))
        _log_relocation(con, clip, to_timeline, "conflict", {**log, "reason": e.reason})
        return {"ok": False, "reason": e.reason}
    in_ms, out_ms = ain["media_ms"], aout["media_ms"]
    try:
        in_f = timing.media_to_frame(segs, ver["frame_map"], in_ms)
        out_f = timing.media_to_frame(segs, ver["frame_map"], out_ms)
    except timing.MapError as e:
        add_issue(con, clip["id"], "anchor_unmappable", {"reason": e.reason})
        _log_relocation(con, clip, to_timeline, "conflict", {**log, "reason": e.reason})
        return {"ok": False, "reason": e.reason}
    with db.tx(con):
        con.execute("""UPDATE clips SET timeline_id=?, in_media_ms=?, in_frame=?,
            out_media_ms=?, out_frame=?, status='ready', updated_at=? WHERE id=?""",
            (to_timeline["id"], in_ms, in_f, out_ms, out_f, db.now(), clip["id"]))
        for k in ("anchor_ambiguous", "anchor_unmappable", "anchor_in_gap"):
            clear_issue(con, clip["id"], k)
        _log_relocation(con, clip, to_timeline, "relocated",
                        {**log, "in_ms": in_ms, "out_ms": out_ms})
    evaluate_clip(con, db.row(con, "SELECT * FROM clips WHERE id=?", (clip["id"],)))
    return {"ok": True, "in_ms": in_ms, "out_ms": out_ms}


def conform_asset(con, asset_id):
    """新时间轴版本/后补素材发布后: 重定位该素材全部 tracking 镜头。"""
    tl = latest_timeline(con, asset_id)
    results = []
    clips = db.rows(con,
        "SELECT * FROM clips WHERE asset_id=? AND anchor_mode='tracking' AND deleted_at IS NULL",
        (asset_id,))
    for c in clips:
        if c["timeline_id"] == tl["id"]:
            evaluate_clip(con, c)
            continue
        results.append({"clip_id": c["id"], **relocate_clip(con, c, tl)})
    # pinned 镜头: 不重定位, 仅重评问题(源下架等)
    for c in db.rows(con,
        "SELECT * FROM clips WHERE asset_id=? AND anchor_mode='pinned' AND deleted_at IS NULL",
        (asset_id,)):
        evaluate_clip(con, c)
    return results


def _log_relocation(con, clip, to_timeline, outcome, detail):
    rid = "rel_" + hashlib.sha1((clip["id"] + str(db.now())).encode()).hexdigest()[:10]
    con.execute("INSERT INTO relocations VALUES(?,?,?,?,?,?,?)",
                (rid, clip["id"], clip["timeline_id"], to_timeline["id"],
                 outcome, db.j(detail), db.now()))


# ---------- 文案源哈希: 比分订正/球员标签变化 -> 复核 ----------

def clip_source_hash(con, clip_id):
    """由镜头关联事件的比分+球员标签+事件类型计算。任一变化则哈希失配。"""
    evs = db.rows(con, """SELECT e.* FROM events e JOIN clip_events ce ON ce.event_id=e.id
        WHERE ce.clip_id=? AND e.deleted_at IS NULL ORDER BY e.id""", (clip_id,))
    parts = []
    for e in evs:
        pls = db.rows(con, "SELECT player_id, role FROM event_players WHERE event_id=? ORDER BY player_id",
                      (e["id"],))
        parts.append({"type": e["type"], "score": [e["score_home"], e["score_away"]],
                      "players": pls, "rev": e["revision"]})
    blob = json.dumps(parts, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def refresh_copy_status(con, clip_id):
    """事件订正后: 哈希失配的 draft/approved 文案降级为 needs_review(禁止导出)。"""
    cur = clip_source_hash(con, clip_id)
    changed = []
    for c in db.rows(con, "SELECT * FROM copy_items WHERE clip_id=?", (clip_id,)):
        if c["source_hash"] != cur and c["status"] in ("draft", "approved"):
            con.execute("UPDATE copy_items SET status='needs_review', updated_at=? WHERE id=?",
                        (db.now(), c["id"]))
            changed.append(c["id"])
    return changed


def exportable_copy(con, clip_id):
    """只放行 approved 且哈希与当前事件一致的文案。"""
    cur = clip_source_hash(con, clip_id)
    return db.rows(con, "SELECT * FROM copy_items WHERE clip_id=? AND status='approved' AND source_hash=?",
                   (clip_id, cur))
