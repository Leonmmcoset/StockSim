import { useState, type FormEvent } from 'react';
import { Activity } from 'lucide-react';
import { useGameStore } from '../store/game';
import SettingsDialog from './SettingsDialog';
export default function AuthPanel() {
 const game = useGameStore();
 const [mode, setMode] = useState<'login'|'register'>('login');
 const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
 async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); try { await game.authenticate(mode, username, password); setPassword(''); } catch { /* shown by store */ } finally { setBusy(false); } }
 return <div className="terminal loading-terminal"><div className="loading-brand"><span className="brand-mark">海</span><span>股海证券 <small>STOCKSIM TERMINAL</small></span></div><div className="loading-state"><Activity size={20}/>{game.user ? <><p>正在连接共享市场…</p><button onClick={() => void game.refreshSnapshot()}>重试连接</button></> : <><p>共享模拟市场 · 首位注册用户为管理员</p><form onSubmit={submit} className="auth-form"><label>用户名<input aria-label="用户名" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required minLength={3} maxLength={24}/></label><label>密码<input aria-label="密码" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={8} maxLength={128}/></label><button disabled={busy || !game.csrfToken}>{busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}</button></form><button onClick={() => setMode(mode === 'login' ? 'register' : 'login')} disabled={busy || (mode === 'login' && !game.registrationOpen)}>{mode === 'login' ? '注册账号' : '返回登录'}</button></>}{game.initError && <p role="alert">{game.initError}</p>}<button disabled={busy} onClick={() => void game.initialize()}>重试服务器</button><button disabled={busy} onClick={() => game.setSettingsOpen(true)}>设置与旧存档</button></div><SettingsDialog /></div>;
}
