"""
验收测试 — 每个用例对应需求中的一条验收标准。
运行: python3 tests/test_acceptance.py
"""
import json, os, socket, subprocess, sys, tempfile, time, unittest, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Server:
    def __init__(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.db")
        self.port = free_port()
        env = dict(os.environ, CLIP_DB=self.db)
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "server", "app.py"), str(self.port)],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.base = f"http://127.0.0.1:{self.port}"
        for _ in range(60):
            try:
                self.call("GET", "/api/state"); break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not start")

    def call(self, method, path, body=None, expect=None):
        req = urllib.request.Request(self.base + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                code, out = r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            code, out = e.code, json.loads(e.read())
        if expect and code != expect:
            raise AssertionError(f"{method} {path} -> {code} (want {expect}): {out}")
        return code, out

    def wait_job(self, jid, timeout=10):
        t0 = time.time()
        while time.time() - t0 < timeout:
            _, j = self.call("GET", f"/api/jobs/{jid}")
            if j["status"] not in ("queued", "running"):
                return j
            time.sleep(0.1)
        raise TimeoutError(jid)

    def stop(self):
        self.proc.terminate(); self.proc.wait(timeout=5)


def cfr_map(dur, fps=25):
    return [[int(i * fps), i * 1000] for i in range(dur // 1000 + 1)]


class Base(unittest.TestCase):
    """搭好一场带广告+断流+加时 的比赛。"""
    @classmethod
    def setUpClass(cls):
        cls.srv = Server()
        s = cls.srv
        _, cls.ast = s.call("POST", "/api/assets", {"name": "直播源A"}, expect=201)
        _, av = s.call("POST", f"/api/assets/{cls.ast['id']}/versions",
                       {"uri": "s3://m/a.ts", "duration_ms": 6120000,
                        "frame_map": cfr_map(6120000)}, expect=201)
        _, tl = s.call("POST", f"/api/assets/{cls.ast['id']}/timelines", {
            "asset_version_id": av["id"],
            "segments": [
                {"kind": "content", "media_start_ms": 0, "media_end_ms": 2700000,
                 "frame_start": 0, "frame_end": 67500,
                 "match": {"period": "1H", "clock_start_ms": 0, "clock_end_ms": 2700000}},
                {"kind": "ad", "media_start_ms": 2700000, "media_end_ms": 2760000,
                 "frame_start": 67500, "frame_end": 69000},
                {"kind": "content", "media_start_ms": 2760000, "media_end_ms": 5460000,
                 "frame_start": 69000, "frame_end": 136500,
                 "match": {"period": "2H", "clock_start_ms": 0, "clock_end_ms": 2700000}},
                {"kind": "gap", "media_start_ms": 5460000, "media_end_ms": 5520000,
                 "frame_start": 136500, "frame_end": 138000},
                {"kind": "content", "media_start_ms": 5520000, "media_end_ms": 6120000,
                 "frame_start": 138000, "frame_end": 153000,
                 "match": {"period": "ET1", "clock_start_ms": 0, "clock_end_ms": 600000}}]},
            expect=201)
        cls.tl1, cls.av1 = tl, av
        # 球员(直接写库)
        import sqlite3
        con = sqlite3.connect(s.db)
        con.executemany("INSERT INTO players VALUES(?,?,?,?)",
                        [("p1", "张三", "A", 9), ("p2", "李四", "A", 7)])
        con.commit(); con.close()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def mk_event(self, period, clock, typ="goal", h=1, a=0, players=("p1",)):
        _, e = self.srv.call("POST", "/api/events", {
            "match_id": "M", "asset_id": self.ast["id"],
            "at_period": period, "at_clock_ms": clock, "type": typ,
            "score_home": h, "score_away": a,
            "players": [{"player_id": p} for p in players]}, expect=201)
        return e["id"]

    def mk_clip(self, name, ip, ic, op, oc, evs=(), mode="tracking"):
        _, c = self.srv.call("POST", "/api/clips", {
            "match_id": "M", "asset_id": self.ast["id"], "name": name, "anchor_mode": mode,
            "in_period": ip, "in_clock_ms": ic, "out_period": op, "out_clock_ms": oc,
            "event_ids": list(evs)}, expect=201)
        return c["id"]

    def clip_of(self, cid):
        _, st = self.srv.call("GET", "/api/state")
        return next(c for c in st["clips"] if c["id"] == cid)


class TestSpanGap(Base):
    """验收1: 镜头跨断流点 -> 标记span_gap, 任务包拆成内容子段, 帧号正确。"""
    def test_span_gap(self):
        cid = self.mk_clip("跨断流", "2H", 2670000, "ET1", 30000)
        c = self.clip_of(cid)
        kinds = [i["kind"] for i in c["issues"]]
        self.assertIn("span_gap", kinds)
        _, j = self.srv.call("POST", "/api/jobs",
                             {"clip_id": cid, "idempotency_key": "t1"}, expect=201)
        j = self.srv.wait_job(j["id"])
        self.assertEqual(j["status"], "done")
        m = json.loads(j["result"])
        self.assertEqual(len(m["tasks"]), 2, "断流两侧应拆成两个内容子段")
        self.assertEqual(m["tasks"][0]["out"]["media_ms"], 5460000)
        self.assertEqual(m["tasks"][1]["in"]["media_ms"], 5520000)
        self.assertTrue(m["skipped_ranges"], "断流区间必须记录")
        # 三坐标同时给出
        self.assertIn("frame", m["tasks"][0]["in"])
        self.assertIn("match_clock", m["tasks"][0]["in"])


class TestVFR(Base):
    """验收2: 变帧率源 -> 帧位置按帧表换算, 不得用恒定帧率估算。"""
    def test_vfr(self):
        s = self.srv
        _, a2 = s.call("POST", "/api/assets", {"name": "VFR机位"}, expect=201)
        vfr = [[0, 0], [100, 5000], [150, 10000], [400, 25000], [500, 40000]]
        _, av = s.call("POST", f"/api/assets/{a2['id']}/versions",
                       {"uri": "s3://m/vfr.mkv", "duration_ms": 40000,
                        "fps_type": "vfr", "frame_map": vfr}, expect=201)
        s.call("POST", f"/api/assets/{a2['id']}/timelines", {
            "asset_version_id": av["id"],
            "segments": [{"kind": "content", "media_start_ms": 0, "media_end_ms": 40000,
                          "frame_start": 0, "frame_end": 500,
                          "match": {"period": "1H", "clock_start_ms": 0,
                                    "clock_end_ms": 40000}}]}, expect=201)
        _, c = s.call("POST", "/api/clips", {
            "match_id": "M", "asset_id": a2["id"], "name": "vfr镜头",
            "in_period": "1H", "in_clock_ms": 10000, "out_period": "1H",
            "out_clock_ms": 25000}, expect=201)
        clip = None
        _, st = s.call("GET", "/api/state")
        clip = next(x for x in st["clips"] if x["id"] == c["id"])
        # 10s 处恰为帧150(帧表精确命中); 25s 处为帧400
        self.assertEqual(clip["in_frame"], 150)
        self.assertEqual(clip["out_frame"], 400)
        # 若是恒定帧率误算(如25fps)会得到250/625 —— 断言不是
        self.assertNotEqual(clip["out_frame"], 625)


class TestLicensePartial(Base):
    """验收3: 许可只覆盖部分时段 -> license_partial, 任务包列出未覆盖区间。"""
    def test_partial_license(self):
        cid = self.mk_clip("半程镜头", "1H", 1500000, "1H", 2400000)  # 25:00-40:00
        # 许可只到 30:00
        self.srv.call("POST", "/api/licenses", {
            "asset_id": self.ast["id"], "media_start_ms": 0,
            "media_end_ms": 1800000}, expect=201)
        c = self.clip_of(cid)
        self.assertIn("license_partial", [i["kind"] for i in c["issues"]])
        _, j = self.srv.call("POST", "/api/jobs",
                             {"clip_id": cid, "idempotency_key": "t3"}, expect=201)
        m = json.loads(self.srv.wait_job(j["id"])["result"])
        self.assertFalse(m["rights"]["ok"])
        self.assertEqual(m["rights"]["uncovered"],
                         [{"in_ms": 1800000, "out_ms": 2400000}])
        self.assertTrue(any("许可" in w for w in m["warnings"]))


class TestConcurrentCrop(Base):
    """验收4: 并发裁切 -> 幂等键去重 + 每镜头活动作业互斥, 只产出一个任务包。"""
    def test_concurrent(self):
        cid = self.mk_clip("并发镜头", "1H", 100000, "1H", 160000)
        ids = set()
        for i in range(6):  # 同键并发
            _, r = self.srv.call("POST", "/api/jobs",
                                 {"clip_id": cid, "idempotency_key": "dup-key"})
            ids.add(r["id"])
        self.assertEqual(len(ids), 1, "同幂等键必须收敛为同一作业")
        for i in range(3):  # 不同键但同镜头
            _, r = self.srv.call("POST", "/api/jobs",
                                 {"clip_id": cid, "idempotency_key": f"other-{i}"})
            ids.add(r["id"])
        self.assertEqual(len(ids), 1, "同镜头活动作业必须互斥")
        j = self.srv.wait_job(ids.pop())
        self.assertEqual(j["status"], "done")
        _, st = self.srv.call("GET", "/api/state")
        pkgs = [p for p in st["packages"] if p["clip_id"] == cid]
        self.assertEqual(len(pkgs), 1, "只能产出一个任务包")


class TestJobAfterDelete(Base):
    """验收5: 作业完成晚于删除 -> orphaned, 不崩溃, 清单带删除标记, 坏链接保留。"""
    def test_orphan(self):
        cid = self.mk_clip("将被删除", "1H", 200000, "1H", 260000)
        _, j = self.srv.call("POST", "/api/jobs",
                             {"clip_id": cid, "idempotency_key": "t5"}, expect=201)
        self.srv.call("POST", f"/api/clips/{cid}/delete", {}, expect=200)
        j = self.srv.wait_job(j["id"])
        self.assertEqual(j["status"], "orphaned")
        m = json.loads(j["result"])
        self.assertTrue(m["deleted_after_queue"])
        self.assertIn("tombstone", m)
        c = self.clip_of(cid)  # 坏链接仍在列表中
        self.assertIsNotNone(c["deleted_at"])
        _, st = self.srv.call("GET", "/api/state")
        self.assertFalse(any(p["clip_id"] == cid for p in st["packages"]),
                         "已删除镜头不得生成正式任务包")


class TestScoreCorrection(Base):
    """验收6: 比分订正/球员标签变化 -> 文案打回复核; 导出不含未批准文案。"""
    def test_copy_review(self):
        ev = self.mk_event("1H", 300000, h=1, a=0)
        cid = self.mk_clip("进球镜头", "1H", 270000, "1H", 330000, evs=[ev])
        _, cp = self.srv.call("POST", f"/api/clips/{cid}/copy", {}, expect=201)
        self.srv.call("POST", f"/api/copy/{cp['id']}",
                      {"action": "approve", "by": "ed"}, expect=200)
        # 订正比分 1-0 -> 1-1
        _, r = self.srv.call("PATCH", f"/api/events/{ev}",
                             {"score_home": 1, "score_away": 1}, expect=200)
        self.assertEqual(r["copy_flagged_for_review"], [cp["id"]])
        # 导出: 未批准文案不得混入
        _, j = self.srv.call("POST", "/api/jobs",
                             {"clip_id": cid, "idempotency_key": "t6"}, expect=201)
        m = json.loads(self.srv.wait_job(j["id"])["result"])
        self.assertEqual(m["copy"], [], "needs_review 文案不得进入任务包")
        self.assertTrue(any("文案" in w for w in m["warnings"]))
        # 过期文案不能被批准
        code, _ = self.srv.call("POST", f"/api/copy/{cp['id']}", {"action": "approve"})
        self.assertEqual(code, 409)
        # 重新生成 -> 批准 -> 再导出应包含
        _, cp2 = self.srv.call("POST", f"/api/clips/{cid}/copy", {}, expect=201)
        self.assertIn("1-1", cp2["text"])
        self.srv.call("POST", f"/api/copy/{cp2['id']}", {"action": "approve"}, expect=200)
        _, j2 = self.srv.call("POST", "/api/jobs",
                              {"clip_id": cid, "idempotency_key": "t6b"}, expect=201)
        m2 = json.loads(self.srv.wait_job(j2["id"])["result"])
        self.assertEqual(len(m2["copy"]), 1)
        self.assertIn("1-1", m2["copy"][0]["text"])
        # 球员标签变化同样触发
        _, r3 = self.srv.call("PATCH", f"/api/events/{ev}",
                              {"players": [{"player_id": "p2", "role": "actor"}]}, expect=200)
        self.assertEqual(r3["copy_flagged_for_review"], [cp2["id"]])


class TestTimelineUpdate(Base):
    """验收7: 后补素材(净信号) -> tracking镜头自动重定位且保持比赛计时;
    时间戳重置 -> 歧义冲突 + 人工选定; pinned镜头不动。"""
    def test_relocate_clean_feed(self):
        cid = self.mk_clip("跟随镜头", "1H", 1200000, "1H", 1230000)
        pin = self.mk_clip("固定镜头", "1H", 1200000, "1H", 1230000, mode="pinned")
        s = self.srv
        _, av2 = s.call("POST", f"/api/assets/{self.ast['id']}/versions",
                        {"uri": "s3://m/clean.ts", "duration_ms": 6000000,
                         "frame_map": cfr_map(6000000)}, expect=201)
        _, r = s.call("POST", f"/api/assets/{self.ast['id']}/timelines", {
            "asset_version_id": av2["id"], "note": "净信号",
            "segments": [
                {"kind": "content", "media_start_ms": 0, "media_end_ms": 2700000,
                 "frame_start": 0, "frame_end": 67500,
                 "match": {"period": "1H", "clock_start_ms": 0, "clock_end_ms": 2700000}},
                {"kind": "content", "media_start_ms": 2700000, "media_end_ms": 5400000,
                 "frame_start": 67500, "frame_end": 135000,
                 "match": {"period": "2H", "clock_start_ms": 0, "clock_end_ms": 2700000}},
                {"kind": "content", "media_start_ms": 5400000, "media_end_ms": 6000000,
                 "frame_start": 135000, "frame_end": 150000,
                 "match": {"period": "ET1", "clock_start_ms": 0, "clock_end_ms": 600000}}]},
            expect=201)
        moved = [x for x in r["relocation"] if x["clip_id"] == cid]
        self.assertTrue(moved and moved[0]["ok"], "tracking镜头应重定位成功")
        c = self.clip_of(cid)
        self.assertEqual(c["in_media_ms"], 1200000)  # 1H区媒体位置不变
        p = self.clip_of(pin)
        self.assertEqual(p["timeline_id"], self.tl1["id"], "pinned镜头不得移动")

    def test_reset_ambiguity(self):
        cid = self.mk_clip("歧义镜头", "1H", 600000, "1H", 660000)
        s = self.srv
        _, av3 = s.call("POST", f"/api/assets/{self.ast['id']}/versions",
                        {"uri": "s3://m/reset.ts", "duration_ms": 5400000,
                         "frame_map": cfr_map(5400000)}, expect=201)
        _, r = s.call("POST", f"/api/assets/{self.ast['id']}/timelines", {
            "asset_version_id": av3["id"], "note": "时间戳重置,1H重复",
            "segments": [
                {"kind": "content", "media_start_ms": 0, "media_end_ms": 2700000,
                 "frame_start": 0, "frame_end": 67500,
                 "match": {"period": "1H", "clock_start_ms": 0, "clock_end_ms": 2700000}},
                {"kind": "content", "media_start_ms": 2700000, "media_end_ms": 5400000,
                 "frame_start": 67500, "frame_end": 135000, "reset": True,
                 "match": {"period": "1H", "clock_start_ms": 0, "clock_end_ms": 2700000}}]},
            expect=201)
        mine = [x for x in r["relocation"] if x["clip_id"] == cid]
        self.assertEqual(mine[0]["reason"], "ambiguous", "计时重复必须报歧义")
        c = self.clip_of(cid)
        self.assertEqual(c["status"], "conflict")
        self.assertIn("anchor_ambiguous", [i["kind"] for i in c["issues"]])
        # 人工选定第二段(重置后)
        _, rr = s.call("POST", f"/api/clips/{cid}/relocate",
                       {"chosen_in_media_ms": 2700000 + 600000,
                        "chosen_out_media_ms": 2700000 + 660000}, expect=200)
        c = self.clip_of(cid)
        self.assertEqual(c["status"], "ready")
        self.assertEqual(c["in_media_ms"], 3300000)


class TestBrokenLinkAndManifest(Base):
    """验收8: 源下架 -> pinned镜头broken但保留; 任务包含素材身份+版本, 无临时URL。"""
    def test_broken_and_manifest(self):
        s = self.srv
        _, a2 = s.call("POST", "/api/assets", {"name": "将被替换"}, expect=201)
        _, av = s.call("POST", f"/api/assets/{a2['id']}/versions",
                       {"uri": "s3://m/old.ts", "duration_ms": 100000,
                        "frame_map": cfr_map(100000)}, expect=201)
        s.call("POST", f"/api/assets/{a2['id']}/timelines", {
            "asset_version_id": av["id"],
            "segments": [{"kind": "content", "media_start_ms": 0, "media_end_ms": 100000,
                          "frame_start": 0, "frame_end": 2500,
                          "match": {"period": "1H", "clock_start_ms": 0,
                                    "clock_end_ms": 100000}}]}, expect=201)
        _, c = s.call("POST", "/api/clips", {
            "match_id": "M", "asset_id": a2["id"], "name": "旧源镜头",
            "anchor_mode": "pinned", "in_media_ms": 10000, "out_media_ms": 20000},
            expect=201)
        cid = c["id"]
        s.call("POST", f"/api/assets/{a2['id']}/withdraw", {}, expect=200)
        clip = self.clip_of(cid)
        self.assertEqual(clip["status"], "broken")
        self.assertIn("source_withdrawn", [i["kind"] for i in clip["issues"]])
        # 任务包仍可产出(身份记录), 但带下架警告
        _, j = s.call("POST", "/api/jobs",
                      {"clip_id": cid, "idempotency_key": "t8"}, expect=201)
        m = json.loads(s.wait_job(j["id"])["result"])
        self.assertEqual(m["asset"]["asset_id"], a2["id"])
        self.assertEqual(m["asset"]["version"], 1)
        self.assertTrue(m["asset"]["content_sha256"])
        self.assertTrue(m["asset"]["locator"].startswith("asset://"))
        blob = json.dumps(m)
        for bad in ("http://", "https://", "expires=", "signature=", "token="):
            self.assertNotIn(bad, blob.lower(), "任务包禁止临时播放地址")
        self.assertTrue(any("下架" in w for w in m["warnings"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
