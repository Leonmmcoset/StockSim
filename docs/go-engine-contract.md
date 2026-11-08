# Go 共享市场引擎接口

状态：2026-11-08 已实现多人 Go 引擎，接口已与 HTTP 服务接入。算法迁移由 GPT-6 Astra 承担。多人阶段已完成；稀有外部事件规则及验证见 `docs/external-events-model.md`。

## 已确认边界

- 全服只有一个订单簿、行情、新闻流、公司财报状态和模拟时钟。不同玩家可以直接成交。
- 每个注册账户首次获得 500000 分，独立持仓、冻结、委托、成交和复盘；管理员在市场账本中也是普通玩家。
- 市场计算、费用、账户结算、财报、投资复盘和权威存档均使用 Go；不使用 Node worker。
- 使用独立游戏时间，默认 1×：现实一秒推进 30 模拟秒。管理员可设 1/4/16/64×、暂停恢复、跳午休和次日。初始 2026-11-09 09:35，日历沿用周一至周五。
- 服务器自动衔接午休及下一交易日；进程停止不补算。running、speed、等待衔接进度由服务端保存，算法包不读取现实时间。
- 公开 JSON 沿用当前 `src/engine/types.ts` 的字段和分/股/百分比点单位。内部状态与公开快照分开，客户端不能获取 RNG、NPC 钱包、隐藏估值或其他玩家私有信息。

## 冻结 Go 接口

包导入路径：`stocksim/server/internal/market`，源码目录 `server/internal/market`。

```go
type Options struct {
    Seed string
    HistoryDays *int          // nil=60，指向0=关闭背景历史
    EventSeed string         // 仅Go确定性测试/离线假数据；生产留空使用crypto/rand私有密钥
    EventMeanDays int64       // 0默认100；仅Go配置，不对HTTP开放
    DisableEvents bool       // reference回归测试明确关闭事件
}

func New(options Options) (*Engine, error)
func Restore(data []byte) (*Engine, error)
func (e *Engine) Clone() (*Engine, error)
func (e *Engine) Export() ([]byte, error)
func (e *Engine) AddPlayer(playerID string) error
func (e *Engine) PlayerIDs() []string
func (e *Engine) Clock() MarketClock
func (e *Engine) Snapshot(playerID string) (MarketSnapshot, error)
func (e *Engine) PlaceOrder(playerID string, input OrderInput) CommandResult
func (e *Engine) PreviewOrder(playerID string, input OrderInput) (OrderPreview, error)
func (e *Engine) CancelOrder(playerID, orderID string) CommandResult
func (e *Engine) Step(ticks int) error
func (e *Engine) SkipLunch()
func (e *Engine) NextDay()
```

`New` 不添加玩家，先完成原有 10 tick 的 NPC 开盘预热。`AddPlayer` 固定发放 500000 分，无外部可配置本金参数。`PlayerIDs` 按加入顺序返回隔离 slice。快照的 `MarketSnapshot`、`MarketClock`、`OrderInput`、`CommandResult`、`OrderPreview` 字段与 TS 公共契约相同，Go 字段为 PascalCase，JSON 标签为原 lowerCamelCase；未知玩家操作明确失败。

`Step` 对 0 至 10000 整数有效，遇午休或收盘停止。`SkipLunch` 仅在午休推进到 13:00，其余无副作用。`NextDay` 与旧引擎一致：先完成当日剩余交易（已有委托可能成交），清理当日单后推进下一工作日 09:30；不得仅改日期跳过清算。权限与自动衔接计时均由服务器负责。

引擎无内部并发锁；服务器在同一 owner mutex 下 Clone → mutate → SQLite commit → swap。`Clone` 深复制已可信运行状态，可以绕过完整外部存档校验；`Restore` 必须完整校验。`Export` 输出内部 schema 5 JSON，不能发送给普通玩家。

复盘区间选择由 Go `GetReview(playerID string, period ReviewPeriod) (ReviewSelection, error)` 提供。`ReviewPeriod{Kind string, Days int, DayIndex int64}` 中 Kind 为 `all`、`recent`、`day`；`recent` 使用正数 Days，`day` 使用 DayIndex。返回 `ReviewSelection{Points []NormalizedEquityPoint, Summary ReviewPeriodSummary}`。收益、同期基准、超额收益与观察回撤全部在 Go 计算。HTTP 普通快照将 `review.points` 投影为空数组，完整曲线只通过 `/api/review` 请求。

## 内部状态拆分

原单机状态中的 `initialCash`、`realizedPnl`、`playerFees`、`playerOrderIds`、`trades`、`review` 移入 `PlayerState`，以外部稳定玩家 ID 索引。`PlayerState` 指向一个内部 wallet owner 索引。NPC 与所有玩家共用钱包和撮合账本。

