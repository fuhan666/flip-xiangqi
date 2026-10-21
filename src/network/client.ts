/**
 * 房间连接客户端：独立于 React 的连接层封装。
 *
 * - 提供 connect / disconnect / reconnect、连接状态与成员快照订阅；
 * - 握手（hello → welcome）完成后才算加入成功；
 * - 心跳保活与往返延迟监测（ping/pong）；
 * - 临时掉线自动重连（指数退避，上限与总预算）与手动立即重连；
 * - 取消或再次连接时，旧 socket 与计时器的回调一律忽略（代际计数）。
 */
import { formatAddress, toWebSocketUrl, type ParsedAddress } from './address.js';
import { describeErrorCode, describeLobbyReject, describeRoomClosed } from './errors.js';
import {
  computeReconnectDelay,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_RECONNECT_BUDGET_MS,
  DEFAULT_RECONNECT_DELAYS,
} from './heartbeat.js';
import {
  buildClientGameAction,
  buildClientGameNegotiate,
  buildClientGameNegotiateReply,
  buildClientGameResign,
  buildClientGameSync,
  buildClientGameVersion,
  buildClientChatPhrase,
  buildClientHello,
  buildClientLeave,
  buildClientLobbyLock,
  buildClientLobbyReady,
  buildClientLobbyReturn,
  buildClientLobbySettings,
  buildClientLobbyStart,
  buildPing,
  buildPong,
  closeCodeForError,
  encodeMessage,
  isQuickPhraseId,
  parseServerMessage,
  serverErrorCodeForCloseCode,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type LobbyRejection,
  type MatchAction,
  type MatchClockSnapshot,
  type MatchEvent,
  type MatchSettlement,
  type MemberSnapshot,
  type NegotiationEvent,
  type PendingNegotiation,
  type PublicGameState,
  type QuickPhraseEvent,
  type Role,
  type RoomClosedReason,
  type ServerErrorCode,
  type SidePreference,
  type StartParameters,
  type TimeControlId,
} from './protocol.js';
import { applyPublicGameDelta } from './public-patch.js';
import type { LobbyState } from './lobby.js';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/** 大厅请求类别：同一时刻只保留一个在途请求，用于防连点。 */
export type LobbyRequestKind = 'settings' | 'lock' | 'ready' | 'start';

export interface AcceptedGameAction {
  eventId: string;
  stepNumber: number;
  actorMemberId: string;
  action: MatchAction;
  source: 'local' | 'remote';
  /**
   * 仅客户端使用：只有服务端权威 game.state 的确认/广播才会产生该事件（始终为 true）。
   * 客户端不再做本地乐观推演；该标记用于区分「权威动作反馈」与其它状态更新，不进入线协议。
   */
  confirmed: boolean;
}

export interface GameClientState {
  matchId: string;
  stepNumber: number;
  revision: number;
  startParameters: StartParameters;
  /**
   * 服务端确认的最后一份公开局面：客户端只做展示，不在本地推演或还原隐藏信息。
   * 提交动作后棋盘保持该局面，直到权威确认或拒绝到达。
   */
  gameState: PublicGameState;
  clock: MatchClockSnapshot | null;
  settlement: MatchSettlement | null;
  clockOffsetMs: number;
  pendingAction: {
    requestId: string;
    stepNumber: number;
    action: MatchAction;
  } | null;
  lastError: string | null;
  lastRejectedReason: string | null;
  statusNotice: string | null;
  lastAcceptedAction: AcceptedGameAction | null;
  pendingNegotiation: PendingNegotiation | null;
  drawCooldownUntil: Record<string, number>;
  phraseCooldownUntil?: Record<string, number>;
  negotiationEvent: NegotiationEvent | null;
  recentPhraseEvents?: Record<string, QuickPhraseEvent>;
  recentPhraseEvent?: QuickPhraseEvent | null;
  matchEvents?: MatchEvent[];
}

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
  /** 服务端权威大厅快照（welcome 与 lobby.state 携带同一份结构）。 */
  lobby: LobbyState | null;
  /** 最近一次大厅操作拒绝（非致命，连接保持）。 */
  lastRejection: LobbyRejection | null;
  /** 在途大厅请求；收到权威状态或拒绝后清空。 */
  pendingCommand: LobbyRequestKind | null;
  /** 当前权威对局状态（未开局前为 null）。 */
  game: GameClientState | null;
  /** 当前往返延迟（毫秒）；未测得或断线时为 null。 */
  rtt: number | null;
  /** 是否处于断线重连中。 */
  reconnecting: boolean;
  /** 最近一次是否为刚重连成功（触发 3 秒 toast）。 */
  justReconnected: boolean;
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
  /** 手动取消等待退避并立即尝试重连。 */
  reconnect(): void;
  subscribe(listener: (state: ConnectionState) => void): () => void;
  getState(): ConnectionState;
  /** 当前连接的地址（握手成功或连接中），供「最近房间」记录使用。 */
  getAddress(): string | null;
  /** 房主修改分先/局时设置（服务端权威校验，客人调用会被非致命拒绝）。 */
  sendLobbySettings(sidePreference: SidePreference, timeControlId: TimeControlId): void;
  /** 房主锁定/解锁设置。 */
  sendLobbyLock(locked: boolean): void;
  /** 本人准备/取消准备（绑定当前设置版本，服务端拒绝过期准备）。 */
  sendLobbyReady(ready: boolean): void;
  /** 房主请求开始对局（服务端执行门禁并一次性冻结开局参数）。 */
  sendLobbyStart(): void;
  /** 结算后选择再来一局或返回大厅。 */
  sendLobbyReturn(intent: 'return-lobby' | 'rematch'): void;
  /** 发送对局动作（翻牌/移动/吃子），本地先乐观执行。 */
  sendGameAction(action: MatchAction): { ok: boolean; reason?: string };
  /** 发起协商（悔棋 undo 或求和 draw）。 */
  sendGameNegotiate(kind: 'undo' | 'draw'): { ok: boolean; reason?: string };
  /** 回应协商请求（agree: boolean）。 */
  sendGameNegotiateReply(agree: boolean): { ok: boolean; reason?: string };
  /** 主动认输。 */
  sendGameResign(): { ok: boolean; reason?: string };
  /** 显式请求权威对局同步。 */
  requestGameSync(): void;
  /** 发送快捷短语互动（服务端白名单与冷却防刷）。 */
  sendChatPhrase(phraseId: string): { ok: boolean; reason?: string };
}

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
export const ACTION_RECOVERY_MS = 3_000;
export const SYNC_TIMEOUT_MS = 3_000;
export const STATE_AUDIT_INTERVAL_MS = 5_000;
const SOCKET_OPEN = 1;

