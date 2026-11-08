# 玩家排行榜与个人战绩实现计划

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 逐任务实施；根代理汇总验证与提交。

**目标：** 增加默认私密、可自愿上榜的个人战绩与服务器排行榜。

**架构：** Go 引擎只读计算指标，App 事务保存可见性并裁剪公共 DTO，React 请求服务器数据。复用当前工作区与黑色终端，不另起 UI 风格。

**技术栈：** Go、SQLite、React、TypeScript、ECharts、Vitest。

**规格：** `docs/superpowers/specs/2026-11-08-player-stats-design.md`

## 全局约束

- 引擎算法限 Astra；其余代理使用 Sol/Terra。
- 每个功能单独提交；不改变行情 RNG、撮合或引擎 schema 5。
- 默认本金 500000 分，默认不上榜；公共 DTO 不含私人金额或交易。

## 审查重点

- 新玩家与不完整 5 日窗口：覆盖信息准确、无伪造收益及名次。
- 超过保留期及成交列表被截断：累计计数仍准确，回撤不冒充全历史。
- 可见性事务失败/重启：偏好与 revision 一致，旧账户保持私密。
- 退出/封禁/身份切换：服务端过滤且旧请求不能恢复私人数据。
- 断网与隐私 POST 超时：不把未知结果当作成功，旧榜单及时清理。

### 任务 1：只读统计与排序（Astra）

文件：`server/internal/market/performance.go`、`performance_test.go`、`docs/player-performance-model.md`。

- [x] 为本金、短历史、完整窗口、计数截断、回撤范围、并列/空值排名、只读性编写失败测试。
- [x] 实现 `PlayerPerformance(id)` 与 `RankPlayers(participantIDs, sortBy)`，显式区分公共和私人字段。
- [x] 运行定向 Go 测试与市场回归，审查后提交算法功能。

### 任务 2：认证接口与隐私（Sol）

文件：`server/internal/app/store.go`、`http.go`、新增统计文件与测试、`docs/player-stats-api.md`。

- [x] 先测默认空榜、选择/退出/封禁、旧库/重启、CSRF/身份隔离、SQL 失败回滚、备份。
- [x] 实现 `GET /api/profile`、`GET /api/leaderboard` 与 `POST /api/profile/visibility`，严格裁剪公共字段。
- [x] 运行 App 测试与 vet，审查后提交接口功能。

### 任务 3：战绩工作区（Terra）

文件：`src/components/PlayerPerformance*`、`src/lib` 类型、`src/store/game.ts`、`src/App.tsx`、`AccountPanel.tsx`、样式与相关测试。

- [x] 验证身份变化、过期 GET、隐私提交超时与断线等状态边界。
- [x] 实现本人战绩、三种榜单排序与明确选择的上榜开关，每 5 秒刷新。
- [x] 运行 Vitest 与 TypeScript/Vite build，审查后提交界面功能。

### 任务 4：整体验证与交付（根代理）

文件：`scripts/check-player-stats.mjs`、验证记录、README；保留现有存档。

- [x] 原生 Go 进程和临时 DB 验证两玩家、真成交统计、私密字段、偏好退出/重启/封禁。
- [x] 运行完整 Go 测试、race、vet、Vitest、build、已有多人 HTTP 检查与新检查。
- [x] CUA 验证桌面及手机显示、开关、切换与草稿保留；独立最终审查。
- [x] 分功能提交、合并推送；重启本地服务以保留原 DB 运行新版。

## 裁定

- Ruling: 继续使用当前共享检出并建立 `codex/player-stats` 分支 — 用户已批准开工且代理共享路径，避免重复实现与路径失配。
- Ruling: 近 5 日不完整时保留实际收益展示但不参与该项排名 — 避免把部分周期冒充完整 5 日。
- Ruling: 偏好变更不发送额外 SSE 事件，在线榜单 5 秒刷新 — 服务端即时过滤，沿用现有轮询与身份保护。

- Ruling: visibility 的小型幂等回执永久保留 — 避免超过订单七日窗口的旧标签页重新公开；两处订单清理均排除该回执，订单自身七日规则不变。