所有原 `owner == 0` 判断改为显式玩家归属判定：玩家委托保留历史、当日有效、不执行 NPC 单量裁剪和短期过期；NPC 完结委托可删除。人对人成交两边分别生成私有成交记录、累计费用、已实现盈亏和复盘计数。撤单先检查请求玩家是否拥有该单，拒绝时不泄露其他玩家订单内容。

新增玩家只创建空仓钱包并向全市场注册资本增加 500000 分；不消耗市场或公司 RNG，不改变行情和已有玩家账户。重复 `AddPlayer` 必须失败且无副作用，不能再次发钱。实际身份认证、用户名、密码、admin 权限不进入市场算法包。

## 保留的算法行为

- 12 股票、每股 48 NPC；单一价格/时间优先簿、既有对手价成交、真实库存和预算约束、自成交预防。
- T+1、100 股买入、零股一次卖出、涨跌停、连续竞价价格笼子、14:57–15:00 收盘集合竞价与禁止撤单、当日单到期释放。
- 佣金按同一委托累计成交额计算增量，最低 500 分只收一次；买入预留未成交金额及剩余费用，卖出按精确剩余成本比例分摊。
- 价格仅由成交决定；保留现有异质代理、宏观/行业共同因素、普通新闻及财报信念冲击，不引入新外部事件参数。
- 公司独立 RNG，初始四期合成报告、最多 24 期披露、10:00 错峰且五交易日一报；未来计划仅公开预期，公告不修改成交价或交易钱包。
- 每玩家真实入场点、30 秒和本人逐笔成交观察、30 日复盘、1024 点/日和15000 点/人的确定性抽稀、最大观察回撤锚点保留。

多人额外估值要求：一个玩家主动委托可能改变其他持仓玩家的资产。每个外部委托操作结束时须更新所有玩家的当前估值观察，参与成交方仍逐笔记 fill；否则保存时其他玩家复盘末点可能与当前行情不一致。正常 NPC tick 在 tick 末统一记录所有玩家。新增玩家在休市阶段加入时，记录当前最后交易边界，服务端可单独保存真实注册时间供显示。

## 确定性和数值

钱、价、股、累计计数、序号和毫秒时间使用 `int64`；RNG 使用 `uint32` Mulberry32，hash 按 UTF-16 code unit 复现。JS 的 `Math.round` 对负数与 Go `math.Round` 不同，应显式使用向正无穷方向的半分舍入语义。浮点仅用于估值信念、随机过程、比率和公开指标。

所有消耗随机数或决定撮合顺序的遍历使用固定 slice 顺序，不能遍历 Go map。行业顺序、公司顺序、股票顺序、玩家加入顺序和盘口队列均明确保存或由固定 universe 派生。快照、预览、导出和复盘选择不消耗 RNG。

## 存档和不变量

多人存档输出 schemaVersion 5，接受严格校验后的 schemaVersion 4 迁移；包含所有玩家、全部 NPC、时钟、RNG、订单、公司和各玩家复盘。恢复先完整校验新对象，成功后服务器才能替换运行实例；公开快照不能充当存档。

- 全市场 `sum(wallet.cash) + feePool == totalCash`；新增玩家只同步增加钱包现金和 `totalCash`。
- 在任何运算前拒绝超出 JavaScript 精确整数范围（±(2^53−1)）的持久化整数。现金、股份、预留、量额、成本和费用的不定长累加使用有界加法，金额乘法先检查上界；单持仓不超过该股 480 万总股份。
- 玩家逐笔按委托汇总数量、成交额和实际费用，与完整保留委托严格相等；5000 条保留窗内的不完整老委托只能是累计值的子集。以成交及委托序号确认窗口内新委托没有缺失成交，再从缺失前缀金额复核每笔剩余费用增量。
- 每股 `sum(wallet.positions[symbol].quantity) == 4800000`。
- 每钱包现金非负、现金不小于冻结额；冻结额与活跃买单预留逐单相等；冻结股数与活跃卖单逐单相等。
- 每玩家 `cash + remainingCostBasis == initialCash + realizedPnl`，其保留委托总费用等于累计玩家费用。
- 每玩家只能引用其拥有的订单、成交和复盘；所有 player wallet 恰好对应一个玩家。
- 所有盘口唯一、有序、活跃状态和 owner 存在；日线/分时量额、时段、报价边界及当日尾 bar 一致。
- 财报恒等式、历史共识、发布时间、公司 RNG 和新闻对应关系保持原有严格校验。
- 复盘检查时点、金额、费用和累计计数、日历连续性、首尾勾稽及当前终点等于该玩家实际账户。

