# 最终独立审查

审查范围：存档恢复、交易表单、时间控制、账户和行情界面，以及引擎中相关的数据一致性。未修改产品代码。以下问题用临时 Vitest 用例复现，测试文件已删除。

## P2：缺失日 K 的坏档可导入并覆盖当前进度，之后撮合会中断

位置：`src/engine/save.ts:12`、`src/engine/save.ts:35`、`src/engine/market.ts:155`、`src/store/game.ts:172`。

从正常 `createMarket().exportState()` 得到存档，将 `data.stocks` 各项的 `dailyBars` 改成空数组，然后调用 `importMarket`：导入成功；对返回的引擎执行 `step(1)`，撮合时会抛出异常，因为 `fill` 假定 `dailyBars.at(-1)` 一定存在并对其执行 `Object.assign`。界面导入同样先接受此状态，接着立即自动保存，因此可能覆盖原本可用的本地进度；后续推进或下单发生撮合时中断，而且异常发生前账本已有部分变更。

建议导入时至少要求每只股票有代表当前交易日的最后一根日 K，并检查时间及其与当前行情的基本一致性；对删除当前日 K 的坏档添加回归测试，验证导入失败且旧进度保留。

### 复核：已解决

修复后导入校验要求日 K 非空，最后一根属于当前交易日且与当日行情一致；成交日必须保留逐笔记录。针对空日 K、当前日 K 日期错误、成交日缺少逐笔记录的三个回归用例均通过（`npx vitest run tests/engine-ledger.test.ts -t 'rejects missing current-day candles|rejects a current-day candle dated|rejects a nonempty traded day'`：3 项通过，8 项跳过）。本次复核限于上述修复及相关测试。