function isStaleClockSample(incoming: MatchClockSnapshot, current: MatchClockSnapshot | null): boolean {
  // Protocol 6 increments sampleSeq on clock transitions, not on every broadcast.
  return current !== null && (incoming.sampleSeq < current.sampleSeq ||
    (incoming.sampleSeq === current.sampleSeq && incoming.serverTime <= current.serverTime));
}

const IDLE_STATE: ConnectionState = {
  status: 'idle',
  errorCode: null,
  message: null,
  roomId: null,
  memberId: null,
  role: null,
  members: [],
  closedReason: null,
  lobby: null,
  lastRejection: null,
  pendingCommand: null,
  game: null,
  rtt: null,
  reconnecting: false,
  justReconnected: false,
};

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function generateRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface RoomClientOptions {
  webSocketFactory?: WebSocketFactory;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectDelays?: readonly number[];
  reconnectBudgetMs?: number;
  clock?: { now(): number };
  random?: () => number;
}

export class RoomClient implements RoomConnection {
  private readonly webSocketFactory: WebSocketFactory;
  private readonly connectTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectDelays: readonly number[];
  private readonly reconnectBudgetMs: number;
  private readonly clock?: { now(): number };
  private readonly random: () => number;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = IDLE_STATE;
  private socket: WebSocketLike | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private justReconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private joinedAddress: string | null = null;
  private savedAddress: ParsedAddress | null = null;
  private savedJoinOptions: JoinOptions | null = null;
  private savedRoomId: string | null = null;
  private savedResumeToken: string | null = null;
  private pingSeq = 0;
  private pendingPingSeq: number | null = null;
  private pingSentAt = 0;
  private clockOffsetMs = 0;
  private reconnectStartTime: number | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private pendingSyncRequestId: string | null = null;
  private pendingVersionRequestId: string | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private actionRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private stateAuditTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly retiredMatchIds = new Set<string>();
  private pendingChatRequestId: string | null = null;
  private pendingControlRequestId: string | null = null;

  constructor(options: RoomClientOptions = {}) {
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.reconnectDelays = options.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS;
    this.reconnectBudgetMs = options.reconnectBudgetMs ?? DEFAULT_RECONNECT_BUDGET_MS;
    this.clock = options.clock;
    this.random = options.random ?? Math.random;
  }

  private now(): number {
    return this.clock ? this.clock.now() : Date.now();
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

    if (this.state.status === 'connecting' || this.reconnecting) {
      this.teardown();
    }

    this.reconnecting = false;
    this.savedAddress = address;
    this.savedJoinOptions = options;
    this.savedRoomId = null;
    this.savedResumeToken = options.token ?? null;
    this.reconnectStartTime = null;
    this.reconnectAttempt = 0;

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

    this.reconnecting = false;
    this.savedRoomId = null;
    this.savedResumeToken = null;
    this.teardown();
    this.generation += 1;
    this.setState({ ...IDLE_STATE, status: 'disconnected' });
  }

  /** 手动取消等待退避并立即尝试重连。 */
  reconnect(): void {
    if (!this.reconnecting && this.state.status !== 'reconnecting') {
      return;
    }
    this.attemptReconnect();
  }

  /** 当前连接的地址（握手成功或连接中），供「最近房间」记录使用。 */
  getAddress(): string | null {
    return this.joinedAddress;
  }

  /** 旁观者只读：true 表示当前身份为旁观者。 */
  private isSpectator(): boolean {
    return this.state.role === 'spectator';
  }

  /** 旁观拦截：在生成乐观局面或发送任何消息之前返回拒绝原因。 */
  private spectatorBlock(): { ok: false; reason: string } | null {
    return this.isSpectator() ? { ok: false, reason: '旁观模式下不可操作，仅可观看' } : null;
  }

  sendLobbySettings(sidePreference: SidePreference, timeControlId: TimeControlId): void {
    const roomId = this.state.roomId;
    if (!roomId || this.isSpectator()) {
      return;
    }
    this.sendLobbyRequest('settings', buildClientLobbySettings(roomId, { sidePreference, timeControlId }));
  }

  sendLobbyLock(locked: boolean): void {
    const roomId = this.state.roomId;
    if (!roomId || this.isSpectator()) {
      return;
    }
    this.sendLobbyRequest('lock', buildClientLobbyLock(roomId, locked));
  }

  sendLobbyReady(ready: boolean): void {
    const roomId = this.state.roomId;
    const settingsVersion = this.state.lobby?.settings.settingsVersion;
    if (!roomId || typeof settingsVersion !== 'number' || this.isSpectator()) {
      return;
    }
    this.sendLobbyRequest('ready', buildClientLobbyReady(roomId, ready, settingsVersion));
  }

  sendLobbyStart(): void {
    const roomId = this.state.roomId;
    if (!roomId || this.isSpectator()) {
      return;
    }
    this.sendLobbyRequest('start', buildClientLobbyStart(roomId));
  }

