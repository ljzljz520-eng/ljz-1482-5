# 赛事直播切片全栈策划系统

一个用于**赛事直播源策划、标注与集锦编排**的全栈系统：

- **网页端**：预览源视频（帧精确合成时码器）、在时间轴上标注球员/比分、编排集锦 rundown、复核标题、下发裁切作业、查看剪辑师任务包；
- **后台 API**：把比赛、素材、时间轴版本、事件、比分/标签订正、镜头、许可、作业写入持久化数据库（零依赖 JSON 文档库，原子写、带 rev）；
- **工作器**：把作业输出为**剪辑师实际任务包**（`manifest.json` + `README.txt`），含帧入出点、素材身份与版本、sha256、缺口与许可，全部可复现——**绝不只给一组临时播放地址**。

## 运行

```bash
npm start                 # API + 网页，http://localhost:4173（首次启动自动播种）
# 另开一个终端（工作器是独立微服务，与 API 共享同一 DATA_DIR 卷/目录）：
npm run worker            # 持续轮询；或 npm run worker:once 处理完退出
npm test                  # 14 项验收测试（node:test）
npm run reset             # 重新播种
```

> 工作器与 API 是两个进程，默认都读写 `./data`；容器化时把同一数据卷挂到两者。
> 也可直接用 `POST /api/jobs/run` 在 API 进程内同步排空队列（同一套 `processOne` 逻辑）。

> 沙箱无 ffmpeg/编译工具链，故播放器用 **Canvas 合成时码画面**（显示真实帧号/PTS、VFR 抖动与断流空洞），
> 素材以带 sha256 的占位文件（`.mfv`）落盘，其中备机文件故意缺失以演示“坏链接保留”。
> 接入真实 MP4 时只需把 `fileUri` 指向真实文件，帧↔PTS 模型用真实容器时基替换 `framePtsUs` 即可，API/包结构不变。

## 核心不变量：三个时间量，三套坐标

系统**从不用一个秒数同时表示**下面三者：

| 坐标 | 单位 | 含义 | 随什么变化 |
|---|---|---|---|
| **gameMs** 比赛计时 | 毫秒 | 相对开赛的比赛时钟（走表/停表） | 广告期间冻结；断流不重置比赛；订正只改事件不改时钟 |
| **mediaUs** 时间轴媒体时间 | 微秒 | 相对**时间轴版本**起点 | 广告插入、时间戳重置、后期替换后会不连续/重排 |
| **frame** 帧位置 | 整数帧号 | **素材版本**内的帧 | VFR 下帧间隔不恒定，帧号↔PTS 非线性 |

映射全部带版本，分两跳：

```
gameMs  ──clockSegments(timelineVersion)──▶  mediaUs
mediaUs ──segments(timelineVersion)────────▶  srcPtsUs(materialVersion)
srcPtsUs ──VFR PTS 模型(materialVersion)───▶ frame
```

- `server/time_model.js`：`mediaToGame / gameToMedia / tlToMaterial / materialToTl / mediaToFrame / frameToMedia`
- VFR：`p(f)=f·base + base·amp·period/2π·(1−cos(2πf/period))`，帧间隔在 base·(1±amp) 间周期变化、严格单调；
  整数周期后偏移归零，平均帧率=标称帧率；另有 `vfrDropFrames` 模拟断流 PTS 空洞。任意 PTS 请求吸附到最近帧并记录 `snapErrorUs`。

## 版本化时间轴（种子里四个版本，覆盖全部直播事故）

| 版本 | 情形 |
|---|---|
| **v1 直播原始版** | 0–10′ 节目 → **10–15′ 广告插入**（`gap/advertisement`）→ 15–50′ 节目，**断流恢复后源 PTS 被重置**（第二段 `tlStart=15′` 但 `srcStart=10′`，连续性由映射声明，绝不假定） |
| **v2 精编生产版（当前生产）** | 广告被 **B-roll 回放替换**（10–12′，比赛计时冻结）；跨广告镜头自动**重定位**为“节目+回放+节目”3 个 piece |
| **v3 权利抽片版** | 25′–31′ 节目源被权利方撤回（`gap/rights`，比赛计时照走）；该区域镜头变冲突，**不静默丢画面** |
| **v4 备机叠加版** | 后期回传的备机角度放在片尾，标签为 9′–10′ 比赛计时，与主机位**覆盖同一比赛计时** → 映射歧义 `ambiguous_clock_mapping`，返回多个候选位置要求人工选择 |

## 固定源镜头 vs 可更新直播时间轴

- **直播镜头（binding=live）** 只绑定**比赛计时窗口**。出新时间轴版本时经 `resolveLiveClip` 重定位：
  - 成功：`relocated`（如广告→回放替换）；
  - 歧义：`conflict_needs_choice`，给出每个计时点的全部媒体候选；
  - 落入缺口：`conflict` + `gapPieces`（ad/rights/break），跨断流点镜头被拆成多个 piece，缺口显式列出，剪辑师不得跨缺口静默拼接。
  - 差异分析：`GET /api/clips/:id/diff?from=v1&to=v2`。
- **固定源镜头（binding=fixed）** 绑定 **materialVersion + 整数帧号**（再经 VFR 映射得 PTS），时间轴改版不漂移；
  它在当前时间轴上的位置只是“引用坐标”。支持帧级修剪（拒绝非整数帧）。源文件失联时镜头**保留**并挂 `broken_media_link`。

