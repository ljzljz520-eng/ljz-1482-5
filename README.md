# 赛事直播切片全栈策划系统

网页预览源视频、标注球员与比分、安排集锦；后台 API 将事件、素材片段、许可写入数据库；
工作器产出给剪辑师的任务包。零依赖（Python 3.11 标准库 + SQLite + 原生 JS）。

```
server/timing.py   三坐标版本化映射(比赛计时/媒体时间/帧位置)
server/db.py       SQLite 模式
server/conform.py  一致性引擎: 重定位/冲突/许可覆盖/文案哈希
server/app.py      HTTP API + 静态站点 + 内嵌工作器
server/worker.py   任务包工作器
server/seed.py     演示数据
web/               单页策划台
tests/             验收测试(9项)
```

运行：

```bash
python3 server/app.py 8077        # 启动
python3 server/seed.py            # 灌演示数据(另开终端)
open http://127.0.0.1:8077        # 策划台
python3 tests/test_acceptance.py  # 验收测试
```

---

## 1. 三坐标版本化映射：禁止一个秒数表示三者

直播源有广告插入、时间戳重置、后期替换，因此三种时间严格分列：

| 坐标 | 表示 | 特点 |
|---|---|---|
| 比赛计时 | `(period, clock_ms)` 如 `("2H", 4023000)` | 每节重置、可订正，是**语义锚点** |
| 媒体时间 | `media_ms`（某素材版本容器内毫秒） | 只对**特定 asset_version** 有意义 |
| 帧位置 | 整数帧号（该版本解码序列） | VFR 下与媒体时间非线性 |

关联靠**时间轴版本**：`timelines(version) → timeline_segments[]`，每段给出
媒体区间 ↔ 帧区间 ↔（仅 content 段）比赛计时线性映射，并标记 `kind=content|ad|gap`
与 `reset`（时间戳重置）。数据库里事件与镜头**同时落三坐标 + 解析所用时间轴版本**，
任何一行都能说清"这个数是哪个坐标系、哪个版本下的值"。

- **广告插入**：`ad` 段无比赛计时映射，事件落不进去（`not_content`）。
- **时间戳重置**：`reset=1` 段使同一比赛计时映射出**多个**媒体位置
  → `match_clock_to_media` 抛 `AmbiguousMap`，绝不静默选一个。
- **VFR**：`asset_versions.frame_map = [[frame, pts_ms]…]`，帧↔毫秒必须查表
  （验收 2 证明：10s 处是帧 150 而非恒定帧率误算的 250）。
- **后期替换**：新 `asset_version` + 新 `timeline` 版本，旧版本保留，旧链接不失忆。

## 2. 固定源片段 vs 引用可更新直播时间轴

镜头有两种锚定模式（`clips.anchor_mode`），系统同时支持以便对比：

| | `pinned` 固定源片段 | `tracking` 跟随可更新时间轴 |
|---|---|---|
| 存储 | asset_version + 媒体/帧区间，钉死 | 比赛计时语义锚点 + 当前解析值 |
| 新时间轴发布 | **不动**；源下架则 `broken` 但保留 | 自动**重定位**到新版本 |
| 优点 | 完全可复现，剪辑师拿到永不漂移 | 广告/断流/替换后仍对准同一比赛时刻 |
| 代价 | 净信号出来后仍指旧广告版 | 映射可能歧义/失败 → 需冲突处理 |

**后补素材如何影响已标注镜头**（`conform.conform_asset`，新 timeline 发布即触发）：

1. tracking 镜头按语义锚点在新版本重解析：
   - 唯一命中 → 更新三坐标，记 `relocations(outcome=relocated)` 审计日志；
     旧问题（如跨断流）随净信号自动消解；
   - 多候选（时间戳重置）→ `anchor_ambiguous` 冲突，镜头转 `conflict`，
     **保留旧解析值**，网页给出候选列表，人工选定（`POST /clips/:id/relocate`
     带 `chosen_*_media_ms`）；
   - 无覆盖（后补素材缺该时段）→ `anchor_unmappable` 冲突。