私人浏览器旧存档不直接导入共享市场。若后续需要迁移，应另设管理员整服迁移流程并明确对应玩家，避免单个玩家覆盖全服。

## 验证门槛

1. 移植现有撮合/费用/T+1/集合竞价/财报/复盘测试为 Go 测试，确认不是前端运行旧引擎。
2. 相同 seed 和命令序列、批量/逐 tick、导出恢复后继续运行完全一致。
3. 多玩家同价 FIFO、直接人对人成交、双方费用和复盘、第三方估值更新、资金股份守恒。
4. 各玩家独立初始本金；重复注册不注资；他人订单不能撤销；快照无其他玩家私有数据。
5. 午休/收盘拒单、管理员统一时间推进、跨周末、停机不补算、玩家无入场前复盘历史。
6. 跨多交易日及财报周期保存恢复；损坏 owner/冻结/费用/财报/复盘存档拒绝且不修改当前引擎。
7. 保持原有市场量价基本质量，完整集成后再决定是否重跑长期统计先导；不把短样本视为现实市场校准。


## 实测与复现（2026-11-08）

验证命令在 `server` 目录执行：`go test ./... -count=1`、`go test -race ./internal/market -count=1`。当前测试包含多人双边账本、第三方持仓估值、逐单最低佣金、T+1、权限隔离、严格坏档拒绝、午休/收盘、32 日复盘保留、财报和归一化区间选择。2026-11-08 最终多人阶段回归：`go test ./... -count=1` 通过（app 13.971 秒，market 15.026 秒）；`go test -race ./internal/market -short -count=1` 通过（55.979 秒，仍包含 32 日保留测试，仅跳过重复性能样本）；`go vet ./...` 通过。

`TestTSGoldenMarketAndPRNG` 对照原 TS 引擎生成的固定样本，覆盖 3 个种子（含中文与 emoji）、每个种子初始/50/80 tick，检查所有股票五档盘口、最新/前收、累计成交量额，以及最新财报营收/利润；另比较 Mulberry32 的种子哈希和随机向量。初次对照所有整数及 RNG 向量精确相等。黄金样本只用于测试，生产 Go 进程不需要 Node。

黄金样本可从仓库根目录重新生成：

```bash
./node_modules/.bin/esbuild server/internal/market/testdata/generate-golden.ts --bundle --platform=node --format=esm --outfile=/tmp/stocksim-go-golden.mjs
node /tmp/stocksim-go-golden.mjs
```

单次本机成本样本：3 玩家推进 30 交易日约 4.966 秒；内部 JSON 存档 7,616,149 字节；10 次可信深复制平均约 50.56 毫秒；含递归必需字段校验的严格恢复约 283.75 毫秒。采用固定种子、关闭背景日线；这些数字不作为跨机器性能保证。复盘按玩家保留，因此存档和整体复制开销随玩家数增加。目前服务端采用可靠的完整候选复制和原子保存，小规模运行已检查，尚未声称完成大规模用户压测。

本次保持原代理参数和财报参数，不重新声称完成真实市场校准；现有量价模型与历史先导结果见 `docs/market-model.md` 和 `docs/fundamentals-model.md`。新增外部事件机制和事件参数见 `docs/external-events-model.md`；原市场与公司随机流保持独立，生产不需要 Node。


## 独立审查后的恢复校验修复

2026-11-08 独立算法审查发现两类坏档接受问题，均先以回归测试复现失败，再修复：

1. 四个 NPC 各增加 `1<<62` 现金或股份，原 `int64` 累加会回绕到原总额。现在先限制所有持久化整数的精确表示范围，再以可信总量或安全整数上限逐项检查累加、乘法及公开派生估值；拒绝单钱包持股超过全市场总股本。
2. 原玩家成交仅校验格式和所有权，修改成交费用、或同步修改价格与成交额可以绕过恢复。现在逐委托核对成交数量、成交额和累计费用，验证限价改良方向、成交序号顺序，并重算保留成交段的累计费用增量。未被保留的历史不被补造，也不声称证明自洽恶意历史的真实性。

新增测试使用真实撮合与结算完成 6100 笔小额成交，验证 5000 笔保留窗口仍可正常恢复；首个委托跨越截断边界、第二个委托完整位于窗口内。回归覆盖边界费用篡改、完整委托费用篡改，以及保持唯一成交 ID 和合理费用前缀但删除窗口内新委托成交的伪造。修复只影响保存恢复校验，未调整报价、撮合、财报或复盘生成参数。