## 比分订正 / 球员标签变化 → 标题复核

- 比分、球员标签是**带订正链的事实**（`supersedes…Id`，旧记录打 `superseded` 而非删除）。
- 标题带 `depsSnapshot`（依赖的比分/球员）与 `anchorGameMs`。`server/reconcile.js` 在订正落库时增量复核：
  命中的 **approved → review_required**（记录原因）；`POST /api/titles/:id/approve` 会先核对事实，事实已变则拒绝批准。
- 导出闸门：任务包里**只有 approved 标题给文案，其余一律 text=null**，`unapproved_titles` 直接阻塞出片。

## 许可（可只覆盖部分时段）

许可按 **materialVersion + 帧区间 + 生效期 + 地域**授予。镜头逐 piece 判定：任一 piece 未被覆盖，
`licensing.fullyLicensed=false`，整镜 `license_gap` 阻塞（可拆条后仅导出已覆盖部分）。种子中主机位许可到帧 77988（约 43′20″），
44′ 反击镜头落缺口；44′40″ 扑救另有一个只盖 80388–80837 帧的短许可。

## 并发裁切 / 作业晚于删除

- 入队支持 `Idempotency-Key`（或 body.idempotencyKey）：同键并发只产生一个作业，第二次返回 `reused=true`。
- 删除镜头是**软删除（墓碑）**。若作业完成时镜头已删，工作器产出 `status=tombstone` 包：不裁任何素材、无临时地址，
  说明“完成晚于删除”。网页 rundown 同时保留墓碑行。

## 任务包长什么样

`data/packages/<jobId>/manifest.json`（节选 ready 包）：

```json
{
  "schema": "cut-task-package/v1",
  "status": "ready",
  "timelineVersion": { "id": "timelineVersion_0012", "version": 2 },
  "pieces": [{
    "materialId": "material_0002", "materialVersionId": "materialVersion_0006",
    "fileUri": "media/main-cam-v1.mfv", "fileSha256": "a435…",
    "in":  { "frame": 17100, "srcPtsUs": 570000000, "timelineMediaUs": 570000000, "gameMs": 570000 },
    "out": { "frame": 18000, "srcPtsUs": 600000000, "timelineMediaUs": 600000000, "gameMs": 600000 },
    "fpsNominal": 30, "vfr": true, "fileAvailable": true
  }],
  "gaps": [], "licensing": { "fullyLicensed": true },
  "titles": [{ "text": "广告回来 比赛继续", "status": "approved", "includeInExport": true }],
  "export": { "mayRender": true, "rules": ["…以 materialId+materialVersionId+frameIn/frameOut+sha256 复现，不接受临时播放地址"] }
}
```

`fileUri` 是**归档相对路径**（配 sha256 校验），不是会过期的签名/临时播放 URL。

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state?tv=<timelineVersionId>` | 全量读模型（含每镜头在所选版本上的解析） |
| GET | `/api/probe?tv=…&mediaUs=…` | 三坐标探针：同时返回 gameMs / 素材身份+帧 / 缺口 |
| GET | `/api/clips/:id/resolution?tv=…` | 单镜头在某版本解析 |
| GET | `/api/clips/:id/diff?from=…&to=…` | 后补素材影响：relocated / conflict / unchanged |
| POST | `/api/clips` | 建直播镜头（gameInMs/gameOutMs）或固定镜头（materialVersionId+帧） |
| PATCH | `/api/clips/:id/trim` · `DELETE /api/clips/:id` | 固定镜头帧修剪（校验整数帧）· 软删除墓碑 |
| POST | `/api/titles` · `POST /api/titles/:id/approve` | 加标题（默认待审）· 批准前核对事实 |
| POST | `/api/corrections/score` · `/api/corrections/player-tag` | 订正并增量触发标题复核 |
| POST | `/api/jobs`（支持 Idempotency-Key）· `/api/jobs/run` · `/api/jobs/:id/run` | 入队/工作器处理 |
| GET | `/api/packages/:id/manifest.json` · `/data/packages/:id/README.txt` | 任务包产物 |
| POST | `/api/admin/reset` | 重新播种 |

## 验收对照（`npm test`）

1. 三坐标分离且版本化映射；2. 镜头跨断流/广告点拆 piece+gap；3. 源时间戳重置按重锚声明；
4. VFR 帧间隔非恒定、吸附误差留痕；5. 后补素材重定位/歧义冲突；6. 权利缺口保留镜头；
7. 许可部分覆盖即阻塞；8. 固定镜头不漂移+坏链接保留；9. 订正触发标题复核；
10. 未批准文案不入导出且无临时地址；11. 幂等并发；12. 作业晚于删除→tombstone；
13. ready 包帧/身份/版本/sha 可复现；14. 网页模型保留坏链接与无法定位片段。

## 目录

```
server/  store.js(文档库) time_model.js(三坐标映射) reconcile.js(标题复核)
         seed.js(四个版本的演示数据) worker.js(任务包) api.js server.js
public/  index.html styles.css app.js(合成时码播放器+rundown+订正/作业 UI)
test/    acceptance.test.js
data/    db.json  media/  packages/<jobId>/{manifest.json,README.txt}
```
