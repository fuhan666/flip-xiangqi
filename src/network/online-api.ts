/**
 * 在线入口的同源 API 客户端：匿名会话与建房。
 *
 * - 只请求当前页面来源下的 `/api/online/*`，不接触 LAN 本机控制接口；
 * - 匿名凭据完全由浏览器 cookie 携带（HttpOnly），这里不读取、不保存任何令牌；
 * - 失败按服务端错误码归一化，页面据此提示可恢复操作。
 */

export type OnlineApiErrorCode =
  | 'SESSION_INVALID'
  | 'BAD_ORIGIN'
  | 'INVALID_REQUEST_ID'
  | 'REQUEST_CONFLICT'
  | 'NETWORK'
  | 'UNKNOWN';

export type OnlineApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: OnlineApiErrorCode; message: string };

export interface OnlineRoomCreated {
  roomId: string;
  url: string;
  created: boolean;
  closed: boolean;
}

export interface OnlineApi {
  /** 建立或校验匿名会话；401 表示原凭据已失效。 */
  ensureSession(): Promise<OnlineApiResult<{ created: boolean }>>;
  /** 显式开启新的匿名会话（原席位不再可恢复）。 */
  resetSession(): Promise<OnlineApiResult<{ reset: true }>>;
  /** 幂等建房：同一 requestId 重复提交返回同一房间。 */
  createRoom(requestId: string): Promise<OnlineApiResult<OnlineRoomCreated>>;
  /** 建房者显式关房（非建房者身份会被拒绝）。 */
  closeRoom(roomId: string): Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

async function postJson(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; payload: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await response.json();
      payload =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

function toError(status: number, payload: Record<string, unknown> | null): { code: OnlineApiErrorCode; message: string } {
  const rawCode = typeof payload?.code === 'string' ? payload.code : null;
  if (status === 401) {
    return { code: 'SESSION_INVALID', message: '匿名会话已失效 —— 请开始新的匿名会话' };
  }
  if (rawCode === 'REQUEST_CONFLICT') {
    return { code: 'REQUEST_CONFLICT', message: '建房请求编号重复且参数不同 —— 请重试' };
  }
  if (rawCode === 'INVALID_REQUEST_ID') {
    return { code: 'INVALID_REQUEST_ID', message: '建房请求编号无效 —— 请重试' };
  }
  if (status === 403) {
    return { code: 'BAD_ORIGIN', message: '请求来源校验失败 —— 请从在线入口页面操作' };
  }
  if (rawCode === 'INTERNAL_ERROR' || status >= 500) {
    return { code: 'UNKNOWN', message: '服务器暂时无法处理请求 —— 请稍后重试' };
  }
  return { code: 'UNKNOWN', message: '请求未完成 —— 请重试' };
}

export function createHttpOnlineApi(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): OnlineApi {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async ensureSession() {
      try {
        const { status, payload } = await postJson('/api/online/session', {}, fetchImpl, timeoutMs);
        if (status === 200 && payload?.ok === true) {
          return { ok: true, value: { created: payload.created === true } };
        }
        return { ok: false, ...toError(status, payload) };
      } catch {
        return { ok: false, code: 'NETWORK', message: '无法连接在线入口 —— 请检查网络后重试' };
      }
    },

    async resetSession() {
      try {
        const { status, payload } = await postJson('/api/online/session', { reset: true }, fetchImpl, timeoutMs);
        if (status === 200 && payload?.ok === true) {
          return { ok: true, value: { reset: true } };
        }
        return { ok: false, ...toError(status, payload) };
      } catch {
        return { ok: false, code: 'NETWORK', message: '无法连接在线入口 —— 请检查网络后重试' };
      }
    },

    async createRoom(requestId: string) {
      try {
        const { status, payload } = await postJson('/api/online/rooms', { requestId }, fetchImpl, timeoutMs);
        if (
          status === 200 &&
          payload?.ok === true &&
          typeof payload.roomId === 'string' &&
          typeof payload.url === 'string'
        ) {
          return {
            ok: true,
            value: {
              roomId: payload.roomId,
              url: payload.url,
              created: payload.created === true,
              closed: payload.closed === true,
            },
          };
        }
        return { ok: false, ...toError(status, payload) };
      } catch {
        return { ok: false, code: 'NETWORK', message: '无法连接在线入口 —— 请检查网络后重试' };
      }
    },

    async closeRoom(roomId: string) {
      try {
        const { status, payload } = await postJson(
          `/api/online/rooms/${encodeURIComponent(roomId)}/close`,
          {},
          fetchImpl,
          timeoutMs,
        );
        return status === 200 && payload?.ok === true;
      } catch {
        return false;
      }
    },
  };
}
