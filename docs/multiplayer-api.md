# 多人 HTTP 契约

所有路由同源 `/api`，JSON 金额为整数分，时间戳为毫秒。认证只使用服务器会话 Cookie，不接受客户端 playerID/role。失败 HTTP 返回 `{error:string,code?:string}`；下单业务拒绝是成功传输的 `{result:{ok:false,error,code},snapshot,market}`。用户 role 为 `admin|user`。

```ts
interface User { id:string; username:string; role:'admin'|'user'; banned:boolean; createdAt:string }
interface MarketMeta { revision:number; running:boolean; speed:1|4|16|64; savedAt:string }
interface SessionResponse { user:User|null; csrfToken:string; registrationOpen:boolean; market:MarketMeta }
interface SnapshotResponse { userId:string; snapshot:MarketSnapshot; market:MarketMeta }
interface CommandResponse extends SnapshotResponse { result:CommandResult }
```

`MarketSnapshot` 与现有 `src/engine/types.ts` 字段相同；普通 snapshot.review.points 固定 `[]`，历史点由 review API 获取。空集合均序列化 `[]`，不返回 null。SSE 与 GET/命令响应采用相同 SnapshotResponse。revision 是保存成功后的单调版本，客户端忽略比已见版本小的快照（含幂等重放响应）。

已发生的外部新闻使用 `kind:'external'`，附加 `event:{category:'policy'|'disaster'|'supply-chain'|'technology',severity:'major'|'extreme'}`。其余沿用新闻时刻、正文、方向、范围和相关证券；普通快照不含事件密钥、未来计划或内部冲击参数。

- GET `/api/session`：SessionResponse，未登录时也分配匿名 CSRF 会话。
- POST `/api/register`、`/api/login`：`{username,password}` -> SessionResponse，设置/旋转 Cookie。用户名 3–24 位 ASCII 字母数字下划线短横，密码 8–128 字节。
- POST `/api/logout`：204，撤销会话并断开订阅。
- GET `/api/snapshot`：SnapshotResponse，登录必需。
- GET `/api/events`：SSE，`event:snapshot` 的 data 为 SnapshotResponse；初连立即给最新快照、15 秒 heartbeat。每会话最多 2 条连接，慢订阅不阻塞市场。
- POST `/api/orders`：OrderInput -> CommandResponse。
- POST `/api/orders/preview`：OrderInput -> OrderPreview（仅估算，服务端下单重新校验）。
- POST `/api/orders/{id}/cancel`：`{}` -> CommandResponse。
- GET `/api/review?range=day&dayIndex=0`，或 `range=5|20|all`：`{userId:string,points:NormalizedEquityPoint[],summary:ReviewPeriodSummary,revision:number}`。没有选择日返回明确错误；收益和回撤由 Go 计算。
- POST `/api/admin/market`：`{action:'pause'|'resume'|'speed'|'skipLunch'|'nextDay',speed?:1|4|16|64}` -> SnapshotResponse。仅管理员可调用，phaseWait 重置要与时间操作一致。
- GET `/api/admin/users`：`{users:User[],registrationOpen:boolean}`。
- POST `/api/admin/users/{id}/ban`：`{banned:boolean}` -> `{users:User[],registrationOpen:boolean}`。禁止禁用任何 admin。旧挂单不撤回，新增请求及会话失效。
- POST `/api/admin/settings`：`{registrationOpen:boolean}` -> `{users:User[],registrationOpen:boolean}`。
- GET `/api/admin/backup`：一致的 JSON 附件，包含引擎、用户密码哈希和运行设置，不包含活动会话/幂等缓存；仅管理员。
- GET `/api/health`：无身份与资产信息的健康检查。

所有 POST 要求 `Content-Type: application/json` 和 `X-CSRF-Token`；Origin 必须同源，非浏览器无 Origin 时仍须有效 CSRF。body <=16KiB，拒绝未知字段和尾随数据。下单与撤单还须 8–128 字符 `Idempotency-Key`，7 日内同用户同 key/相同规范化方法路径参数仅执行一次，输入不同返回 409；超时请保留同 key，不要新建 key 自动重发。

成功认证的 HTTP 响应带 `X-User-Id`，客户端接收私有响应前核对当前身份；SSE 的每个 snapshot 和 review JSON 另外携带 `userId`。已登录客户端请求还发送 `X-Expected-User-Id`；服务端在业务操作前核对 Cookie 身份，错配返回 401 且不撤销当前 Cookie。跨标签页切换账号后，旧页面先清理私有状态、草稿与旧请求，再重新获取 session。

开发 Vite 代理后端默认 `http://127.0.0.1:8080`；生产 Go 静态服务 dist 与 API 同源。Cookie/CSRF 不写 localStorage，浏览器仅保存证券选择、自选及显示偏好。server bind/public origin/secure cookie/DB/static dir 用环境配置，具体命令见最终 README。
