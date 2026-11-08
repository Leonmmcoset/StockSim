# 玩家战绩与排行榜 HTTP 契约

所有接口要求已登录且未封禁。沿用现有 `X-Expected-User-Id` 请求头进行身份检查；提供的身份与当前会话不一致时返回 401。成功响应包含当前查看者的 `X-User-Id` 响应头、正文 `userId` 和 `revision`，并使用 `Cache-Control: no-store`。客户端必须按请求身份、当前身份与 revision 校验响应，丢弃旧账号或旧请求结果。

POST 另需 `Content-Type: application/json`、会话的 `X-CSRF-Token`，并受现有同源检查与操作频率限制。错误响应沿用 `{ "error": "说明" }`。所有时间戳字段（除 `createdAt` 外）为游戏内 Unix 毫秒；`createdAt` 为真实注册时间 RFC3339 字符串。金额沿用引擎 Money 的分单位。

## GET /api/profile

仅返回当前玩家，不支持查询其他玩家；URL 中的 `userId` 不会选择目标账号。

```text
{
  userId: string,
  revision: integer,
  username: string,
  createdAt: string,
  leaderboardOptIn: boolean,
  performance: {
    joinedAt: integer,
    equity: integer,
    totalPnl: integer,
    totalReturnPct: number | null,
    recent5: PerformanceWindow,
    drawdown: PerformanceDrawdown,
    points: [{time: integer, dayIndex: integer, equity: integer}],
    fillCount: integer,
    buyFillCount: integer,
    sellFillCount: integer,
    feesPaid: integer,
    bestDay: PerformanceDay | null,
    worstDay: PerformanceDay | null,
    closedDayCount: integer,
    excludedPartialDayCount: integer
  }
}

PerformanceWindow = {
  requestedStartDayIndex: integer, requestedStartAt: integer,
  startAt: integer, endAt: integer, coveredDays: integer,
  complete: boolean, netPnl: integer | null, returnPct: number | null
}
PerformanceDrawdown = {
  startAt: integer, endAt: integer, maxDrawdownPct: number | null,
  retentionDays: integer, compacted: boolean
}
PerformanceDay = {
  dayIndex: integer, date: string, netPnl: integer, returnPct: number | null
}
```

`joinedAt` 表示玩家的游戏内入场时刻。累计收益按初始本金计算。`recent5` 描述含当前游戏日在内的五个游戏日窗口，`complete` 表示记录完整覆盖五日所需起点；不足时仍返回实际覆盖区间的收益，须结合 `startAt`、`coveredDays` 和 `complete` 展示，不能当作完整五日收益参与排名。没有记录或无法计算时相关值为 null。回撤仅对应 `drawdown.startAt` 至 `endAt` 的保留记录覆盖区间，`retentionDays` 给出保留上限，`compacted` 标记区间记录是否已压缩。曲线也只含实际保留记录。最佳与最差交易日仅从完整已收盘日中选择；统计同时给出完整日和被排除的部分交易日数量。成交笔数与累计费用为玩家累计值。

## POST /api/profile/visibility

```json
{ "leaderboardOptIn": true }
```

`leaderboardOptIn` 必须是 boolean；省略、null、其他类型、额外字段均返回 400。不接受目标玩家字段，仅更改当前账号。请求必须附带 8–128 位 `Idempotency-Key`（字符限英文字母、数字、`.`、`_`、`:`、`-`），缺失或格式无效返回 400。

幂等键按玩家隔离，与下单、撤单共用同一存储空间；以请求方法、路径和规范化 JSON 内容识别操作。可见性操作的幂等回执永久保留，之后重用同一键执行不同内容或不同接口始终返回 409，JSON 空白差异不影响识别。即使本次偏好已经等于目标值，也持久记录该操作的幂等键，防止延迟重试在后续操作后反向生效。偏好、实际变更时的市场 runtime revision 和幂等操作回执在同一 SQLite 事务中持久化；失败返回 503，以上内容均不提交。回执仅保存规范化目标值，不重复存储私人战绩曲线。实际变更增加 revision；无变更和成功重放保持当前 revision。下单与撤单自身的幂等记录仍按既有七日窗口保留，其过期清理不会删除可见性操作回执。

首次成功与重放均返回与 GET `/api/profile` 相同结构的完整响应。重放确认原操作已经结清，不再次应用旧操作意图，并返回**读取时当前权威 profile**，因此其偏好与 revision 可能已经反映此后成功的其他操作。响应头 `Idempotency-Replayed` 首次为 `false`，重放为 `true`。例如 A 设置公开、B 设置私密后重放 A，返回当前私密状态，不会再次公开；即使相隔超过七日仍保持此保证。

客户端对写入采用 15 秒超时，发生超时或其他结果不明情况时保留原键、目标值与待确认状态。只可用原键和原目标值重试来确认该操作；单次 GET 返回旧值不足以证明尚未完成的写入不会随后提交。收到原键对应的成功响应才可结清该待确认操作，并按响应中的当前 profile 显示权威可见性；在结清前阻止新的可见性操作。

所有玩家（包含升级前的既有玩家）默认不上榜。偏好存在独立 `player_preferences` 表，缺失记录等同 false。该接口不会把排行榜或战绩数据广播进 SSE。

客户端在发送前将待确认的用户 ID、原始键和目标值写入同标签页 sessionStorage；不保存私人曲线或密码。超时、网络失败、403/429 等未确认响应均保留原意图，禁止单次 GET 将其判定为已结清；仅在同身份收到有效成功确认后重新读取当前状态。页面刷新可恢复同用户待确认操作；退出或身份变化清除它。存储不可用时仍保留当前页面的内存回执。断线时公开状态显示未知、操作禁用。

## GET /api/leaderboard?sortBy=totalReturnPct

`sortBy` 可为 `totalReturnPct`（默认）、`recent5ReturnPct` 或 `maxDrawdownPct`；其他值返回 400。收益率降序、回撤升序。指标不可用或近五日覆盖不完整的玩家排在可排名玩家后，rank 为 null；相同指标采用竞争排名，例如 1、1、3。用稳定内部 ID 字典序打破显示顺序平局（不向客户端输出 ID）。

```text
{
  userId: string,
  revision: integer,
  sortBy: string,
  entries: [{
    username: string,
    rank: integer | null,
    joinedAt: integer,
    totalReturnPct: number | null,
    recent5: {
      requestedStartDayIndex: integer, requestedStartAt: integer,
      startAt: integer, endAt: integer, coveredDays: integer,
      complete: boolean, returnPct: number | null
    },
    drawdown: PerformanceDrawdown
  }]
}
```

只返回主动上榜且未被封禁的玩家，空列表为 `[]`。条目显式限定为昵称、排名、入场时间、收益率和回撤覆盖信息，不返回玩家 ID、资产金额、盈亏金额、持仓、现金、委托、成交明细、费用、私人曲线或引擎存档。查看者自身未上榜时也不会自动插入列表。

客户端在排行榜可见时每 5 秒轮询，并在切换排序、成功更改上榜开关后刷新。退出上榜在服务器提交后立即从任何后续读取结果剔除，其他客户端在下一轮刷新后更新。排行榜不经 SSE 传输。

## 管理员备份

GET `/api/admin/backup` 的外层 `schemaVersion` 升为 2，新增 `playerPreferences: [{ userId: string, leaderboardOptIn: boolean }]`。该数组包含明确保存的偏好；无记录账号仍默认为 false。现有 `users` 与引擎存档结构不因偏好表而改变，备份仅向管理员开放。
