import { useMemo, useRef, useState, useEffect } from 'react';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, Search, Star } from 'lucide-react';
import type { Quote } from '../engine/types';
import { direction, pct, price } from '../lib/format';

interface QuotesTableProps {
  quotes: Quote[];
  selectedSymbol: string;
  watchlist: string[];
  onSelect: (symbol: string) => void;
  onToggleWatchlist: (symbol: string) => void;
  watchOnly: boolean;
  onWatchOnlyChange: (value: boolean) => void;
}

export function QuotesTable({ quotes, selectedSymbol, watchlist, onSelect, onToggleWatchlist, watchOnly, onWatchOnlyChange }: QuotesTableProps) {
  const [query, setQuery] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const data = useMemo(() => quotes.filter(q => (!watchOnly || watchlist.includes(q.symbol)) && `${q.symbol}${q.name}${q.sector}`.includes(query.trim())), [quotes, watchOnly, watchlist, query]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const columns = useMemo<ColumnDef<Quote>[]>(() => [
    { accessorKey: 'name', header: '证券名称 / 代码', cell: ({ row }) => <><span className="stock-name">{row.original.name}</span><span className="stock-code"><span className="exchange">沪</span>{row.original.symbol}</span></> },
    { accessorKey: 'last', header: '最新价', cell: ({ row }) => <span className={direction(row.original.change)}>{price(row.original.last)}</span> },
    { accessorKey: 'changePct', header: '涨跌幅', cell: ({ row }) => <span className={`pct ${direction(row.original.change)}`}>{pct(row.original.changePct)}</span> },
    { id: 'watch', header: '', enableSorting: false, cell: ({ row }) => <button className={`star-button ${watchlist.includes(row.original.symbol) ? 'on' : ''}`} onClick={e => { e.stopPropagation(); onToggleWatchlist(row.original.symbol); }} aria-label={`${watchlist.includes(row.original.symbol) ? '移除自选' : '加入自选'} ${row.original.name}`} title="加入 / 移除自选"><Star size={11} fill={watchlist.includes(row.original.symbol) ? 'currentColor' : 'none'} /></button> },
  ], [watchlist, onToggleWatchlist]);
  const table = useReactTable({ data, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const sectorStats = useMemo(() => [...new Set(quotes.map(q => q.sector))].slice(0, 6).map(sector => { const group = quotes.filter(q => q.sector === sector); return { sector, change: group.reduce((sum, q) => sum + q.changePct, 0) / group.length }; }), [quotes]);
  return <aside className="quotes-pane" aria-label="市场行情">
    <div className="pane-tabs"><button className={!watchOnly ? 'active' : ''} onClick={() => onWatchOnlyChange(false)}>沪深行情 <span className="mono">{quotes.length}</span></button><button className={watchOnly ? 'active' : ''} onClick={() => onWatchOnlyChange(true)}>我的自选 <span className="mono">{watchlist.length}</span></button></div>
    <div className="quote-search"><Search size={13} /><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && data[0]) onSelect(data[0].symbol); if (e.key === 'Escape') { setQuery(''); searchRef.current?.blur(); } }} aria-label="搜索股票" placeholder="输入代码 / 名称 / 行业" /><kbd>/</kbd></div>
    <div className="table-scroll"><table className="quotes-table"><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id} onClick={header.column.getToggleSortingHandler()} style={{ cursor: header.column.getCanSort() ? 'pointer' : undefined }} aria-sort={header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : undefined}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() === 'asc' ? <ArrowUp size={9} /> : header.column.getIsSorted() === 'desc' ? <ArrowDown size={9} /> : null}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id} className={row.original.symbol === selectedSymbol ? 'selected' : ''} onClick={() => onSelect(row.original.symbol)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onSelect(row.original.symbol); }} aria-selected={row.original.symbol === selectedSymbol}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table>{!data.length && <div className="watchlist-empty">{query ? '未找到匹配的证券' : '暂无自选股'}<br />{query ? '试试证券代码或公司名称' : '点击行情列表中的 ☆ 添加自选'}</div>}</div>
    <div className="quotes-foot"><span>共 {data.length} 只证券</span><span>点击表头排序 · ☆ 自选</span></div>
    <div className="sector-heading"><span>行业板块</span><span className="muted">平均涨幅</span></div><div className="sectors">{sectorStats.map(item => <button className="sector-item" key={item.sector} onClick={() => { setQuery(query === item.sector ? '' : item.sector); onWatchOnlyChange(false); }}><span>{item.sector}</span><span className={direction(item.change)}>{pct(item.change)}</span></button>)}</div>
  </aside>;
}
