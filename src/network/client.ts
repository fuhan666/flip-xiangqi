/**
 * 房间连接客户端：独立于 React 的连接层封装。
 *
 * - 提供 connect / disconnect、连接状态与成员快照订阅；
 * - 握手（hello → welcome）完成后才算加入成功；
 * - 取消或再次连接时，旧 socket 与计时器的回调一律忽略（代际计数）。
 */
import { formatAddress, toWebSocketUrl, type ParsedAddress } from './address';
import { describeErrorCode, describeRoomClosed } from './errors';
import {
  buildClientHello,
  buildClientLeave,
  closeCodeForError,
  encodeMessage,
  parseServerMessage,
  serverErrorCodeForCloseCode,
  PROTOCOL_VERSION,
  type ErrorCode,
  type MemberSnapshot,
  type Role,
  type RoomClosedReason,
  type ServerErrorCode,
} from './protocol';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  /** 当前错误（本地或服务端错误码），无错误时为 null。 */
  errorCode: ErrorCode | null;
  /** 面向用户的三段式说明。 */
  message: string | null;
  roomId: string | null;
  memberId: string | null;
  role: Role | null;
  members: MemberSnapshot[];
  closedReason: RoomClosedReason | null;
}

export interface JoinOptions {
  role: Role;
  name: string;
  token?: string;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface RoomConnection {
  connect(address: ParsedAddress, options: JoinOptions): void;
  disconnect(): void;
  subscribe(listener: (state: ConnectionState) => void): () => void;
  getState(): ConnectionState;
  /** 当前连接的地址（握手成功或连接中），供「最近房间」记录使用。 */
  getAddress(): string | null;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const SOCKET_OPEN = 1;

const IDLE_STATE: ConnectionState = {
  status: 'idle',
  errorCode: null,
  message: null,
  roomId: null,
  memberId: null,
  role: null,
  members: [],
  closedReason: null,
};

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export interface RoomClientOptions {
  webSocketFactory?: WebSocketFactory;
  connectTimeoutMs?: number;
}

export class RoomClient implements RoomConnection {
  private readonly webSocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = IDLE_STATE;
  private socket: WebSocketLike | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private joinedAddress: string | null = null;

  constructor(options: RoomClientOptions = {}) {
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  getState(): ConnectionState {
    return this.state;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(address: ParsedAddress, options: JoinOptions): void {
    if (this.state.status === 'connected') {
      this.setState({
        ...this.state,
        status: 'error',
        errorCode: 'ALREADY_CONNECTED',
        message: describeErrorCode('ALREADY_CONNECTED'),
      });
      return;
    }

    if (this.state.status === 'connecting') {
      this.teardown();
    }

    const generation = ++this.generation;
    this.joinedAddress = formatAddress(address);
    this.setState({
      ...IDLE_STATE,
      status: 'connecting',
      role: options.role,
    });

    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(toWebSocketUrl(address));
    } catch {
      this.fail(generation, 'CONNECT_FAILED');
      return;
    }
    this.socket = socket;

    this.timer = setTimeout(() => {
      if (generation !== this.generation) {
        return;
      }
      this.fail(generation, 'CONNECT_TIMEOUT');
    }, this.connectTimeoutMs);

    socket.onopen = () => {
      if (generation !== this.generation) {
        return;
      }
      try {
        socket.send(
          encodeMessage(buildClientHello({ role: options.role, name: options.name, token: options.token })),
        );
      } catch {
        this.fail(generation, 'CONNECT_FAILED');
      }
    };

    socket.onmessage = (event) => {
      if (generation !== this.generation) {
        return;
      }
      this.handleMessage(generation, event.data);
    };

    socket.onerror = () => {
      // 浏览器 WS API 无法可靠区分拒绝/防火墙/断网，统一在 close 中给出排查型文案。
    };

    socket.onclose = (event) => {
      if (generation !== this.generation) {
        return;
      }
      this.handleClose(generation, event.code);
    };
  }

  disconnect(): void {
    if (!this.socket && this.state.status === 'idle') {
      return;
    }

    const socket = this.socket;
    if (socket && this.state.roomId && socket.readyState === SOCKET_OPEN) {
      try {
        socket.send(encodeMessage(buildClientLeave(this.state.roomId)));
      } catch {
        // 尽力而为：leave 发送失败不阻断本地清理。
      }
    }

    this.teardown();
    this.generation += 1;
    this.setState({ ...IDLE_STATE, status: 'disconnected' });
  }

  /** 当前连接的地址（握手成功或连接中），供「最近房间」记录使用。 */
  getAddress(): string | null {
    return this.joinedAddress;
  }

  private handleMessage(generation: number, raw: unknown): void {
    if (typeof raw !== 'string') {
      this.fail(generation, 'INVALID_MESSAGE');
      return;
    }

    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.fail(generation, parsed.code);
      return;
    }

    const message = parsed.message;

    if (message.type === 'welcome') {
      this.clearTimer();
      this.setState({
        status: 'connected',
        errorCode: null,
        message: null,
        roomId: message.payload.roomId,
        memberId: message.payload.memberId,
        role: message.payload.role,
        members: message.payload.members,
        closedReason: null,
      });
      return;
    }

    if (message.type === 'members') {
      this.setState({ ...this.state, members: message.payload.members });
      return;
    }

    if (message.type === 'room.closed') {
      this.clearTimer();
      const reason = message.payload.reason;
      this.setState({
        ...this.state,
        status: 'disconnected',
        closedReason: reason,
        message: describeRoomClosed(reason),
      });
      this.teardown();
      this.generation += 1;
      return;
    }

    if (message.type === 'error') {
      this.fail(generation, message.payload.code);
    }
  }

  private handleClose(generation: number, code: number): void {
    if (generation !== this.generation) {
      return;
    }

    this.clearTimer();
    this.socket = null;

    if (this.state.status === 'connected') {
      this.setState({
        ...this.state,
        status: 'disconnected',
        message: '与房间的连接已断开 —— 网络波动或房主端关闭了连接 —— 请返回重新加入',
      });
      return;
    }

    const serverCode = serverErrorCodeForCloseCode(code);
    this.fail(generation, serverCode ?? 'CONNECT_FAILED');
  }

  private fail(generation: number, code: ErrorCode): void {
    if (generation !== this.generation) {
      return;
    }
    this.teardown();
    this.generation += 1;
    this.setState({
      ...IDLE_STATE,
      status: 'error',
      errorCode: code,
      message: describeErrorCode(code),
      role: this.state.role,
    });
  }

  private teardown(): void {
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      // 保留错误吞掉回调：握手未完成时 close 会触发 error 事件，清空监听会导致未捕获异常。
      socket.onerror = () => undefined;
      try {
        socket.close(closeCodeForError('INTERNAL_ERROR'), 'client-teardown');
      } catch {
        // socket 可能已处于关闭态。
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) {
      listener(state);
    }
  }
}

export function createRoomClient(options?: RoomClientOptions): RoomConnection {
  return new RoomClient(options);
}

/** 供 UI 显示的默认连接状态文案。 */
export function describeStatus(state: ConnectionState): string {
  switch (state.status) {
    case 'idle':
      return '未连接';
    case 'connecting':
      return '连接中…';
    case 'connected':
      return '已连接';
    case 'disconnected':
      return '已断开';
    case 'error':
      return state.errorCode ? describeErrorCode(state.errorCode) : '连接失败';
    default:
      return '未连接';
  }
}

export type { ServerErrorCode };
export { PROTOCOL_VERSION };
