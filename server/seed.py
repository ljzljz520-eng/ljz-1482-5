"""seed.py — 演示数据: 直播源(含广告/断流)、VFR机位、球员、事件、镜头、许可、文案。
用法: 先启动 app.py, 再 python3 server/seed.py [base_url]"""
import json, sys, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8077"
MATCH = "M2026-10-03"


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def cfr_map(duration_ms, fps=25):
    step = 10000  # 每10秒一个采样点
    return [[int(i * fps * step / 1000), i * step]
            for i in range(duration_ms // step + 1)]


def main():
    # 球员
    con = None
    import sqlite3, os
    dbp = os.environ.get("CLIP_DB", os.path.join(os.path.dirname(BASE) and "." or ".", ""))
    # 直接走 API 没有球员接口, 用种子SQL
    import subprocess
    print("players via sqlite:", os.environ.get("CLIP_DB", "data/clips.db"))

    # 素材A: 直播源 (CFR 25fps, 2h)
    astA = call("POST", "/api/assets", {"name": "直播源A-主机位", "kind": "live"})["id"]
    avA1 = call("POST", f"/api/assets/{astA}/versions", {
        "uri": "s3://media/liveA/20261003-1900.ts", "duration_ms": 6120000,
        "fps_type": "cfr", "frame_map": cfr_map(6120000)})
    # 素材B: 机位B VFR
    astB = call("POST", "/api/assets", {"name": "机位B-战术机位(VFR)", "kind": "live"})["id"]
    vfr = [[0, 0], [100, 5000], [150, 10000], [400, 25000], [500, 40000],
           [900, 60000], [1000, 85000], [1600, 120000]]
    avB1 = call("POST", f"/api/assets/{astB}/versions", {
        "uri": "s3://media/camB/20261003-vfr.mkv", "duration_ms": 120000,
        "fps_type": "vfr", "frame_map": vfr})

    # 时间轴v1: 内容/广告/内容/断流/加时
    tl1 = call("POST", f"/api/assets/{astA}/timelines", {
        "asset_version_id": avA1["id"], "note": "直播原始时间轴(含广告与断流)",
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
             "match": {"period": "ET1", "clock_start_ms": 0, "clock_end_ms": 600000}},
        ]})
    call("POST", f"/api/assets/{astB}/timelines", {
        "asset_version_id": avB1["id"], "note": "B机位VFR",
        "segments": [{"kind": "content", "media_start_ms": 0, "media_end_ms": 120000,
                      "frame_start": 0, "frame_end": 1600,
                      "match": {"period": "1H", "clock_start_ms": 1140000,
                                "clock_end_ms": 1260000}}]})

    # 球员直接写库(演示)
    import sqlite3
    dbfile = os.environ.get("CLIP_DB", os.path.join(os.path.dirname(__file__), "..", "data", "clips.db"))
    con = sqlite3.connect(dbfile)
    con.executemany("INSERT OR REPLACE INTO players VALUES(?,?,?,?)", [
        ("p_zs", "张三", "测试FC", 9), ("p_ls", "李四", "测试FC", 7),
        ("p_ww", "王五", "示例联", 4)])
    con.commit(); con.close()

    # 事件: 进球(比分快照) + 机会
    ev1 = call("POST", "/api/events", {
        "match_id": MATCH, "asset_id": astA, "at_period": "1H", "at_clock_ms": 1200000,
        "type": "goal", "team": "测试FC", "score_home": 1, "score_away": 0,
        "players": [{"player_id": "p_zs", "role": "actor"}]})["id"]
    ev2 = call("POST", "/api/events", {
        "match_id": MATCH, "asset_id": astA, "at_period": "2H", "at_clock_ms": 600000,
        "type": "goal", "team": "测试FC", "score_home": 2, "score_away": 0,
        "players": [{"player_id": "p_ls", "role": "actor"},
                    {"player_id": "p_zs", "role": "assist"}]})["id"]
    ev3 = call("POST", "/api/events", {
        "match_id": MATCH, "asset_id": astA, "at_period": "ET1", "at_clock_ms": 300000,
        "type": "chance", "team": "示例联", "score_home": 2, "score_away": 0,
        "players": [{"player_id": "p_ww", "role": "actor"}]})["id"]

    # 镜头
    c1 = call("POST", "/api/clips", {
        "match_id": MATCH, "asset_id": astA, "name": "张三首开纪录",
        "anchor_mode": "tracking",
        "in_period": "1H", "in_clock_ms": 1170000,
        "out_period": "1H", "out_clock_ms": 1230000, "event_ids": [ev1]})["id"]
    c2 = call("POST", "/api/clips", {
        "match_id": MATCH, "asset_id": astA, "name": "李四破门(许可未覆盖)",
        "anchor_mode": "tracking",
        "in_period": "2H", "in_clock_ms": 570000,
        "out_period": "2H", "out_clock_ms": 630000, "event_ids": [ev2]})["id"]
    c3 = call("POST", "/api/clips", {
        "match_id": MATCH, "asset_id": astA, "name": "跨断流点镜头",
        "anchor_mode": "tracking",
        "in_period": "2H", "in_clock_ms": 2670000,
        "out_period": "ET1", "out_clock_ms": 30000, "event_ids": [ev3]})["id"]
    c4 = call("POST", "/api/clips", {
        "match_id": MATCH, "asset_id": astA, "name": "固定源片段(pinned)",
        "anchor_mode": "pinned",
        "in_media_ms": 1190000, "out_media_ms": 1210000, "event_ids": [ev1]})["id"]
    c5 = call("POST", "/api/clips", {
        "match_id": MATCH, "asset_id": astB, "name": "VFR机位-张三触球",
        "anchor_mode": "tracking",
        "in_period": "1H", "in_clock_ms": 1190000,
        "out_period": "1H", "out_clock_ms": 1210000, "event_ids": [ev1]})["id"]

    # 许可只覆盖部分时段: 0..50min 与 83:20..结束
    call("POST", "/api/licenses", {
        "asset_id": astA, "media_start_ms": 0, "media_end_ms": 3000000,
        "rights": "highlight"})
    call("POST", "/api/licenses", {
        "asset_id": astA, "media_start_ms": 5000000, "media_end_ms": 6120000,
        "rights": "highlight"})
    call("POST", "/api/licenses", {
        "asset_id": astB, "media_start_ms": 0, "media_end_ms": 120000,
        "rights": "highlight"})

    # 文案: 生成并批准一条; 另一条留 draft
    cp1 = call("POST", f"/api/clips/{c1}/copy", {})
    call("POST", f"/api/copy/{cp1['id']}", {"action": "approve", "by": "主编"})
    call("POST", f"/api/clips/{c2}/copy", {})

    print(json.dumps({"assetA": astA, "assetB": astB, "timeline_v1": tl1["id"],
                      "events": [ev1, ev2, ev3],
                      "clips": {"c1": c1, "c2": c2, "c3": c3, "c4": c4, "c5": c5}},
                     ensure_ascii=False, indent=2))
    print("seed done ->", BASE)


if __name__ == "__main__":
    main()
