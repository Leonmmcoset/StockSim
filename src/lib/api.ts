import type { CommandResult, MarketSnapshot, NormalizedEquityPoint, OrderInput, OrderPreview, ReviewPeriodSummary } from '../engine/types';
export interface User { id: string; username: string; role: 'admin' | 'user'; banned: boolean; createdAt: string }
export interface MarketMeta { revision: number; running: boolean; speed: 1 | 4 | 16 | 64; savedAt: string }
export interface SessionResponse { user: User | null; csrfToken: string; registrationOpen: boolean; market: MarketMeta }
export interface SnapshotResponse { userId: string; snapshot: MarketSnapshot; market: MarketMeta }
export interface CommandResponse extends SnapshotResponse { result: CommandResult }
export interface ReviewResponse { userId: string; points: NormalizedEquityPoint[]; summary: ReviewPeriodSummary; revision: number }
export interface AdminUsers { users: User[]; registrationOpen: boolean }
export class ApiIdentityError extends Error { constructor(public actualUserId: string | null) { super('会话身份已更改'); } }
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function request<T>(path: string, options: { body?: unknown; csrf?: string; key?: string; signal?: AbortSignal; expectedUserId?: string; responseType?: 'blob' } = {}): Promise<T> {
  const post = options.body !== undefined;
  const headers: Record<string, string> = {};
  if (post) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = options.csrf ?? ''; }
  if (options.key) headers['Idempotency-Key'] = options.key;
  if (options.expectedUserId !== undefined) headers['X-Expected-User-Id'] = options.expectedUserId;
  const timeout = AbortSignal.timeout(15000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`/api${path}`, { method: post ? 'POST' : 'GET', headers, ...(post ? { body: JSON.stringify(options.body) } : {}), signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) { let error = `请求失败 (${response.status})`; try { error = (await response.json()).error || error; } catch { /* non-JSON error */ } throw new ApiError(error, response.status); }
  if (options.expectedUserId !== undefined && response.headers.get('X-User-Id') !== options.expectedUserId) throw new ApiIdentityError(response.headers.get('X-User-Id'));
  return response.status === 204 ? undefined as T : options.responseType === 'blob' ? response.blob() as Promise<T> : response.json();
}
export const preview = (input: OrderInput, csrf: string, expectedUserId: string, signal?: AbortSignal) => request<OrderPreview>('/orders/preview', { body: input, csrf, expectedUserId, signal });
