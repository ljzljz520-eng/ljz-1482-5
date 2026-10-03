"""
worker.py — 后台工作器: 领取作业 -> 生成剪辑师任务包。
任务包是可复现清单: 素材身份(asset_id+version+内容哈希)、三坐标入出点、
许可覆盖、已批准文案。禁止输出临时播放地址。
"""
import json, os, threading, time
import db, timing, conform


class Worker:
    def __init__(self, db_path, pkg_dir, interval=0.15):
        self.db_path, self.pkg_dir, self.interval = db_path, pkg_dir, interval
        self._stop = threading.Event()
        self._th = None

    def start(self):
        self._th = threading.Thread(target=self._loop, daemon=True)
        self._th.start()

    def stop(self):
        self._stop.set()
        if self._th:
            self._th.join(timeout=3)

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as e:
                print(f"[worker] tick error: {e}")
            self._stop.wait(self.interval)

    def tick(self):
        con = db.connect(self.db_path)
        job = db.row(con, "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1")
        if not job:
            con.close(); return
        # 原子认领: 只有仍是 queued 才能置 running (并发工作器安全)
        with db.tx(con):
            cur = con.execute("UPDATE jobs SET status='running', started_at=? "
                              "WHERE id=? AND status='queued'", (db.now(), job["id"]))
            if cur.rowcount == 0:
                return  # 被别的 worker 抢走
        try:
            result = self._execute(con, job)
            status, manifest = result
            with db.tx(con):
                con.execute("UPDATE jobs SET status=?, result=?, finished_at=? WHERE id=?",
                            (status, db.j(manifest), db.now(), job["id"]))
                if status == "done":
                    pid = "pkg_" + job["id"].split("_", 1)[1]
                    con.execute("INSERT INTO packages VALUES(?,?,?,?,?)",
                                (pid, job["id"], job["clip_id"], db.j(manifest), db.now()))
                    path = os.path.join(self.pkg_dir, f"{pid}.json")
                    with open(path, "w", encoding="utf-8") as f:
                        json.dump(manifest, f, ensure_ascii=False, indent=2)
        except Exception as e:
            with db.tx(con):
                con.execute("UPDATE jobs SET status='failed', result=?, finished_at=? WHERE id=?",
                            (db.j({"error": f"{type(e).__name__}: {e}"}), db.now(), job["id"]))
        finally:
            con.close()

    def _execute(self, con, job):
        clip = db.row(con, "SELECT * FROM clips WHERE id=?", (job["clip_id"],))
        if not clip:
            return "orphaned", {"error": "clip row missing", "clip_id": job["clip_id"]}
        deleted = clip["deleted_at"] is not None
        tl, segs, ver = conform.load_timeline(con, clip["timeline_id"])
        asset = db.row(con, "SELECT * FROM assets WHERE id=?", (clip["asset_id"],))

        # 跨断流/广告拆分: 任务按内容子段给出
        content_parts, skipped = timing.split_by_content(
            segs, clip["in_media_ms"], clip["out_media_ms"])
        tasks = []
        for i, p in enumerate(content_parts, 1):
            def clock_of(ms, inward=0):
                # 出点恰落在段边界(如下一段是断流)时向内回退1ms取计时
                try:
                    per, ck = timing.media_to_match_clock(segs, ms - inward)
                    return {"period": per, "clock_ms": ck,
                            "text": timing.fmt_clock(per, ck)}
                except timing.MapError:
                    return None
            tasks.append({
                "seq": i,
                "kind": "content",
                "in":  {"media_ms": p["in_ms"],
                        "frame": timing.media_to_frame(segs, ver["frame_map"], p["in_ms"]),
                        "match_clock": clock_of(p["in_ms"])},
                "out": {"media_ms": p["out_ms"],
                        "frame": timing.media_to_frame(segs, ver["frame_map"], p["out_ms"]),
                        "match_clock": clock_of(p["out_ms"], inward=1)},
            })
        covered, uncovered = conform.license_coverage(
            con, clip["asset_id"], clip["in_media_ms"], clip["out_media_ms"])
        copy_ok = conform.exportable_copy(con, clip["id"])
        pending_copy = db.rows(con, """SELECT id, text, status FROM copy_items
            WHERE clip_id=? AND status IN ('draft','needs_review')""", (clip["id"],))
        issues = db.rows(con,
            "SELECT kind, detail FROM clip_issues WHERE clip_id=? AND resolved=0", (clip["id"],))

        warnings = []
        if skipped:
            warnings.append("镜头跨越广告/断流点, 已拆分为多个内容子段")
        if uncovered:
            warnings.append("许可只覆盖部分时段, 未覆盖区间列入 blocked")
        if pending_copy:
            warnings.append(f"{len(pending_copy)} 条文案未批准/待复核, 未纳入任务包")
        if asset["status"] == "withdrawn":
            warnings.append("源素材已下架(后期替换), 定位符仅作身份记录")

        manifest = {
            "package_id": "pkg_" + job["id"].split("_", 1)[1],
            "clip_id": clip["id"], "clip_name": clip["name"], "match_id": clip["match_id"],
            "anchor_mode": clip["anchor_mode"],
            "asset": {
                "asset_id": asset["id"], "name": asset["name"],
                "asset_version_id": ver["id"], "version": ver["version"],
                "content_sha256": ver["content_sha256"],
                # 稳定身份定位符, 非临时播放地址; 剪辑师据此向素材库调取
                "locator": f"asset://{asset['id']}@v{ver['version']}#{ver['content_sha256']}",
                "fps_type": ver["fps_type"],
            },
            "timeline": {"timeline_id": tl["id"], "version": tl["version"]},
            "coordinates_note": "media_ms=媒体时间, frame=帧位置, match_clock=比赛计时; "
                                "三者分别给出, 由时间轴版本关联, 不可互换",
            "tasks": tasks,
            "skipped_ranges": skipped,
            "rights": {"covered": covered, "uncovered": uncovered, "ok": not uncovered},
            "copy": [{"id": c["id"], "text": c["text"], "status": c["status"],
                      "source_hash": c["source_hash"]} for c in copy_ok],
            "open_issues": [{"kind": i["kind"], "detail": json.loads(i["detail"])}
                            for i in issues],
            "warnings": warnings,
            "deleted_after_queue": deleted,
            "created_at": db.now(),
        }
        # 作业完成晚于删除: 仍产出清单但标记 orphaned, 不生成正式包
        if deleted:
            manifest["tombstone"] = ("镜头在作业排队期间被删除; 清单仅作审计, "
                                     "不得交付剪辑")
            return "orphaned", manifest
        return "done", manifest
