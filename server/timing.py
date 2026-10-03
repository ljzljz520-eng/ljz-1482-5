"""
timing.py — 版本化时间轴映射核心。

三条时间线严格分离，禁止用一个秒数混用：
  - 比赛计时 match clock : (period, clock_ms)，如 ("2H", 67*60_000)。每节重置，可被订正。
  - 媒体时间 media time  : 某一素材版本(asset_version)容器内的毫秒位置。
  - 帧位置   frame pos   : 该素材版本解码序列中的整数帧号。

一个 timeline 版本 = 有序 segment 列表。segment 类型:
  content : 比赛内容，可携带 match 线性映射 (period, clock_start_ms -> clock_end_ms)
  ad      : 广告插入，无比赛计时映射
  gap     : 断流/信号丢失，无映射
segment.reset=True 表示该段起点发生了时间戳重置(媒体时间戳回跳)，
因此同一比赛计时可能映射到多个媒体位置 -> 重定位时必须报歧义冲突。

VFR 素材: asset_version 携带 frame_map = [[frame, pts_ms], ...]，
帧<->媒体毫秒必须查表，不得假定恒定帧率。
"""
from bisect import bisect_right


class MapError(Exception):
    """映射失败：位置落在广告/断流/范围外。"""
    def __init__(self, reason, detail=""):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


class AmbiguousMap(Exception):
    """比赛计时映射到多个媒体位置（时间戳重置导致重复）。"""
    def __init__(self, candidates):
        super().__init__(f"ambiguous: {len(candidates)} candidates")
        self.candidates = candidates


# ---------- VFR 帧表 ----------

def frame_to_ms(frame_map, frame):
    """帧号 -> 媒体毫秒。frame_map: 按帧号升序的 [[frame, pts_ms], ...]"""
    if not frame_map:
        raise MapError("no_frame_map")
    frames = [f for f, _ in frame_map]
    i = bisect_right(frames, frame) - 1
    if i < 0:
        raise MapError("frame_before_start", f"frame={frame}")
    if i + 1 < len(frame_map):
        f0, t0 = frame_map[i]
        f1, t1 = frame_map[i + 1]
        # 相邻两帧线性插值（仅用于段内估计；边界帧精确）
        if frame == f0:
            return t0
        frac = (frame - f0) / max(1, (f1 - f0))
        return t0 + frac * (t1 - t0)
    return frame_map[i][1]


def ms_to_frame(frame_map, ms):
    """媒体毫秒 -> 帧号（向下取整到最近已知帧）。"""
    if not frame_map:
        raise MapError("no_frame_map")
    pts = [t for _, t in frame_map]
    i = bisect_right(pts, ms) - 1
    if i < 0:
        raise MapError("ms_before_start", f"ms={ms}")
    if i + 1 < len(frame_map):
        f0, t0 = frame_map[i]
        f1, t1 = frame_map[i + 1]
        if ms == t0:
            return f0
        frac = (ms - t0) / max(1e-9, (t1 - t0))
        return int(f0 + frac * (f1 - f0))
    return frame_map[i][0]


# ---------- timeline segment 查询 ----------

def segment_at_media(segments, media_ms):
    """找到包含 media_ms 的 segment（左闭右开，末段右闭）。"""
    for s in segments:
        lo, hi = s["media_start_ms"], s["media_end_ms"]
        if lo <= media_ms < hi or (s is segments[-1] and media_ms == hi):
            return s
    return None


def media_to_frame(timeline_segments, frame_map, media_ms):
    seg = segment_at_media(timeline_segments, media_ms)
    if seg is None:
        raise MapError("media_out_of_range", f"media_ms={media_ms}")
    # 段内偏移换算为帧：优先查 VFR 帧表，帧表缺失时退化为段内线性
    try:
        return ms_to_frame(frame_map, media_ms)
    except MapError:
        dur = seg["media_end_ms"] - seg["media_start_ms"]
        frames = seg["frame_end"] - seg["frame_start"]
        frac = (media_ms - seg["media_start_ms"]) / max(1, dur)
        return seg["frame_start"] + int(frac * frames)


def frame_to_media(timeline_segments, frame_map, frame):
    try:
        ms = frame_to_ms(frame_map, frame)
        return ms
    except MapError:
        for s in timeline_segments:
            if s["frame_start"] <= frame <= s["frame_end"]:
                dur = s["media_end_ms"] - s["media_start_ms"]
                frames = max(1, s["frame_end"] - s["frame_start"])
                frac = (frame - s["frame_start"]) / frames
                return s["media_start_ms"] + frac * dur
        raise MapError("frame_out_of_range", f"frame={frame}")


def media_to_match_clock(timeline_segments, media_ms):
    """媒体毫秒 -> (period, clock_ms)。广告/断流段无映射 -> MapError。"""
    seg = segment_at_media(timeline_segments, media_ms)
    if seg is None:
        raise MapError("media_out_of_range", f"media_ms={media_ms}")
    if seg["kind"] != "content" or not seg.get("match"):
        raise MapError("not_content", f"media_ms={media_ms} in {seg['kind']}")
    m = seg["match"]
    dur = seg["media_end_ms"] - seg["media_start_ms"]
    frac = (media_ms - seg["media_start_ms"]) / max(1, dur)
    clock = m["clock_start_ms"] + frac * (m["clock_end_ms"] - m["clock_start_ms"])
    return m["period"], int(clock)


def match_clock_to_media(timeline_segments, period, clock_ms):
    """比赛计时 -> 媒体毫秒列表。时间戳重置可能产生多个候选 -> AmbiguousMap。"""
    hits = []
    for s in timeline_segments:
        if s["kind"] != "content" or not s.get("match"):
            continue
        m = s["match"]
        if m["period"] != period:
            continue
        lo, hi = min(m["clock_start_ms"], m["clock_end_ms"]), max(m["clock_start_ms"], m["clock_end_ms"])
        if lo <= clock_ms <= hi:
            span = m["clock_end_ms"] - m["clock_start_ms"]
            frac = 0.0 if span == 0 else (clock_ms - m["clock_start_ms"]) / span
            ms = s["media_start_ms"] + frac * (s["media_end_ms"] - s["media_start_ms"])
            hits.append({"media_ms": int(ms), "segment_seq": s["seq"], "reset": bool(s.get("reset"))})
    if not hits:
        raise MapError("clock_not_covered", f"{period} {clock_ms}ms")
    if len(hits) > 1:
        raise AmbiguousMap(hits)
    return hits[0]


def split_by_content(timeline_segments, in_ms, out_ms):
    """把 [in_ms, out_ms] 切成子段：跨广告/断流时拆成多段 content 子段。
    返回 (content_parts, skipped_parts)。用于跨断流点镜头的任务包拆分。"""
    content, skipped = [], []
    cur = in_ms
    while cur < out_ms:
        seg = segment_at_media(timeline_segments, cur)
        if seg is None:
            skipped.append({"kind": "out_of_range", "in_ms": cur, "out_ms": out_ms})
            break
        nxt = min(out_ms, seg["media_end_ms"])
        part = {"kind": seg["kind"], "in_ms": cur, "out_ms": nxt, "segment_seq": seg["seq"]}
        (content if seg["kind"] == "content" else skipped).append(part)
        cur = nxt
    return content, skipped


def fmt_clock(period, clock_ms):
    m, s = divmod(int(clock_ms) // 1000, 60)
    return f"{period} {m:02d}:{s:02d}"