2. pinned 镜头不动，仅重评问题；源下架 → `source_withdrawn`，状态 `broken`，
   **坏链接保留在列表中**（软删除同理，网页以虚线灰显展示）。

## 3. 比分订正 / 球员标签 → 文案复核

每条文案落 `source_hash` = 关联事件的（类型+比分+球员标签+修订号）的哈希。
`PATCH /events/:id` 改比分或球员 → 所有关联镜头的 `draft/approved` 文案
降级 `needs_review`；**过期文案禁止批准**（409）；导出时
`exportable_copy` 只放行 `approved` 且哈希与当前事件一致的文案——
未批准/待复核文案只进 `warnings`，绝不混进任务包。

## 4. 任务包：可复现，禁止临时播放地址

`worker` 产出的清单（存库 + `data/packages/*.json`）包含：

- **素材身份**：`asset_id`、版本号、内容 SHA-256、稳定定位符
  `asset://<id>@v<n>#<sha256>`（剪辑师据此向素材库调取，不是播放 URL）；
- **三坐标入出点**：每个子段 `in/out = {media_ms, frame, match_clock}` +
  解析所用 `timeline version`；
- **拆分与阻挡**：跨广告/断流自动拆成多个 content 子段，`skipped_ranges` 记录空洞；
  许可未覆盖区间列入 `rights.uncovered`；
- **文案**：仅已批准且哈希有效者；
- 清单全文不含任何 `http(s)://`、签名、过期参数（验收 8 断言）。

## 5. 验收场景对照

| 场景 | 机制 | 测试 |
|---|---|---|
| 镜头跨断流点 | `span_gap` 问题 + 任务包拆子段 + 跳过区间记录 | `TestSpanGap` |
| 源视频变帧率 | `frame_map` 查表换算，边界帧精确 | `TestVFR` |
| 许可只覆盖部分时段 | `license_partial` + `rights.uncovered` 区间 | `TestLicensePartial` |
| 并发裁切 | 幂等键 UNIQUE + 每镜头活动作业部分唯一索引；并发撞键返回同一作业 | `TestConcurrentCrop` |
| 作业完成晚于删除 | 软删除；worker 完成时检测 `deleted_at` → `orphaned` + tombstone 清单，不产正式包、不崩溃 | `TestJobAfterDelete` |
| 比分订正/球员变化 | `source_hash` 失配 → `needs_review`；导出过滤 | `TestScoreCorrection` |
| 后补素材重定位 | 净信号版本 → tracking 自动重定位，pinned 不动 | `TestTimelineUpdate` |
| 时间戳重置歧义 | `anchor_ambiguous` 冲突 + 人工选定候选 | `TestTimelineUpdate` |
| 坏链接保留 | 软删除/下架镜头留在列表，状态与问题可见 | `TestBrokenLinkAndManifest` |
| 不可复现导出禁令 | 清单只含稳定身份定位符，测试断言无 URL/签名 | `TestBrokenLinkAndManifest` |

## 6. API 摘要

```
POST /api/assets                     建素材源
POST /api/assets/:id/versions        注册素材版本(可含VFR帧表) —— 后补素材入口
POST /api/assets/:id/timelines       发布时间轴版本 → 触发全量重定位
POST /api/assets/:id/withdraw        源下架(后期替换)
POST /api/events                     标注事件(三坐标同时落库)
PATCH /api/events/:id                比分订正/球员标签 → 文案打回复核
POST /api/clips                      建镜头(pinned|tracking)
POST /api/clips/:id/delete           软删除(坏链接保留)
POST /api/clips/:id/relocate         重定位/歧义人工选定
POST /api/clips/:id/copy             生成文案   POST /api/copy/:id  批准/拒绝
POST /api/licenses                   许可(可只覆盖部分时段)
POST /api/jobs                       建作业(幂等键)   GET /api/jobs/:id
GET  /api/packages/:id               任务包清单
GET  /api/state                      策划台全量状态
```
