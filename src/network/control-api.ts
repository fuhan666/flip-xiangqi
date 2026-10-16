/**
 * 本机控制接口客户端：仅在本机 UI 页面可用（loopback 控制端）。
 * 静态预览或房间客人页面没有该接口时，UI 明确提示，绝不伪装建房成功。
 */

export interface LanAddressInfo {
  address: string;
  interfaceName: string;
  private: boolean;
}

export interface RoomInfo {
  roomId: string;
  port: number;
  addresses: LanAddressInfo[];
  loopbackOnly: boolean;
}

export interface RoomCreateResult extends RoomInfo {
  hostToken: string;
}

export interface RoomStatus {
  hostAvailable: boolean;
  defaultRoomPort: number;
  active: boolean;
  room: RoomInfo | null;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export interface RoomControlApi {
  /** 宿主不可用（无控制接口）时返回 null。 */
  status(): Promise<RoomStatus | null>;
  createRoom(port?: number): Promise<ApiResult<RoomCreateResult>>;
  closeRoom(hostToken: string): Promise<ApiResult<true>>;
  /** 当前页面是否由房间服务提供（客人打开的分享地址）。 */
  isGuestPage(): Promise<boolean>;
}

const DEFAULT_PORT_MESSAGE = '无法连接本机建房服务 —— 服务可能未启动或已退出 —— 请在房主电脑上运行 npm run dev 或 npm start 后重试';

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function asMessage(payload: Record<string, unknown> | null, fallback: string): string {
  return typeof payload?.message === 'string' && payload.message.length > 0 ? payload.message : fallback;
}

function asCode(payload: Record<string, unknown> | null, fallback: string): string {
  return typeof payload?.code === 'string' && payload.code.length > 0 ? payload.code : fallback;
}

export function createHttpRoomControlApi(): RoomControlApi {
  return {
    async status(): Promise<RoomStatus | null> {
      const payload = await requestJson('/api/room/status');
      if (!payload || payload.ok !== true) {
        return null;
      }
      return {
        hostAvailable: payload.hostAvailable === true,
        defaultRoomPort: typeof payload.defaultRoomPort === 'number' ? payload.defaultRoomPort : 8080,
        active: payload.active === true,
        room: (payload.room as RoomInfo | null) ?? null,
      };
    },

    async createRoom(port?: number): Promise<ApiResult<RoomCreateResult>> {
      const payload = await requestJson('/api/room/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(port === undefined ? {} : { port }),
      });
      if (!payload) {
        return { ok: false, code: 'HOST_UNAVAILABLE', message: DEFAULT_PORT_MESSAGE };
      }
      if (payload.ok !== true) {
        return { ok: false, code: asCode(payload, 'INTERNAL_ERROR'), message: asMessage(payload, DEFAULT_PORT_MESSAGE) };
      }
      return {
        ok: true,
        value: {
          roomId: String(payload.roomId ?? ''),
          hostToken: String(payload.hostToken ?? ''),
          port: Number(payload.port ?? 0),
          addresses: Array.isArray(payload.addresses) ? (payload.addresses as LanAddressInfo[]) : [],
          loopbackOnly: payload.loopbackOnly === true,
        },
      };
    },

    async closeRoom(hostToken: string): Promise<ApiResult<true>> {
      const payload = await requestJson('/api/room/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostToken }),
      });
      if (!payload) {
        return { ok: false, code: 'HOST_UNAVAILABLE', message: DEFAULT_PORT_MESSAGE };
      }
      if (payload.ok !== true) {
        return { ok: false, code: asCode(payload, 'INTERNAL_ERROR'), message: asMessage(payload, DEFAULT_PORT_MESSAGE) };
      }
      return { ok: true, value: true };
    },

    async isGuestPage(): Promise<boolean> {
      const payload = await requestJson('/api/guest');
      return payload?.ok === true && payload.roomPage === true;
    },
  };
}
