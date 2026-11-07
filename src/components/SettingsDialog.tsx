import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, FileUp, FolderOpen, Info, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { format } from 'date-fns';
import { useGameStore } from '../store/game';
import { DEFAULT_SEED } from '../engine';
import './SettingsDialog.css';

export default function SettingsDialog() {
  const open = useGameStore(s => s.settingsOpen);
  const setOpen = useGameStore(s => s.setSettingsOpen);
  const snapshot = useGameStore(s => s.snapshot);
  const ready = useGameStore(s => s.ready);
  const lastSaved = useGameStore(s => s.lastSaved);
  const saveError = useGameStore(s => s.saveError);
  const tab = useGameStore(s => s.settingsTab);
  const setTab = useGameStore(s => s.setSettingsTab);
  const [error, setError] = useState('');
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function exportFile() {
    try {
      const text = useGameStore.getState().exportSave();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = `股海模拟存档-${snapshot?.clock.date ?? 'backup'}.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '导出失败'); }
  }
  async function importFile(file: File) {
    setBusy(true); setError('');
    try {
      if (file.size > 12 * 1024 * 1024) throw new Error('存档超过 12 MB 大小限制');
      const text = await file.text();
      useGameStore.getState().importSave(text);
      setConfirmNew(false);
    } catch (e) { setError(e instanceof Error ? e.message : '导入失败，当前进度未改变'); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  function startNew() {
    setBusy(true); setError('');
    window.setTimeout(() => {
      try { useGameStore.getState().newGame(seed); setConfirmNew(false); setOpen(false); }
      catch (e) { setError(e instanceof Error ? e.message : '创建市场失败'); }
      finally { setBusy(false); }
    }, 40);
  }

  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) { setOpen(value); setError(''); setConfirmNew(false); } }}>
    <Dialog.Portal>
      <Dialog.Overlay className="settings-overlay" />
      <Dialog.Content className="settings-dialog" aria-describedby="settings-description">
        <header className="settings-header"><Dialog.Title><FolderOpen size={15} /> 交易终端设置</Dialog.Title><Dialog.Close aria-label="关闭设置" disabled={busy}><X size={16} /></Dialog.Close></header>
        <Dialog.Description id="settings-description" className="settings-description">股海证券 · 本地模拟交易终端</Dialog.Description>
        <nav className="settings-tabs" aria-label="设置分类">
          <button className={tab === 'save' ? 'active' : ''} onClick={() => setTab('save')}>存档管理</button>
          <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>交易规则</button>
          <button className={tab === 'model' ? 'active' : ''} onClick={() => setTab('model')}>市场模型</button>
        </nav>
        <div className="settings-body">
          {tab === 'save' && <>
            <div className="settings-section-title"><ShieldCheck size={14} /> 本地存档</div>
            <div className="save-details">
              <div><span>当前市场</span><b>{snapshot?.seed ?? '尚未建立'}</b></div>
              <div><span>交易进度</span><b>{snapshot ? `${snapshot.clock.date} ${snapshot.clock.time}` : '—'}</b></div>
              <div><span>最近保存</span><b>{lastSaved ? format(new Date(lastSaved), 'MM-dd HH:mm:ss') : '—'}</b></div>
            </div>
            <p className="settings-note">每 10 秒及交易后自动保存。刷新后恢复为暂停状态；导出备份可在其他浏览器继续。</p>
            {saveError && <p className="settings-error" role="alert">{saveError}，请导出文件备份。</p>}
            <div className="settings-actions">
              <button disabled={!ready || busy} onClick={exportFile}><Download size={14} /> 导出存档</button>
              <button disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={14} /> 导入存档</button>
              <button disabled={!ready || busy} onClick={() => useGameStore.getState().save()}>立即保存</button>
            </div>
            <input ref={fileInput} aria-label="导入存档文件" className="save-file-input" type="file" accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); }} />
            <p className="settings-note">导入成功会替换当前进度。格式或账本校验失败时保留原进度。</p>
            <div className="settings-newgame">
              <div className="settings-section-title"><RotateCcw size={14} /> 重新开局</div>
              <label htmlFor="new-market-seed">市场种子 <input id="new-market-seed" value={seed} onChange={e => setSeed(e.target.value)} maxLength={64} spellCheck={false} /></label>
              <p className="settings-note">相同种子和交易操作可重现相同市场。新开局从 5,000 元开始。</p>
              {confirmNew ? <div className="newgame-confirm"><span>当前进度将被替换，请先导出需要的存档。</span><button disabled={busy} onClick={startNew}>{busy ? '正在生成市场…' : '确认重新开局'}</button><button disabled={busy} onClick={() => setConfirmNew(false)}>取消</button></div> : <button className="newgame-button" disabled={busy} onClick={() => setConfirmNew(true)}>重新开局</button>}
            </div>
          </>}
          {tab === 'rules' && <>
            <div className="settings-section-title"><Info size={14} /> 沪市主板普通股票 · 游戏规则</div>
            <table className="rules-table"><tbody>
              <tr><th>起始资金</th><td>人民币 5,000 元，无初始持仓</td></tr>
              <tr><th>买卖数量</th><td>买入 100 股整数倍；T 日买入，下一交易日可卖</td></tr>
              <tr><th>价格限制</th><td>报价精度 0.01 元；相对昨收 ±10%，连续竞价设价格笼子</td></tr>
              <tr><th>成交方式</th><td>限价委托，价格优先、同价时间优先；可部分成交、撤单</td></tr>
              <tr><th>竞价时段</th><td>09:30–11:30 / 13:00–14:57；14:57–15:00 收盘集合竞价，期间不可撤单</td></tr>
              <tr><th>佣金</th><td>成交额 × 0.025%，每张成交委托最低 5 元，分次成交累计计算</td></tr>
              <tr><th>其他费用</th><td>过户费双向 0.001%；印花税卖出时 0.05%</td></tr>
              <tr><th>未成交订单</th><td>当日有效，收盘失效；冻结的资金或股份自动释放</td></tr>
              <tr><th>时间推进</th><td>1× 每秒推进 30 模拟秒，4× / 16× / 64× 仅加速；午休和收盘暂停</td></tr>
            </tbody></table>
            <p className="settings-note">“下一交易日”先模拟完当天剩余时间，挂单可能成交。日期跳过周末，未接入法定节假日日历。费率为游戏券商参数。</p>
            <p className="settings-note">首版不提供开盘集合竞价操作、盘后定价交易、分红除权和融资融券。全部股票、指数及新闻均为虚构。</p>
            <a className="settings-link" href="https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml" target="_blank" rel="noreferrer">参考：上海证券交易所交易规则（2026 年修订） ↗</a>
          </>}
          {tab === 'model' && <>
            <div className="settings-section-title">从交易者行为到价格</div>
            <p className="model-copy">12 家虚构公司分属不同行业。基本面、宏观与行业变化、新闻和市场情绪影响交易者的估值；基本面、趋势、噪声和流动性交易者各自提交订单，成交结果形成价格和交易量。</p>
            <div className="model-flow"><span>宏观 / 行业 / 新闻</span><i>→</i><span>交易者下单</span><i>→</i><span>订单簿撮合</span><i>→</i><span>量价走势</span></div>
            <p className="model-copy">利好不保证上涨，挂单也不保证成交。每个交易者受到资金和库存约束；你的委托进入同一订单簿排队。市场种子与操作记录决定后续进程。</p>
            <p className="settings-note">模型参考异质代理与订单驱动市场研究，属于机制拟真的游戏模拟，尚未经真实市场数据校准。图表历史和当前行情的生成方法详见项目内《市场模型》文档。</p>
            <div className="model-sources">
              <a href="https://arxiv.org/abs/0711.3581" target="_blank" rel="noreferrer">Chiarella, Iori & Perelló · 异质交易者与限价簿 ↗</a>
              <a href="https://www.nature.com/articles/17290" target="_blank" rel="noreferrer">Lux & Marchesi · 多代理市场的波动集聚 ↗</a>
              <a href="https://doi.org/10.1080/713665670" target="_blank" rel="noreferrer">Cont · 金融收益率的经验特征 ↗</a>
            </div>
            <div className="settings-shortcuts"><b>终端快捷键</b><span>F5 分时 / 日K</span><span>F6 自选股</span><span>F12 委托面板</span><span>空格 暂停 / 继续</span></div>
          </>}
          {error && <p role="alert" className="settings-error">{error}</p>}
        </div>
        <footer className="settings-footer"><span>虚构市场 · 本地运行 · 进度由你保管</span><Dialog.Close disabled={busy}>返回终端</Dialog.Close></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