  sendLobbyReturn(intent: 'return-lobby' | 'rematch'): void {
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN || this.isSpectator()) {
      return;
    }
    const matchId = this.state.game?.matchId;
    const roomId = this.state.roomId;
    if (!matchId || !roomId) {
      return;
    }
    try {
      socket.send(encodeMessage(buildClientLobbyReturn(roomId, { matchId, intent })));
    } catch {
      // 忽略发送失败
    }
  }

  sendGameAction(action: MatchAction): { ok: boolean; reason?: string } {
    const blocked = this.spectatorBlock();
    if (blocked) {
      return blocked;
    }
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return { ok: false, reason: '连接未就绪' };
    }

    const game = this.state.game;
    if (!game) {
      return { ok: false, reason: '对局未开始' };
    }

    if (game.gameState.winner !== null) {
      return { ok: false, reason: '对局已经结束，请重新开局' };
    }

    if (game.pendingNegotiation !== null) {
      return { ok: false, reason: '协商进行中，操作已锁定' };
    }

    if (game.pendingAction !== null) {
      return { ok: false, reason: '上一操作处理中，请稍候' };
    }

    const mySide =
      this.state.memberId === game.startParameters.redMemberId
        ? 'red'
        : this.state.memberId === game.startParameters.blackMemberId
          ? 'black'
          : null;

    if (!mySide) {
      return { ok: false, reason: '非对局成员' };
    }

    if (game.gameState.currentTurn !== mySide) {
      return { ok: false, reason: '当前非己方回合' };
    }

    // 合法性、翻牌结果与胜负一律由服务器裁决：客户端只做公开门禁并提交，
    // 不调用规则推演，也不在本地改写棋盘。
    const requestId = generateRequestId();
    const stepNumber = game.stepNumber;

    try {
      socket.send(
        encodeMessage(
          buildClientGameAction(this.state.roomId!, {
            requestId,
            matchId: game.matchId,
            stepNumber,
            revision: game.revision,
            action,
          }),
        ),
      );
    } catch {
      return { ok: false, reason: '网络发送失败' };
    }

    this.setState({
      ...this.state,
      game: {
        ...game,
        pendingAction: {
          requestId,
          stepNumber,
          action,
        },
        lastAcceptedAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
      },
    });

    return { ok: true };
  }

  sendGameNegotiate(kind: 'undo' | 'draw'): { ok: boolean; reason?: string } {
    const blocked = this.spectatorBlock();
    if (blocked) {
      return blocked;
    }
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return { ok: false, reason: '连接未就绪' };
    }
    const game = this.state.game;
    if (!game) {
      return { ok: false, reason: '对局未开始' };
    }
    if (game.settlement !== null || game.gameState.winner !== null) {
      return { ok: false, reason: '对局已结束' };
    }
    if (game.pendingNegotiation !== null) {
      return { ok: false, reason: '已有协商正在进行中' };
    }
    const myMemberId = this.state.memberId;
    if (!myMemberId) {
      return { ok: false, reason: '未获取玩家信息' };
    }
    if (kind === 'undo') {
      if (game.stepNumber === 0) {
        return { ok: false, reason: '当前尚无可悔棋步数' };
      }
    } else if (kind === 'draw') {
      const cooldownUntil = game.drawCooldownUntil[myMemberId] ?? 0;
      const now = this.now();
      if (cooldownUntil > now) {
        const remainingSeconds = Math.ceil((cooldownUntil - now) / 1000);
        return { ok: false, reason: `求和冷却中，请等待 ${remainingSeconds} 秒` };
      }
    }

    const requestId = generateRequestId();
    this.pendingControlRequestId = requestId;
    try {
      socket.send(
        encodeMessage(
          buildClientGameNegotiate(this.state.roomId!, {
            requestId,
            matchId: game.matchId,
            revision: game.revision,
            kind,
          }),
        ),
      );
    } catch {
      return { ok: false, reason: '网络发送失败' };
    }
    return { ok: true };
  }

  sendGameNegotiateReply(agree: boolean): { ok: boolean; reason?: string } {
    const blocked = this.spectatorBlock();
    if (blocked) {
      return blocked;
    }
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return { ok: false, reason: '连接未就绪' };
    }
    const game = this.state.game;
    if (!game || !game.pendingNegotiation) {
      return { ok: false, reason: '当前无待回应的协商' };
    }
    if (game.pendingNegotiation.responderMemberId !== this.state.memberId) {
      return { ok: false, reason: '非协商目标玩家' };
    }

    const requestId = generateRequestId();
    this.pendingControlRequestId = requestId;
    try {
      socket.send(
        encodeMessage(
          buildClientGameNegotiateReply(this.state.roomId!, {
            requestId,
            matchId: game.matchId,
            negotiationId: game.pendingNegotiation.negotiationId,
            accept: agree,
          }),
        ),
      );
    } catch {
      return { ok: false, reason: '网络发送失败' };
    }
    return { ok: true };
  }

  sendGameResign(): { ok: boolean; reason?: string } {
    const blocked = this.spectatorBlock();
    if (blocked) {
      return blocked;
    }
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return { ok: false, reason: '连接未就绪' };
    }
    const game = this.state.game;
    if (!game) {
      return { ok: false, reason: '对局未开始' };
    }
    if (game.settlement !== null || game.gameState.winner !== null) {
      return { ok: false, reason: '对局已结束' };
    }

    const requestId = generateRequestId();
    this.pendingControlRequestId = requestId;
    try {
      socket.send(
        encodeMessage(
          buildClientGameResign(this.state.roomId!, {
            requestId,
            matchId: game.matchId,
            revision: game.revision,
          }),
        ),
      );
    } catch {
      return { ok: false, reason: '网络发送失败' };
    }
    return { ok: true };
  }

  /**
   * 轻量版本核对：只问服务端当前 matchId/revision，不请求完整棋局。
   * 只有版本不一致（或事件缺口）才走 {@link requestGameSync} 的权威同步。
   */
  requestGameVersion(): void {
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return;
    }
    const roomId = this.state.roomId;
    if (!roomId) {
      return;
    }
    const game = this.state.game;
    const requestId = generateRequestId();
    this.pendingVersionRequestId = requestId;
    try {
      socket.send(
        encodeMessage(
          buildClientGameVersion(roomId, {
            requestId,
            matchId: game?.matchId ?? null,
            revision: game?.revision ?? null,
          }),
        ),
      );
    } catch {
      // 版本核对是尽力而为：发送失败交给心跳与下一轮巡检。
    }
  }

  requestGameSync(): void {
    if (this.pendingSyncRequestId) return;
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return;
    }
    const roomId = this.state.roomId;
    if (!roomId) {
      return;
    }
    const requestId = generateRequestId();
    this.pendingSyncRequestId = requestId;
    const generation = this.generation;
    this.syncTimer = setTimeout(() => {
      if (this.pendingSyncRequestId === requestId) {
        this.handleConnectionLost(generation, 'SYNC_TIMEOUT');
      }
    }, SYNC_TIMEOUT_MS);
    try {
      socket.send(encodeMessage(buildClientGameSync(roomId, this.state.game?.matchId, requestId)));
    } catch {
      this.handleConnectionLost(generation, 'SYNC_SEND_FAILED');
    }
  }

  sendChatPhrase(phraseId: string): { ok: boolean; reason?: string } {
    const blocked = this.spectatorBlock();
    if (blocked) {
      return blocked;
    }
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return { ok: false, reason: '连接未就绪' };
    }
    const game = this.state.game;
    if (!game) {
      return { ok: false, reason: '对局未开始' };
    }
    if (game.settlement !== null || game.gameState.winner !== null) {
      return { ok: false, reason: '对局已结束' };
    }
    if (!isQuickPhraseId(phraseId)) {
      return { ok: false, reason: '非法预置短语' };
    }
    const memberId = this.state.memberId;
    if (!memberId) {
      return { ok: false, reason: '未登录身份' };
    }
    const now = this.now();
    const cooldownUntil = game.phraseCooldownUntil?.[memberId] ?? 0;
    if (now < cooldownUntil) {
      const remaining = Math.ceil((cooldownUntil - now) / 1000);
      return { ok: false, reason: `短语发送冷却中（剩余 ${remaining} 秒）` };
    }

    const requestId = generateRequestId();
    this.pendingChatRequestId = requestId;
    try {
      socket.send(
        encodeMessage(
          buildClientChatPhrase(this.state.roomId!, {
            requestId,
            matchId: game.matchId,
            phraseId,
          }),
        ),
      );
    } catch {
      return { ok: false, reason: '网络发送失败' };
    }
    return { ok: true };
  }

  /** 发送大厅请求：记录在途类别供界面防连点；发送失败按本地错误提示，不动连接。 */
  private sendLobbyRequest(kind: LobbyRequestKind, message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || this.state.status !== 'connected' || socket.readyState !== SOCKET_OPEN) {
      return;
    }
    try {
      socket.send(encodeMessage(message));
    } catch {
      return;
    }
    this.setState({ ...this.state, pendingCommand: kind, lastRejection: null });
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
      const wasReconnecting = this.reconnecting;
      this.reconnecting = false;
      this.reconnectStartTime = null;
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.savedRoomId = message.payload.roomId;
      if (message.payload.resumeToken) {
        this.savedResumeToken = message.payload.resumeToken;
      }
      // 以 welcome 实际身份为准保存恢复参数：普通加入被分流为旁观、
      // 或显式旁观进入时，重连必须携带正确身份与本人恢复凭据。
      if (this.savedJoinOptions) {
        this.savedJoinOptions = {
          ...this.savedJoinOptions,
          role: message.payload.role,
          name: message.payload.name,
        };
      }

      const incomingGame = message.payload.game;
      let gameClientState: GameClientState | null = this.state.game;
      if (incomingGame) {
        gameClientState = {
          matchId: incomingGame.matchId,
          stepNumber: incomingGame.stepNumber,
          revision: incomingGame.revision,
          startParameters: incomingGame.startParameters,
          gameState: incomingGame.gameState,
          clock: incomingGame.clock ?? null,
          settlement: incomingGame.settlement ?? null,
          clockOffsetMs: this.clockOffsetMs,
          pendingAction: null,
          lastError: null,
          lastRejectedReason: null,
          statusNotice: null,
          lastAcceptedAction: null,
          pendingNegotiation: incomingGame.pendingNegotiation ?? null,
          drawCooldownUntil: incomingGame.drawCooldownUntil ?? {},
          phraseCooldownUntil: incomingGame.phraseCooldownUntil ?? {},
          negotiationEvent: incomingGame.negotiationEvent ?? null,
          recentPhraseEvents: {},
          recentPhraseEvent: null,
          matchEvents: incomingGame.matchEvents ?? [],
        };
      } else if (message.payload.lobby.phase === 'lobby') {
        gameClientState = null;
      }

      this.setState({
        status: 'connected',
        errorCode: null,
        message: null,
        roomId: message.payload.roomId,
        memberId: message.payload.memberId,
        role: message.payload.role,
        members: message.payload.members,
        closedReason: null,
        lobby: message.payload.lobby,
        lastRejection: null,
        pendingCommand: null,
        game: gameClientState,
        rtt: this.state.rtt,
        reconnecting: false,
        justReconnected: wasReconnecting,
      });

      if (wasReconnecting) {
        if (this.justReconnectedTimer) {
          clearTimeout(this.justReconnectedTimer);
        }
        this.justReconnectedTimer = setTimeout(() => {
          this.setState({ ...this.state, justReconnected: false });
        }, 3_000);
      }

      this.startHeartbeat(generation);
      this.startStateAudit(generation);
      return;
    }

    if (message.type === 'ping') {
      try {
        this.socket?.send(encodeMessage(buildPong(message.roomId, message.payload.seq)));
      } catch {
        // 忽略单个 pong 发送失败
      }
      return;
    }

    if (message.type === 'pong') {
      if (this.pendingPingSeq === message.payload.seq) {
        this.pendingPingSeq = null;
        if (this.heartbeatTimeoutTimer) {
          clearTimeout(this.heartbeatTimeoutTimer);
          this.heartbeatTimeoutTimer = null;
        }
        const now = this.now();
        const rtt = Math.max(0, Math.round(now - this.pingSentAt));
        if (
          typeof message.payload.serverReceiveTime === 'number' &&
          typeof message.payload.serverSendTime === 'number'
        ) {
          const t0 = this.pingSentAt;
          const t1 = message.payload.serverReceiveTime;
          const t2 = message.payload.serverSendTime;
          const t3 = now;
          this.clockOffsetMs = Math.round(((t1 - t0) + (t2 - t3)) / 2);
        }
        this.setState({
          ...this.state,
          rtt,
          game: this.state.game ? { ...this.state.game, clockOffsetMs: this.clockOffsetMs } : null,
        });
      }
      return;
    }

    if (message.type === 'members') {
      this.setState({ ...this.state, members: message.payload.members });
      return;
    }

    if (message.type === 'lobby.state') {
      const isLobbyPhase = message.payload.lobby.phase === 'lobby';
      if (isLobbyPhase && this.state.game) this.retiredMatchIds.add(this.state.game.matchId);
      if (isLobbyPhase) {
        this.pendingSyncRequestId = null;
        this.pendingVersionRequestId = null;
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = null;
      }
      // 权威状态到达即认为在途请求已有结果，同时清除上一条拒绝提示。
      this.setState({
        ...this.state,
        lobby: message.payload.lobby,
        lastRejection: null,
        pendingCommand: null,
        ...(isLobbyPhase ? { game: null } : {}),
      });
      return;
    }

    if (message.type === 'lobby.rejected') {
      const { code } = message.payload;
      this.setState({
        ...this.state,
        lastRejection: { code, message: describeLobbyReject(code) },
        pendingCommand: null,
      });
      return;
    }

    if (message.type === 'game.clock') {
      const { matchId, clock, revision, sampleSeq } = message.payload;
      const currentGame = this.state.game;
      if (!currentGame && this.state.lobby?.phase === 'started') this.requestGameSync();
      if (currentGame && currentGame.matchId === matchId) {
        if (revision > currentGame.revision) {
          this.requestGameSync();
          return;
        }
        if (revision < currentGame.revision || sampleSeq < (currentGame.clock?.sampleSeq ?? -1) ||
          isStaleClockSample(clock, currentGame.clock)) return;
        this.setState({
          ...this.state,
          game: {
            ...currentGame,
            clock,
            clockOffsetMs: this.clockOffsetMs,
          },
        });
      }
      return;
    }

    if (message.type === 'game.patch') {
      this.handleGamePatch(message);
      return;
    }

    if (message.type === 'game.version') {
      this.handleGameVersion(message);
      return;
    }

    if (message.type === 'game.receipt') {
      this.handleGameReceipt(message);
      return;
    }

    if (message.type === 'game.state') {
      const incoming = message.payload;
      const currentGame = this.state.game;
      if (this.retiredMatchIds.has(incoming.matchId) || (currentGame && currentGame.matchId !== incoming.matchId)) return;
      // 协议 v8 起 revision 必填：不再按旧格式（步号推算）兼容。
      const incomingRevision = incoming.revision;
      const isExplicitSync = Boolean(message.requestId && message.requestId === this.pendingSyncRequestId);
      if (isExplicitSync) {
        this.pendingSyncRequestId = null;
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = null;
      }
      if (message.requestId === this.pendingControlRequestId) this.pendingControlRequestId = null;

      if (currentGame && currentGame.matchId === incoming.matchId) {
        if (incomingRevision < currentGame.revision) {
          if (isExplicitSync && currentGame.pendingAction) this.requestGameSync();
          return;
        }
        if (incomingRevision === currentGame.revision && incoming.stepNumber < currentGame.stepNumber) {
          return;
        }
      }

      const startParameters = incoming.startParameters ?? currentGame?.startParameters;
      if (!startParameters) {
        return;
      }

      const incomingClock = currentGame?.clock && incoming.clock &&
        incomingRevision === currentGame.revision && isStaleClockSample(incoming.clock, currentGame.clock)
        ? currentGame.clock : incoming.clock;

      // 同一步且相同 revision 的重复广播：刷新公开局面，但不清除当前在途请求（等待同一份确认）
      if (
        currentGame &&
        currentGame.matchId === incoming.matchId &&
        incoming.stepNumber === currentGame.stepNumber &&
        incomingRevision === currentGame.revision
      ) {
        if (currentGame.pendingAction !== null && !isExplicitSync) {
          this.setState({
            ...this.state,
            game: {
              ...currentGame,
              gameState: incoming.state,
              clock: incomingClock ?? currentGame.clock,
              settlement: incoming.settlement !== undefined ? incoming.settlement : currentGame.settlement,
              revision: incomingRevision,
              pendingNegotiation: incoming.pendingNegotiation !== undefined ? incoming.pendingNegotiation : currentGame.pendingNegotiation,
              drawCooldownUntil: incoming.drawCooldownUntil ?? currentGame.drawCooldownUntil,
              phraseCooldownUntil: incoming.phraseCooldownUntil ?? currentGame.phraseCooldownUntil,
              negotiationEvent: incoming.negotiationEvent !== undefined ? incoming.negotiationEvent : currentGame.negotiationEvent,
              recentPhraseEvents: currentGame.recentPhraseEvents,
              recentPhraseEvent: currentGame.recentPhraseEvent,
              matchEvents: incoming.matchEvents ?? currentGame.matchEvents,
            },
          });
          return;
        }
      }

      const isUndoRollback = Boolean(currentGame && incoming.stepNumber < currentGame.stepNumber);
      const isJumpStep = Boolean(currentGame && incoming.stepNumber > currentGame.stepNumber + 1);
      const isHydration = isExplicitSync || isJumpStep || isUndoRollback;

      let pendingAction = currentGame?.pendingAction ?? null;
      let lastAcceptedAction: AcceptedGameAction | null = null;

      if (isHydration) {
        pendingAction = null;
        lastAcceptedAction = null;
      } else {
        const isMyAction = Boolean(incoming.actorMemberId && incoming.actorMemberId === this.state.memberId);
        const isMatchingPending = Boolean(
          pendingAction &&
          message.requestId &&
          message.requestId === pendingAction.requestId,
        );

        if (isMyAction && (isMatchingPending || !pendingAction)) {
          pendingAction = null;
          lastAcceptedAction = incoming.actorMemberId && incoming.action
            ? {
                eventId: `${incoming.matchId}:${incomingRevision}:${message.requestId ?? 'confirmed'}`,
                stepNumber: incoming.stepNumber - 1,
                actorMemberId: incoming.actorMemberId,
                action: incoming.action,
                source: 'local',
                confirmed: true,
              }
            : null;
        } else {
          if (pendingAction && incoming.stepNumber > pendingAction.stepNumber) {
            pendingAction = null;
          }
          lastAcceptedAction = incoming.actorMemberId && incoming.action
            ? {
                eventId: `${incoming.matchId}:${incomingRevision}:${incoming.actorMemberId}:${message.requestId ?? 'broadcast'}`,
                stepNumber: incoming.stepNumber - 1,
                actorMemberId: incoming.actorMemberId,
                action: incoming.action,
                source: 'remote',
                confirmed: true,
              }
            : null;
        }
      }

      this.setState({
        ...this.state,
        game: {
          matchId: incoming.matchId,
          stepNumber: incoming.stepNumber,
          revision: incomingRevision,
          startParameters,
          gameState: incoming.state,
          clock: incomingClock ?? currentGame?.clock ?? null,
          settlement: incoming.settlement !== undefined ? incoming.settlement : (currentGame?.settlement ?? null),
          clockOffsetMs: this.clockOffsetMs,
          pendingAction,
          lastError: null,
          lastRejectedReason: null,
          statusNotice: null,
          lastAcceptedAction,
          pendingNegotiation: incoming.pendingNegotiation !== undefined ? incoming.pendingNegotiation : (currentGame?.pendingNegotiation ?? null),
          drawCooldownUntil: incoming.drawCooldownUntil ?? currentGame?.drawCooldownUntil ?? {},
          phraseCooldownUntil: incoming.phraseCooldownUntil ?? currentGame?.phraseCooldownUntil ?? {},
          negotiationEvent: incoming.negotiationEvent !== undefined ? incoming.negotiationEvent : (currentGame?.negotiationEvent ?? null),
          recentPhraseEvents: currentGame?.recentPhraseEvents ?? {},
          recentPhraseEvent: currentGame?.recentPhraseEvent ?? null,
          matchEvents: incoming.matchEvents ?? currentGame?.matchEvents ?? [],
        },
      });
      return;
    }

    if (message.type === 'game.rejected') {
      this.handleGameRejected(message.payload, message.requestId);
      return;
    }

    if (message.type === 'chat.phrase') {
      const event = message.payload;
      const currentGame = this.state.game;
      if (currentGame && currentGame.matchId === event.matchId) {
        if (message.requestId && message.requestId === this.pendingChatRequestId) {
          this.pendingChatRequestId = null;
        }
        const nextCooldownUntil = {
          ...(currentGame.phraseCooldownUntil ?? {}),
          [event.senderMemberId]: event.nextAllowedAt,
        };
        const nextRecentPhraseEvents = {
          ...(currentGame.recentPhraseEvents ?? {}),
          [event.senderMemberId]: event,
        };
        this.setState({
          ...this.state,
          game: {
            ...currentGame,
            phraseCooldownUntil: nextCooldownUntil,
            recentPhraseEvents: nextRecentPhraseEvents,
            recentPhraseEvent: event,
          },
        });
      }
      return;
    }

    if (message.type === 'chat.phrase.rejected') {
      const rejection = message.payload;
      const currentGame = this.state.game;
      if (currentGame && currentGame.matchId === rejection.matchId) {
        if (message.requestId && message.requestId === this.pendingChatRequestId) {
          this.pendingChatRequestId = null;
        }
        const memberId = this.state.memberId;
        const nextCooldownUntil = rejection.retryAt && memberId
          ? {
              ...(currentGame.phraseCooldownUntil ?? {}),
              [memberId]: rejection.retryAt,
            }
          : currentGame.phraseCooldownUntil;

        this.setState({
          ...this.state,
          game: {
            ...currentGame,
            phraseCooldownUntil: nextCooldownUntil,
            statusNotice: rejection.message,
            lastRejectedReason: rejection.message,
          },
        });
      }
      return;
    }

    if (message.type === 'room.closed') {
      this.clearTimer();
      this.stopHeartbeat();
      this.reconnecting = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const reason = message.payload.reason;
      this.setState({
        ...this.state,
        status: 'disconnected',
        reconnecting: false,
        rtt: null,
        closedReason: reason,
        message: describeRoomClosed(reason),
      });
      this.teardown();
      this.generation += 1;
      return;
    }

    if (message.type === 'error') {
      const code = message.payload.code;
      if (code === 'UNAUTHORIZED' || code === 'ROOM_CLOSED' || code === 'VERSION_MISMATCH') {
        this.reconnecting = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      }
      this.fail(generation, code);
    }
  }

  /**
   * 公开增量补丁。
   *
   * - 只在与本地基线严格衔接（baseRevision === 本地 revision）时原子应用；
   * - 重复或更旧的补丁直接丢弃；
   * - 基线不衔接（漏包/乱序/旧局）不缓存、不猜测，交给既有权威同步；
   * - 只有携带 actorMemberId + action 的新补丁才产生一次动作反馈，
   *   eventId 由 matchId + revision 决定，重复补丁不会重播音效/动画。
   */
  private handleGamePatch(message: {
    requestId?: string;
    payload: {
      matchId: string;
      baseRevision: number;
      revision: number;
      stepNumber: number;
      changes: Parameters<typeof applyPublicGameDelta>[2];
      actorMemberId?: string;
      action?: MatchAction;
    };
  }): void {
    const patch = message.payload;
    const current = this.state.game;
    if (this.retiredMatchIds.has(patch.matchId)) {
      return;
    }
    if (!current || current.matchId !== patch.matchId) {
      // 没有这份棋局的基线：补丁不能凭空拼出局面。
      if (this.state.lobby?.phase === 'started') {
        this.requestGameSync();
      }
      return;
    }
    if (patch.revision <= current.revision) {
      return;
    }
    if (patch.baseRevision !== current.revision) {
      this.requestGameSync();
      return;
    }

    const applied = applyPublicGameDelta(current.gameState, current.matchEvents ?? [], patch.changes);
    if (!applied.ok) {
      this.requestGameSync();
      return;
    }

    const changes = patch.changes;
    // 补丁只在时钟状态转换时携带一次采样；同序号更旧的采样仍然丢弃。
    const nextClock =
      applied.clock === undefined
        ? current.clock
        : applied.clock === null
          ? null
          : isStaleClockSample(applied.clock, current.clock)
            ? current.clock
            : applied.clock;
    const clearsPending = Boolean(
      message.requestId && current.pendingAction && current.pendingAction.requestId === message.requestId,
    );
    const accepted: AcceptedGameAction | null =
      patch.actorMemberId && patch.action
        ? {
            eventId: `${patch.matchId}:${patch.revision}`,
            stepNumber: patch.stepNumber - 1,
            actorMemberId: patch.actorMemberId,
            action: patch.action,
            source: patch.actorMemberId === this.state.memberId ? 'local' : 'remote',
            confirmed: true,
          }
        : null;

    this.setState({
      ...this.state,
      game: {
        ...current,
        revision: patch.revision,
        stepNumber: patch.stepNumber,
        gameState: applied.gameState,
        matchEvents: applied.matchEvents,
        clock: nextClock,
        settlement: changes.settlement !== undefined ? changes.settlement : current.settlement,
        pendingNegotiation:
          changes.pendingNegotiation !== undefined ? changes.pendingNegotiation : current.pendingNegotiation,
        drawCooldownUntil: changes.drawCooldownUntil ?? current.drawCooldownUntil,
        phraseCooldownUntil: changes.phraseCooldownUntil ?? current.phraseCooldownUntil,
        negotiationEvent:
          changes.negotiationEvent !== undefined ? changes.negotiationEvent : current.negotiationEvent,
        pendingAction: clearsPending ? null : current.pendingAction,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: accepted,
      },
    });
  }

  /**
   * 版本核对应答：只比较身份与版本，不修改任何局面。
   * 只有与本轮请求 ID 匹配的应答才算数，迟到应答不会覆盖更新局面。
   */
  private handleGameVersion(message: {
    requestId?: string;
    payload: { matchId: string | null; revision: number | null };
  }): void {
    if (!message.requestId || message.requestId !== this.pendingVersionRequestId) {
      return;
    }
    this.pendingVersionRequestId = null;

    const current = this.state.game;
    if (!current) {
      if (message.payload.matchId !== null && this.state.lobby?.phase === 'started') {
        this.requestGameSync();
      }
      return;
    }
    if (message.payload.matchId !== current.matchId || message.payload.revision !== current.revision) {
      this.requestGameSync();
    }
  }

  /**
   * 重复动作回执：不重播旧效果，只按权威版本决定是否需要补齐。
   */
  private handleGameReceipt(message: {
    requestId?: string;
    payload: { matchId: string; revision: number; stepNumber: number };
  }): void {
    const current = this.state.game;
    if (!current || current.matchId !== message.payload.matchId) {
      if (this.state.lobby?.phase === 'started') {
        this.requestGameSync();
      }
      return;
    }
    const ownsPending = Boolean(
      message.requestId && current.pendingAction && current.pendingAction.requestId === message.requestId,
    );
    if (message.payload.revision > current.revision) {
      if (ownsPending) {
        this.setState({ ...this.state, game: { ...current, pendingAction: null } });
      }
      this.requestGameSync();
    }
  }

  /**
   * 精简拒绝：只清对应在途请求并给出原因；不采纳拒绝里的任何局面。
   * 权威版本领先本地时，交给既有权威同步补齐。
   */
  private handleGameRejected(
    payload: { matchId: string | null; revision: number | null; stepNumber: number; reason: string },
    requestId: string | undefined,
  ): void {
    if (requestId && requestId === this.pendingSyncRequestId) {
      this.pendingSyncRequestId = null;
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
      }
    }

    const current = this.state.game;
    const ownsPending = Boolean(
      current && requestId && current.pendingAction && current.pendingAction.requestId === requestId,
    );
    const ownsControl = Boolean(requestId && requestId === this.pendingControlRequestId);
    if (ownsControl) {
      this.pendingControlRequestId = null;
    }
    if (!current) {
      return;
    }
    if (!ownsPending && !ownsControl) {
      // 迟到或与本端在途请求无关的拒绝：不改变任何状态。
      return;
    }

    this.setState({
      ...this.state,
      game: {
        ...current,
        ...(ownsPending ? { pendingAction: null } : {}),
        lastError: payload.reason,
        lastRejectedReason: payload.reason,
        statusNotice: ownsPending ? '你的操作未被采纳，请重新操作' : payload.reason,
        ...(ownsPending ? { lastAcceptedAction: null } : {}),
      },
    });

    if (payload.revision !== null && payload.revision > current.revision) {
      this.requestGameSync();
    }
  }

  private handleClose(generation: number, code: number): void {
    if (generation !== this.generation) {
      return;
    }

    this.clearTimer();
    this.stopHeartbeat();
    this.socket = null;

    const serverCode = serverErrorCodeForCloseCode(code);

    if (serverCode === 'ROOM_CLOSED') {
      this.reconnecting = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.generation += 1;
      this.setState({
        ...this.state,
        status: 'disconnected',
        reconnecting: false,
        rtt: null,
        closedReason: 'host-closed',
        message: describeErrorCode('ROOM_CLOSED'),
      });
      return;
    }

    if (serverCode === 'UNAUTHORIZED' || serverCode === 'VERSION_MISMATCH') {
      this.reconnecting = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.fail(generation, serverCode);
      return;
    }

    if (this.reconnecting) {
      this.scheduleReconnect();
      return;
    }

    if (this.state.status === 'connected') {
      this.handleConnectionLost(generation, 'SOCKET_CLOSED');
      return;
    }

    this.fail(generation, serverCode ?? 'CONNECT_FAILED');
  }

  private handleConnectionLost(generation: number, _reason: string): void {
    if (generation !== this.generation) {
      return;
    }

    this.clearTimer();
    this.stopHeartbeat();
    this.stopStateRecovery();
    this.teardownSocket();

    // 仅已入房成员且有恢复凭据支持自动重连（客人/旁观者用 resumeToken，房主用 host token）
    const isGuest = this.savedJoinOptions?.role === 'guest';
    const isSpectator = this.savedJoinOptions?.role === 'spectator';
    const isHost = this.savedJoinOptions?.role === 'host';
    const canReconnectGuest = (isGuest || isSpectator) && this.savedRoomId && this.savedResumeToken && this.savedAddress;
    const canReconnectHost = isHost && this.savedRoomId && this.savedJoinOptions?.token && this.savedAddress;

    if (canReconnectGuest || canReconnectHost) {
      this.reconnecting = true;
      if (this.reconnectStartTime === null) {
        this.reconnectStartTime = this.now();
        this.reconnectAttempt = 0;
      }
      this.setState({
        ...this.state,
        status: 'reconnecting',
        reconnecting: true,
        rtt: null,
        pendingCommand: null,
        lastRejection: null,
        game: this.state.game
          ? {
              ...this.state.game,
              pendingAction: null,
              lastAcceptedAction: null,
            }
          : null,
      });
      this.scheduleReconnect();
      return;
    }

    this.generation += 1;
    this.setState({
      ...this.state,
      status: 'disconnected',
      reconnecting: false,
      rtt: null,
      message: '与房间的连接已断开 —— 网络波动或房主端关闭了连接 —— 请返回重新加入',
      game: this.state.game
        ? {
            ...this.state.game,
            pendingAction: null,
            lastAcceptedAction: null,
          }
        : null,
    });
  }

  private scheduleReconnect(): void {
    if (!this.reconnecting) {
      return;
    }
    this.clearTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const elapsed = this.now() - (this.reconnectStartTime ?? this.now());
    const delay = computeReconnectDelay(this.reconnectAttempt, this.reconnectDelays, this.random);
    const effectiveBudget = (this.state.game || this.state.lobby?.phase === 'started')
      ? Math.max(this.reconnectBudgetMs, 95_000)
      : this.reconnectBudgetMs;

    if (elapsed + delay >= effectiveBudget) {
      this.reconnecting = false;
      this.generation += 1;
      this.teardown();
      this.setState({
        ...this.state,
        status: 'disconnected',
        reconnecting: false,
        rtt: null,
        errorCode: 'HOST_UNAVAILABLE',
        message: '房间不可达，可能网络断开或房主退出，请检查网络后重新加入',
      });
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect();
    }, delay);
  }

  private attemptReconnect(): void {
    // A manual retry may skip backoff, but must share an active handshake.
    if (this.socket && this.socket.readyState <= SOCKET_OPEN) return;
    const isGuest = this.savedJoinOptions?.role === 'guest';
    const isSpectator = this.savedJoinOptions?.role === 'spectator';
    const isHost = this.savedJoinOptions?.role === 'host';
    const hasCredentials = ((isGuest || isSpectator) && this.savedResumeToken) || (isHost && this.savedJoinOptions?.token);

    if (
      !this.reconnecting ||
      !this.savedAddress ||
      !this.savedJoinOptions ||
      !this.savedRoomId ||
      !hasCredentials
    ) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.teardownSocket();
    const generation = ++this.generation;
    this.reconnectAttempt += 1;

    let socket: WebSocketLike;
    try {
      socket = this.webSocketFactory(toWebSocketUrl(this.savedAddress));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    this.timer = setTimeout(() => {
      if (generation !== this.generation) {
        return;
      }
      this.teardownSocket();
      this.scheduleReconnect();
    }, this.connectTimeoutMs);

    socket.onopen = () => {
      if (generation !== this.generation) {
        return;
      }
      try {
        const helloMsg = isHost
          ? buildClientHello({
              role: 'host',
              name: this.savedJoinOptions!.name,
              roomId: this.savedRoomId,
              token: this.savedJoinOptions!.token,
            })
          : buildClientHello({
              role: isSpectator ? 'spectator' : 'guest',
              name: this.savedJoinOptions!.name,
              roomId: this.savedRoomId,
              resumeToken: this.savedResumeToken!,
            });
        socket.send(encodeMessage(helloMsg));
      } catch {
        this.teardownSocket();
        this.scheduleReconnect();
      }
    };

    socket.onmessage = (event) => {
      if (generation !== this.generation) {
        return;
      }
      this.handleMessage(generation, event.data);
    };

    socket.onerror = () => {
      // 交由 onclose 处理
    };

    socket.onclose = (event) => {
      if (generation !== this.generation) {
        return;
      }
      this.handleClose(generation, event.code);
    };
  }

  private startHeartbeat(generation: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      this.runHeartbeat(generation);
    }, this.heartbeatIntervalMs);
  }

  private runHeartbeat(generation: number): void {
    if (generation !== this.generation || this.state.status !== 'connected') {
      return;
    }

    const socket = this.socket;
    const roomId = this.state.roomId;
    if (!socket || socket.readyState !== SOCKET_OPEN || !roomId) {
      return;
    }

    this.heartbeatTimer = setTimeout(() => {
      this.runHeartbeat(generation);
    }, this.heartbeatIntervalMs);

    if (this.pendingPingSeq !== null) {
      // 正在等待上一轮 ping 的 pong，已有超时定时器在监控
      return;
    }

    this.pingSeq += 1;
    const seq = this.pingSeq;
    this.pendingPingSeq = seq;
    this.pingSentAt = this.now();

    try {
      socket.send(encodeMessage(buildPing(roomId, seq, { clientTime: this.pingSentAt })));
    } catch {
      // 忽略发送失败
    }

    this.heartbeatTimeoutTimer = setTimeout(() => {
      if (generation !== this.generation) {
        return;
      }
      if (this.pendingPingSeq === seq) {
        this.handleConnectionLost(generation, 'HEARTBEAT_TIMEOUT');
      }
    }, this.heartbeatTimeoutMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer !== null) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
    this.pendingPingSeq = null;
  }

  /**
   * 5 秒巡检只核对版本：同版本时零完整快照、零投影。
   * 终局也要继续核对，因为最后的结算补丁可能丢失。
   * 有待确认动作时不巡检（等待态由动作恢复定时器负责强制同步）。
   */
  private startStateAudit(generation: number): void {
    if (this.stateAuditTimer) clearTimeout(this.stateAuditTimer);
    this.stateAuditTimer = setTimeout(() => {
      this.stateAuditTimer = null;
      if (generation !== this.generation || this.state.status !== 'connected') return;
      if ((this.state.game || this.state.lobby?.phase === 'started') && !this.state.game?.pendingAction) {
        this.requestGameVersion();
      }
      this.startStateAudit(generation);
    }, STATE_AUDIT_INTERVAL_MS);
  }

  private stopStateRecovery(): void {
    for (const timer of [this.syncTimer, this.actionRecoveryTimer, this.stateAuditTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.syncTimer = this.actionRecoveryTimer = this.stateAuditTimer = null;
    this.pendingSyncRequestId = null;
    this.pendingVersionRequestId = null;
    this.pendingControlRequestId = null;
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

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = () => undefined;
      try {
        socket.close(closeCodeForError('INTERNAL_ERROR'), 'client-teardown');
      } catch {
        // socket 可能已处于关闭态
      }
    }
  }

  private teardown(): void {
    this.clearTimer();
    this.stopHeartbeat();
    this.stopStateRecovery();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.justReconnectedTimer !== null) {
      clearTimeout(this.justReconnectedTimer);
      this.justReconnectedTimer = null;
    }
    this.teardownSocket();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setState(state: ConnectionState): void {
    const pending = state.game?.pendingAction;
    if (pending?.requestId !== this.state.game?.pendingAction?.requestId) {
      if (this.actionRecoveryTimer) clearTimeout(this.actionRecoveryTimer);
      this.actionRecoveryTimer = null;
      if (pending) {
        const generation = this.generation;
        this.actionRecoveryTimer = setTimeout(() => {
          this.actionRecoveryTimer = null;
          if (generation === this.generation && this.state.game?.pendingAction?.requestId === pending.requestId) {
            this.requestGameSync();
          }
        }, ACTION_RECOVERY_MS);
      }
    }
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
    case 'reconnecting':
      return '正在重连…';
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
