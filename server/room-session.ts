/**
 * 权威房间会话（RoomSession）：不依赖 HTTP / WebSocket / 监听端口的单房间权威核心。
 *
 * - 会话只面向 {@link SessionConnection} 连接端口（不透明 connectionId + 发送 + 关闭），
 *   可直接构造/销毁，不需要创建任何监听器；在线多房间与 LAN 单房间复用同一实现。
 * - 会话负责：接入与凭据、成员席位与角色、大厅/对局/计时/协商/短语的权威状态、
 *   当前连接归属校验、领域定时器（对局时钟、协商时限、旁观恢复窗口）与广播投递。
 * - 传输层负责：真实 socket、编解码与协议校验、握手超时、心跳探测与监听资源。
 * - 身份 / 席位 / 连接三层分离（见 ./room-identity.ts）：重连保持身份与席位、只替换连接；
 *   关闭或替换连接后的迟到消息与 close 回调携带原 connectionId，不会操作或下线新连接。
 * - 广播只交付本会话获准的当前连接（已完成握手且未被替换），握手未完成者不收对局广播。
 */
import { randomBytes } from 'node:crypto';
import {
  applyLobbyCommand,
  createLobbyState,
  snapshotLobbyState,
  type LobbyCommand,
  type LobbyRejectCode,
  type LobbyState,
} from '../src/network/lobby.js';
import {
  createMatch,
  finalizeMatch,
  finalizeMatchDraw,
  undoMatchAction,
  snapshotMatch,
  applyMatchAction,
  type MatchAction,
  type MatchSnapshot,
  type MatchState,
} from '../src/network/match.js';
import {
  DRAW_COOLDOWN_MS,
  NEGOTIATION_TIMEOUT_MS,
  type NegotiationEvent,
  type NegotiationEventType,
  type PendingNegotiation,
} from '../src/network/negotiation.js';
import type { PublicMatchSnapshot } from '../src/network/public-game.js';
import { projectMatchSnapshot } from './public-view.js';
import { diffPublicSnapshot, type PublicGameDelta } from '../src/network/public-patch.js';
import {
  buildServerChatPhrase,
  buildServerChatPhraseRejected,
  buildServerGameClock,
  buildServerGamePatch,
  buildServerGameReceipt,
  buildServerGameRecord,
  buildServerGameRecordUnavailable,
  buildServerGameRecords,
  buildServerGameRejected,
  buildServerGameVersion,
  buildServerMessage,
  closeCodeForError,
  getQuickPhraseText,
  isQuickPhraseId,
  QUICK_PHRASE_COOLDOWN_MS,
  type ClientMessage,
  type MemberSnapshot,
  type QuickChatRejection,
  type QuickPhraseEvent,
  type Role,
  type RoomClosedReason,
  type ServerErrorCode,
} from '../src/network/protocol.js';
import { FINISHED_RECORD_TTL_MS, FinishedRecordArchive, buildFinishedMatchRecord } from './finished-records.js';
import { defaultLogger, type Logger } from './log.js';
import {
  asMemberId,
  createAnonymousIdentityResolver,
  generateId,
  generateToken,
  type ConnectionId,
  type IdentityId,
  type IdentityResolver,
  type MemberId,
  type RoomIdentity,
  type RoomMemberRecord,
} from './room-identity.js';

/**
 * 连接端口：会话与传输层之间的最小契约。
 * `send` / `close` 均为尽力而为且幂等，不得抛出异常。
 */
export interface SessionConnection {
  readonly connectionId: ConnectionId;
  send(text: string): void;
  close(code: number, reason: string): void;
}

/**
 * 连接在会话中的状态：
 * - pending：已接入但尚未完成握手；
 * - active：已握手且是所属席位的当前连接；
 * - superseded：已握手但已被新连接替换（迟到消息按拒绝处理）；
 * - parted：本连接已主动离开；
 * - unknown：未接入或已断开清理。
 */
export type ConnectionStanding = 'unknown' | 'pending' | 'active' | 'superseded' | 'parted';

interface SessionConnectionRecord {
  connection: SessionConnection;
  /** hello 是否已完成（用于握手超时判定）。 */
  helloDone: boolean;
  /** 本连接当前承载的席位；主动离开后置空，被替换时保留以便拒绝迟到消息。 */
  member: RoomMemberRecord | null;
  /** 在线模式：传输层已按匿名凭据解析出的可信身份；LAN 模式为 null。 */
  identity: RoomIdentity | null;
}

/** 传输层准入上下文：在线连接必须携带已校验的可信身份。 */
export interface ConnectionAdmission {
  identity: RoomIdentity;
}

/**
 * 房间接入模式：
 * - lan：局域网单房间，沿用 hostToken / guest resumeToken 与等待阶段掉线关房；
 * - online：单入口多房间，身份由服务器匿名凭据解析，掉线保留席位供本人恢复。
 */
export type RoomMode = 'lan' | 'online';

export interface RoomSessionOptions {
  /** 房间号；缺省由服务端生成。 */
  roomId?: string;
  /** 房主凭据；缺省由服务端生成。 */
  hostToken?: string;
  logger?: Logger;
  /** 注入时间函数（毫秒时间戳），测试可注入受控时钟。 */
  nowFn?: () => number;
  /** 随机分先的一次性裁决（true = 房主执红），默认用密码学随机数，测试可注入。 */
  drawHostRed?: () => boolean;
  /** 随机洗牌种子（32 位无符号整数），默认用密码学随机数，测试可注入。 */
  drawSeed?: () => number;
  /** 时钟广播周期（毫秒），默认 1000ms。 */
  clockIntervalMs?: number;
  /** 旁观者掉线后的恢复窗口（毫秒），超时未恢复即清理记录，默认 95 秒。 */
  spectatorResumeWindowMs?: number;
  /** 身份解析：服务端生成或可信解析，不接受客户端自报身份；默认发匿名身份。 */
  identityResolver?: IdentityResolver;
  /** 标识生成（成员/旁观事件等），测试可注入确定值。 */
  randomId?: () => string;
  /** 凭据生成（host token / guest resumeToken / 旁观恢复凭据 / 协商标识）。 */
  randomToken?: () => string;
  /** 会话自身关闭（房主离开、显式关房等）时通知宿主：由传输层补齐广播投递与监听资源释放。 */
  onClose?: (reason: RoomClosedReason) => void;
  /** 终局棋谱保留时长（毫秒），默认 30 分钟；测试可注入受控值。 */
  recordTtlMs?: number;
  /** 接入模式，默认 lan（局域网单房间）。 */
  mode?: RoomMode;
  /** 在线模式下建房者的可信身份：只有该身份可取得房主席位。 */
  ownerIdentityId?: IdentityId;
}

const DEFAULT_CLOCK_INTERVAL_MS = 1_000;
const DEFAULT_SPECTATOR_RESUME_WINDOW_MS = 95_000;

function defaultDrawHostRed(): boolean {
  return randomBytes(1)[0] % 2 === 0;
}

function defaultDrawSeed(): number {
  if (process.env.TEST_ROOM_SEED) {
    const parsed = Number(process.env.TEST_ROOM_SEED);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff) {
      return parsed >>> 0;
    }
  }
  return randomBytes(4).readUInt32BE(0);
}

type LobbyClientMessage = Extract<ClientMessage, { type: `lobby.${string}` }>;

/** 已接受动作的去重记录：绑定对局与成员，避免旧局/他人命中同一 requestId。 */
interface ProcessedAction {
  matchId: string;
  memberId: string;
  revision: number;
  stepNumber: number;
}

export class RoomSession {
  readonly roomId: string;
  readonly hostToken: string;

  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly drawHostRed: () => boolean;
  private readonly drawSeed: () => number;
  private readonly resolveIdentity: IdentityResolver;
  private readonly randomId: () => string;
  private readonly randomToken: () => string;
  private readonly clockIntervalMs: number;
  private readonly spectatorResumeWindowMs: number;
  private readonly onClose: ((reason: RoomClosedReason) => void) | undefined;
  private readonly mode: RoomMode;
  private readonly ownerIdentityId: IdentityId | null;

  /** 连接登记：connectionId → 连接记录（含握手状态与承载席位）。 */
  private readonly connections = new Map<ConnectionId, SessionConnectionRecord>();
  /** 成员席位：host / guest 各一席，旁观者不占执色席位。 */
  private host: RoomMemberRecord | null = null;
  private guest: RoomMemberRecord | null = null;
  /** 旁观者注册表：不占执色席位，各自持有独立恢复凭据。 */
  private readonly spectators: RoomMemberRecord[] = [];
  private spectatorNameSeq = 0;
  private guestResumeToken: string | null = null;

  private readonly processedActions = new Map<string, ProcessedAction>();
  private readonly phraseCooldownUntil = new Map<string, number>();
  private readonly processedPhraseRequests = new Map<string, { event: QuickPhraseEvent }>();
  private readonly spectatorExpiryTimers = new Map<MemberId, NodeJS.Timeout>();
  /** 本房已结算对局的临时棋谱：按 matchId 独立保存，过期或被关闭即不可用。 */
  private readonly finishedRecords: FinishedRecordArchive;

  private lobby: LobbyState;
  private match: MatchState | null = null;
  /**
   * 已向全房间发布的公开棋局基线：增量补丁只从这里求差。
   * 欢迎单播与显式同步单播读取当前投影，但不修改本基线。
   */
  private published: PublicMatchSnapshot | null = null;
  private closed = false;

  private clockTimer: NodeJS.Timeout | null = null;
  private clockBroadcastInterval: NodeJS.Timeout | null = null;
  private negotiationTimer: NodeJS.Timeout | null = null;

  constructor(options: RoomSessionOptions = {}) {
    this.logger = options.logger ?? defaultLogger;
    this.now = options.nowFn ?? (() => Date.now());
    this.drawHostRed = options.drawHostRed ?? defaultDrawHostRed;
    this.drawSeed = options.drawSeed ?? defaultDrawSeed;
    this.resolveIdentity = options.identityResolver ?? createAnonymousIdentityResolver(options.randomId ?? generateId);
    this.randomId = options.randomId ?? generateId;
    this.randomToken = options.randomToken ?? generateToken;
    this.clockIntervalMs = options.clockIntervalMs ?? DEFAULT_CLOCK_INTERVAL_MS;
    this.spectatorResumeWindowMs = options.spectatorResumeWindowMs ?? DEFAULT_SPECTATOR_RESUME_WINDOW_MS;
    this.onClose = options.onClose;
    this.mode = options.mode ?? 'lan';
    this.ownerIdentityId = options.ownerIdentityId ?? null;
    this.roomId = options.roomId ?? generateId();
    this.hostToken = options.hostToken ?? generateToken();
    this.lobby = createLobbyState();
    this.finishedRecords = new FinishedRecordArchive({
      nowFn: this.now,
      ttlMs: options.recordTtlMs ?? FINISHED_RECORD_TTL_MS,
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 接入一条传输层连接：仅登记连接，握手由首条 hello / online.hello 完成。
   * 在线模式下传输层必须先按服务器凭据解析出身份并在此登记；缺失则整条连接
   * 只能收到 unauthorized，无法落座。
   */
  attach(connection: SessionConnection, admission?: ConnectionAdmission): void {
    if (this.closed) {
      connection.close(closeCodeForError('ROOM_CLOSED'), 'room-closed');
      return;
    }
    this.connections.set(connection.connectionId, {
      connection,
      helloDone: false,
      member: null,
      identity: admission?.identity ?? null,
    });
  }

  /** 连接在会话中的状态（供传输层做握手超时与心跳门禁）。 */
  getStanding(connectionId: ConnectionId): ConnectionStanding {
    const record = this.connections.get(connectionId);
    if (!record) {
      return 'unknown';
    }
    if (!record.helloDone) {
      return 'pending';
    }
    if (!record.member) {
      return 'parted';
    }
    return record.member.connectionId === connectionId ? 'active' : 'superseded';
  }

  /** 握手是否已完成（传输层据此取消握手超时、启动心跳）。 */
  isHelloComplete(connectionId: ConnectionId): boolean {
    return this.connections.get(connectionId)?.helloDone === true;
  }

  /** 处理一条已通过协议校验的客户端消息；迟到消息携带原 connectionId，不会影响新连接。 */
  handleMessage(connectionId: ConnectionId, message: ClientMessage): void {
    if (this.closed) {
      return;
    }
    const record = this.connections.get(connectionId);
    if (!record) {
      return;
    }
    const connection = record.connection;

    if (message.type === 'hello' || message.type === 'online.hello') {
      if (record.member) {
        this.reject(connection, 'INVALID_MESSAGE', 'duplicate-hello');
        return;
      }
      // 两种入口不互通：在线房间拒绝 LAN 自报角色的握手，LAN 房间也不接纳无自报角色
      // 的在线握手，避免任何入口以另一种入口的凭据模型落座。
      if (this.mode === 'online' && message.type === 'hello') {
        this.reject(connection, 'INVALID_MESSAGE', 'lan-hello-not-allowed');
        return;
      }
      if (this.mode === 'lan' && message.type === 'online.hello') {
        this.reject(connection, 'INVALID_MESSAGE', 'online-hello-not-allowed');
        return;
      }
      if (message.roomId !== null && message.roomId !== this.roomId) {
        this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
        return;
      }
      let member: RoomMemberRecord | null;
      if (message.type === 'hello') {
        member = this.admitMember(connection, message.payload);
      } else {
        if (!record.identity) {
          this.reject(connection, 'UNAUTHORIZED', 'online-identity-missing');
          return;
        }
        member = this.admitOnlineMember(connection, record.identity);
      }
      if (!member) {
        return;
      }
      record.member = member;
      record.helloDone = true;

      // 先落座再发 welcome：快照里带上本人 presence，其他成员收 lobby.state。
      // 旁观者不占执色、不进入准备就绪流程，不改动 presence/ready。
      if (member.role !== 'spectator') {
        this.applyLobby({ type: 'member-joined', role: member.role }, connectionId);
      }

      // 恢复凭据按真实身份发放：客人用全局 guest token，旁观者用本人独立 token。
      // 在线房间不使用 LAN 恢复凭据：身份由同源匿名凭据承载，welcome 不携带任何密钥。
      const resumeToken =
        this.mode !== 'lan'
          ? undefined
          : member.role === 'guest'
            ? this.guestResumeToken ?? undefined
            : member.role === 'spectator'
              ? member.resumeToken
              : undefined;

      connection.send(
        buildServerMessage({
          type: 'welcome',
          roomId: this.roomId,
          payload: {
            roomId: this.roomId,
            memberId: member.memberId,
            role: member.role,
            name: member.name,
            members: this.getMembers(),
            lobby: this.getLobby(),
            ...(resumeToken ? { resumeToken } : {}),
            ...(this.match ? { game: projectMatchSnapshot(this.match, this.now()) } : {}),
            records: this.finishedRecords.summaries(),
          },
        }),
      );
      this.broadcastMembers();
      this.logger('ws.joined', { room: this.roomId, member: member.memberId, role: member.role });
      return;
    }

    // 席位与当前连接校验：按席位记录比对当前连接，防止旧连接在被新连接替换后继续操作。
    const member = record.member;
    if (!member) {
      this.reject(connection, 'INVALID_MESSAGE', 'not-handshaked');
      return;
    }
    if (member.connectionId !== connectionId) {
      this.reject(connection, 'UNAUTHORIZED', 'socket-superseded');
      return;
    }

    if (message.type === 'leave') {
      if (message.roomId !== this.roomId) {
        this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
        return;
      }
      this.logger('ws.leave', { room: this.roomId, member: member.memberId });
      record.member = null;
      this.depart(member, connection, 'leave');
      return;
    }

    // 旁观者只读：leave、game.sync、game.version 之外的一切消息在进入任何
    // 会修改大厅/对局的 handler 前拒绝，且只回复请求方、无其他副作用。
    if (member.role === 'spectator') {
      if (message.type === 'game.sync') {
        this.handleGameSync(connection, member, message);
        return;
      }
      if (message.type === 'game.version') {
        this.handleGameVersion(connection, message);
        return;
      }
      if (message.type === 'game.record.request') {
        this.handleGameRecordRequest(connection, member, message);
        return;
      }
      this.rejectSpectatorAction(connection, message);
      return;
    }

    if (message.type === 'lobby.return') {
      this.handleLobbyReturn(connection, member, message);
      return;
    }

    if (
      message.type === 'lobby.settings' ||
      message.type === 'lobby.lock' ||
      message.type === 'lobby.ready' ||
      message.type === 'lobby.start'
    ) {
      this.handleLobbyMessage(connection, member, message);
      return;
    }

    if (message.type === 'game.action') {
      this.handleGameAction(connection, member, message);
      return;
    }

    if (message.type === 'game.negotiate') {
      this.handleGameNegotiate(connection, member, message);
      return;
    }

    if (message.type === 'game.negotiate.reply') {
      this.handleGameNegotiateReply(connection, member, message);
      return;
    }

    if (message.type === 'game.resign') {
      this.handleGameResign(connection, member, message);
      return;
    }

    if (message.type === 'game.sync') {
      this.handleGameSync(connection, member, message);
      return;
    }

    if (message.type === 'game.version') {
      this.handleGameVersion(connection, message);
      return;
    }

    if (message.type === 'game.record.request') {
      this.handleGameRecordRequest(connection, member, message);
      return;
    }

    if (message.type === 'chat.phrase') {
      this.handleChatPhrase(connection, member, message);
      return;
    }

    this.reject(connection, 'INVALID_MESSAGE', 'unexpected-type');
  }

  /**
   * 连接断开：只影响该连接承载的席位；若席位已被新连接替换，
   * 迟到的 close 不会把新连接标为离线。
   */
  handleDisconnect(connectionId: ConnectionId, code = 1006, reason = ''): void {
    const record = this.connections.get(connectionId);
    if (!record) {
      return;
    }
    this.logger('ws.disconnected', {
      room: this.roomId,
      conn: connectionId,
      code,
      reason,
      role: record.member?.role,
    });
    this.connections.delete(connectionId);

    const member = record.member;
    if (!member) {
      return;
    }
    if (member.connectionId !== connectionId) {
      return;
    }
    this.handleMemberDrop(member);
  }

  getMembers(): MemberSnapshot[] {
    const members: MemberSnapshot[] = [];
    if (this.host) {
      members.push(this.memberSnapshot(this.host));
    }
    if (this.guest) {
      members.push(this.memberSnapshot(this.guest));
    }
    for (const spectator of this.spectators) {
      members.push(this.memberSnapshot(spectator));
    }
    return members;
  }

  /** 当前权威大厅快照（独立副本，测试与内部状态隔离）。 */
  getLobby(): LobbyState {
    return snapshotLobbyState(this.lobby);
  }

  /**
   * 当前权威对局快照（无对局时为 null）。
   * 仅供服务端内部与测试观测，含完整棋局，禁止直接封包下发。
   */
  getMatch(): MatchSnapshot | null {
    return this.match ? snapshotMatch(this.match) : null;
  }

  /** 当前公开对局快照（与下发给客户端的形状一致，供测试与只读观测使用）。 */
  getPublicMatch(): PublicMatchSnapshot | null {
    return this.match ? projectMatchSnapshot(this.match, this.now()) : null;
  }

  isHostConnected(): boolean {
    return Boolean(this.host?.connected);
  }

  getLobbyPhase(): LobbyState['phase'] {
    return this.lobby.phase;
  }

  /**
   * 关闭会话（幂等）：向全部连接投递 room.closed 并关闭连接、释放领域状态与定时器，
   * 最后通知宿主（传输层）补齐监听资源释放。
   */
  close(reason: RoomClosedReason = 'host-closed'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.logger('room.closing', { room: this.roomId, reason });

    const notice = buildServerMessage({
      type: 'room.closed',
      roomId: this.roomId,
      payload: { reason },
    });
    for (const record of [...this.connections.values()]) {
      record.connection.send(notice);
      record.connection.close(closeCodeForError('ROOM_CLOSED'), reason);
    }

    if (this.host) {
      this.host.connected = false;
      this.host.connectionId = null;
    }
    if (this.guest) {
      this.guest.connected = false;
      this.guest.connectionId = null;
    }
    for (const spectator of this.spectators) {
      spectator.connected = false;
      spectator.connectionId = null;
    }
    for (const timer of this.spectatorExpiryTimers.values()) {
      clearTimeout(timer);
    }
    this.spectatorExpiryTimers.clear();

    this.stopClockBroadcast();
    this.clearClockTimer();
    this.clearNegotiationTimer();
    this.processedActions.clear();
    this.phraseCooldownUntil.clear();
    this.processedPhraseRequests.clear();
    this.guestResumeToken = null;
    this.match = null;
    this.finishedRecords.dispose();

    this.onClose?.(reason);
    this.logger('room.closed', { room: this.roomId, reason });
  }

  private memberSnapshot(member: RoomMemberRecord): MemberSnapshot {
    return {
      id: member.memberId,
      role: member.role,
      name: member.name,
      connected: member.connected,
      ...(member.connected || !member.leaveReason ? {} : { leaveReason: member.leaveReason }),
    };
  }

  /**
   * 投递给本会话获准的当前连接：必须已完成握手、已落在本房间成员席位上，
   * 且席位当前绑定的就是这条连接（未握手、其他房间与已被替换的旧连接都收不到）。
   */
  private broadcast(text: string, exclude?: ConnectionId): void {
    for (const record of this.connections.values()) {
      if (exclude && record.connection.connectionId === exclude) {
        continue;
      }
      if (!record.helloDone || !record.member || record.member.connectionId !== record.connection.connectionId) {
        continue;
      }
      record.connection.send(text);
    }
  }

  private startClockBroadcast(): void {
    this.stopClockBroadcast();
    this.clockBroadcastInterval = setInterval(() => {
      this.broadcastClock();
    }, this.clockIntervalMs);
  }

  private stopClockBroadcast(): void {
    if (this.clockBroadcastInterval) {
      clearInterval(this.clockBroadcastInterval);
      this.clockBroadcastInterval = null;
    }
  }

  private clearClockTimer(): void {
    if (this.clockTimer) {
      clearTimeout(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private clearNegotiationTimer(): void {
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer);
      this.negotiationTimer = null;
    }
  }

  private scheduleNegotiationDeadline(matchId: string, negotiationId: string, deadline: number): void {
    this.clearNegotiationTimer();
    const delay = Math.max(0, deadline - this.now());
    this.negotiationTimer = setTimeout(() => {
      this.handleNegotiationTimeout(matchId, negotiationId);
    }, delay);
  }

  private recordMatchEvent(
    type: NegotiationEventType | 'game-started' | 'game-ended',
    actorMemberId: string,
    result: string,
    message: string,
    now: number = this.now(),
  ): NegotiationEvent {
    const event: NegotiationEvent = {
      id: `evt-${now}-${Math.random().toString(36).slice(2, 7)}`,
      type: type as NegotiationEventType,
      actorMemberId,
      createdAt: now,
      message,
    };
    if (this.match) {
      this.match.negotiationEvent = event;
      this.match.matchEvents.push({
        id: event.id,
        type,
        actorMemberId,
        stepNumber: this.match.stepNumber,
        revision: this.match.revision,
        result,
        createdAt: now,
        message,
      });
    }
    return event;
  }

  private handleNegotiationTimeout(matchId: string, negotiationId: string): void {
    if (!this.match || this.match.matchId !== matchId) {
      return;
    }
    const pending = this.match.pendingNegotiation;
    if (!pending || pending.negotiationId !== negotiationId) {
      return;
    }

    const now = this.now();
    this.match.clock.resumeNegotiation(now);

    if (pending.type === 'draw') {
      this.match.drawCooldownUntil[pending.initiatorMemberId] = now + DRAW_COOLDOWN_MS;
    }

    const eventType: NegotiationEventType = pending.type === 'undo' ? 'undo-timeout' : 'draw-timeout';
    const message = pending.type === 'undo' ? '悔棋申请超时未应答，已自动拒绝' : '求和申请超时未应答，已自动拒绝';
    this.match.pendingNegotiation = null;
    // 先推进版本再记录事件：matchEvents 里的 revision 必须指向本次提交。
    this.match.revision++;
    this.recordMatchEvent(eventType, pending.initiatorMemberId, 'timeout', message, now);

    this.publishGame();
    this.scheduleClockDeadline();
  }

  private scheduleClockDeadline(): void {
    this.clearClockTimer();
    if (!this.match || this.match.settlement !== null) {
      return;
    }
    const next = this.match.clock.getNextDeadlineTime(this.now());
    if (next === null) {
      return;
    }
    const delay = Math.max(0, next - this.now());
    this.clockTimer = setTimeout(() => {
      this.checkClockDeadline();
    }, delay + 5);
  }

  private checkClockDeadline(): void {
    if (!this.match || this.match.settlement !== null || this.closed) {
      return;
    }
    const adv = this.match.clock.advance(this.now());
    if (adv.timeoutResult) {
      this.match = finalizeMatch(this.match, adv.timeoutResult.winner, adv.timeoutResult.reason, this.now());
      this.stopClockBroadcast();
      this.clearClockTimer();
      this.logger('game.timeout', {
        room: this.roomId,
        matchId: this.match.matchId,
        winner: adv.timeoutResult.winner ?? undefined,
        reason: adv.timeoutResult.reason,
      });
      this.publishGame();
    }
  }

  private broadcastClock(): void {
    if (!this.match || this.match.settlement !== null || this.closed) {
      return;
    }
    const adv = this.match.clock.advance(this.now());
    if (adv.timeoutResult) {
      this.match = finalizeMatch(this.match, adv.timeoutResult.winner, adv.timeoutResult.reason, this.now());
      this.stopClockBroadcast();
      this.clearClockTimer();
      this.logger('game.timeout', {
        room: this.roomId,
        matchId: this.match.matchId,
        winner: adv.timeoutResult.winner ?? undefined,
        reason: adv.timeoutResult.reason,
      });
      this.publishGame();
      return;
    }

    // 时钟广播只需要公开时钟，不为此构造整份对局快照。
    const clock = this.match.clock.getSnapshot(this.now());
    const text = buildServerMessage(
      buildServerGameClock(this.roomId, {
        matchId: this.match.matchId,
        revision: this.match.revision,
        sampleSeq: clock.sampleSeq,
        clock,
      }),
    );
    this.broadcast(text);
  }

  private handleLobbyMessage(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: LobbyClientMessage,
  ): void {
    // 旁观消息已在分发层拒绝；这里仅为类型收窄到执色玩家。
    if (member.role === 'spectator') {
      return;
    }
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    let command: LobbyCommand;
    switch (message.type) {
      case 'lobby.settings':
        command = {
          type: 'update-settings',
          actor: member.role,
          sidePreference: message.payload.sidePreference,
          timeControlId: message.payload.timeControlId,
        };
        break;
      case 'lobby.lock':
        command = { type: 'set-locked', actor: member.role, locked: message.payload.locked };
        break;
      case 'lobby.ready':
        command = {
          type: 'set-ready',
          actor: member.role,
          ready: message.payload.ready,
          settingsVersion: message.payload.settingsVersion,
        };
        break;
      default: {
        const host = this.host;
        const guest = this.guest;
        if (!host || !guest) {
          this.sendLobbyRejection(connection, 'MEMBER_MISSING', 'start-identity');
          return;
        }
        // 随机分先只在真正冻结时抽取一次；重复开始在状态机里先被拒绝，不会再抽。
        const needsDraw = this.lobby.phase === 'lobby' && this.lobby.settings.sidePreference === 'random';
        command = {
          type: 'start',
          actor: member.role,
          roomId: this.roomId,
          host: { memberId: host.memberId, name: host.name },
          guest: { memberId: guest.memberId, name: guest.name },
          hostRedWhenRandom: needsDraw ? this.drawHostRed() : null,
        };
        break;
      }
    }

    const result = applyLobbyCommand(this.lobby, command);
    if (!result.ok) {
      this.logger('lobby.rejected', { room: this.roomId, member: member.memberId, code: result.code, detail: result.detail });
      // 操作拒绝一律非致命：提示原因但保持连接，可继续其他操作。
      this.sendLobbyRejection(connection, result.code, result.detail);
      return;
    }

    if (result.changed) {
      this.lobby = result.state;
      this.logger('lobby.changed', {
        room: this.roomId,
        member: member.memberId,
        command: command.type,
        phase: result.state.phase,
        settingsVersion: result.state.settings.settingsVersion,
      });
      if (result.state.phase === 'started' && !this.match) {
        this.phraseCooldownUntil.clear();
        this.processedPhraseRequests.clear();
        const seed = this.drawSeed();
        const matchId = this.randomId();
        this.match = createMatch({
          matchId,
          seed,
          startParameters: result.state.startParameters!,
          nowFn: this.now,
          // 公开棋子 ID 使用与本局布局种子无关的安全随机源。
          publicIdFactory: () => this.randomToken(),
        });
        this.logger('game.started', { room: this.roomId, matchId, seed });
        this.startClockBroadcast();
        this.scheduleClockDeadline();
      }
      // 发起者同样收到权威状态：既确认操作成功，也清除在途请求。
      this.broadcastLobby();
      if (this.match) {
        this.publishGame();
      }
    }
  }

  private applyLobby(command: LobbyCommand, exclude?: ConnectionId): void {
    const result = applyLobbyCommand(this.lobby, command);
    if (result.ok && result.changed) {
      this.lobby = result.state;
      this.broadcastLobby(exclude);
    }
  }

  /** 广播权威大厅快照（welcome 与 lobby.state 携带同一份结构）。 */
  private broadcastLobby(exclude?: ConnectionId): void {
    const text = buildServerMessage({
      type: 'lobby.state',
      roomId: this.roomId,
      payload: { lobby: this.getLobby() },
    });
    this.broadcast(text, exclude);
  }

  private sendLobbyRejection(connection: SessionConnection, code: LobbyRejectCode, detail: string): void {
    connection.send(
      buildServerMessage({
        type: 'lobby.rejected',
        roomId: this.roomId,
        payload: { code, message: detail },
      }),
    );
  }

  private handleMemberDrop(member: RoomMemberRecord): void {
    if (member.role === 'spectator') {
      member.connected = false;
      member.connectionId = null;
      member.leaveReason = 'dropped';
      // 旁观者掉线不影响对局：不暂停时钟、不取消协商、不动 ready/presence/revision。
      this.scheduleSpectatorExpiry(member);
      this.logger('ws.spectator_dropped', { room: this.roomId, member: member.memberId });
      this.broadcastMembers();
      return;
    }

    if (this.lobby.phase === 'started' && this.match) {
      if (this.match.pendingNegotiation) {
        this.clearNegotiationTimer();
        this.match.clock.resumeNegotiation(this.now());
        this.match.pendingNegotiation = null;
        this.match.negotiationEvent = {
          id: `evt-${this.now()}-${Math.random().toString(36).slice(2, 7)}`,
          type: 'negotiation-cancelled',
          actorMemberId: member.memberId,
          createdAt: this.now(),
          message: '成员连接中断，协商已取消',
        };
      }
      const now = this.now();
      const dropRes = this.match.clock.onDrop(member.role, now);
      this.match.revision++;
      if (dropRes.settlement) {
        this.match = finalizeMatch(this.match, dropRes.settlement.winner, dropRes.settlement.reason, now);
        this.stopClockBroadcast();
        this.clearClockTimer();
      } else {
        this.scheduleClockDeadline();
      }
    }

    if (member.role === 'host') {
      if (this.lobby.phase === 'started') {
        member.connected = false;
        member.connectionId = null;
        member.leaveReason = 'dropped';
        this.logger('ws.host_dropped', { room: this.roomId, member: member.memberId });
        this.applyLobby({ type: 'member-left', role: 'host' });
        this.broadcastMembers();
        if (this.match) {
          this.publishGame();
        }
        return;
      }
      this.logger('ws.host_dropped', { room: this.roomId, member: member.memberId });
      if (this.mode === 'online') {
        // 在线房间不以一次连接断开结束：保留房间与建房者席位，刷新/重连由本人凭据恢复。
        member.connected = false;
        member.connectionId = null;
        member.leaveReason = 'dropped';
        this.applyLobby({ type: 'member-left', role: 'host' });
        this.broadcastMembers();
        return;
      }
      // 大厅阶段房主掉线直接关房：会话关闭 → 传输层释放监听资源。
      this.close('host-disconnected');
      return;
    }

    member.connected = false;
    member.connectionId = null;
    member.leaveReason = 'dropped';
    this.logger('ws.guest_dropped', { room: this.roomId, member: member.memberId });
    this.applyLobby({ type: 'member-left', role: 'guest' });
    this.broadcastMembers();
    if (this.match) {
      this.publishGame();
    }
  }

  private depart(member: RoomMemberRecord, connection: SessionConnection, reason: 'leave'): void {
    if (member.role === 'spectator') {
      // 旁观者主动退出：撤销恢复凭据并清理记录，不影响对局与大厅状态。
      this.clearSpectatorExpiry(member.memberId);
      const index = this.spectators.indexOf(member);
      if (index >= 0) {
        this.spectators.splice(index, 1);
      }
      member.connected = false;
      member.connectionId = null;
      member.leaveReason = 'left';
      member.resumeToken = undefined;
      this.broadcastMembers();
      this.logger('ws.spectator_left', { room: this.roomId, member: member.memberId, reason });
      connection.close(1000, reason);
      return;
    }

    if (this.lobby.phase === 'started' && this.match) {
      if (this.match.pendingNegotiation) {
        this.clearNegotiationTimer();
        this.match.pendingNegotiation = null;
      }
      if (member.role === 'guest') {
        const now = this.now();
        const hostSeat = this.match.startParameters.players.find((p) => p.role === 'host')!;
        this.match = finalizeMatch(this.match, hostSeat.side, 'disconnect-timeout', now);
        this.stopClockBroadcast();
        this.clearClockTimer();
        this.publishGame();
      }
    }

    if (member.role === 'host') {
      // 房主主动离开即关房：会话关闭 → 传输层释放监听资源。
      this.close('host-closed');
      return;
    }

    if (member.role === 'guest') {
      this.guestResumeToken = null;
      // 在线房间：主动离开即释放客人席位，其他匿名玩家可以补位；
      // LAN 房间保留原来的「离开卡片」行为。
      if (this.mode === 'online') {
        this.guest = null;
      }
    }

    member.connected = false;
    member.connectionId = null;
    member.leaveReason = 'left';
    this.applyLobby({ type: 'member-left', role: 'guest' });
    this.broadcastMembers();
    this.logger('ws.guest_left', { room: this.roomId, member: member.memberId, reason });
    connection.close(1000, reason);
  }

  private broadcastMembers(): void {
    const snapshot = this.getMembers();
    const text = buildServerMessage({
      type: 'members',
      roomId: this.roomId,
      payload: { members: snapshot },
    });
    this.broadcast(text);
  }

  /**
   * 席位准入：服务端生成/可信解析身份 → 建立或恢复成员席位 → 绑定当前连接。
   * 客户端 hello 自报的 name / 账号信息不作为身份依据。
   */
  private admitMember(
    connection: SessionConnection,
    payload: { role: Role; name: string; token?: string; resumeToken?: string },
  ): RoomMemberRecord | null {
    const connectionId = connection.connectionId;

    if (payload.role === 'host') {
      if (!payload.token || payload.token !== this.hostToken) {
        this.reject(connection, 'UNAUTHORIZED', 'bad-host-token');
        return null;
      }
      if (this.host && this.lobby.phase === 'started') {
        const member = this.host;
        this.supersedeConnection(member, connectionId);
        member.connectionId = connectionId;
        member.connected = true;
        member.leaveReason = null;
        if (this.match) {
          const recRes = this.match.clock.onReconnect('host', this.now());
          this.match.revision++;
          if (recRes.settlement) {
            this.match = finalizeMatch(this.match, recRes.settlement.winner, recRes.settlement.reason, this.now());
            this.stopClockBroadcast();
            this.clearClockTimer();
          } else {
            this.scheduleClockDeadline();
          }
          this.publishGame();
        }
        return member;
      }
      if (this.host?.connected) {
        this.reject(connection, 'UNAUTHORIZED', 'host-slot-taken');
        return null;
      }
      const identity = this.resolveIdentity({ role: 'host', requestedName: payload.name });
      const member: RoomMemberRecord = {
        memberId: asMemberId(this.randomId()),
        identity,
        role: 'host',
        name: '房主',
        connectionId,
        connected: true,
        leaveReason: null,
      };
      this.host = member;
      return member;
    }

    if (payload.role === 'spectator') {
      // 显式旁观：始终不占执色席位。
      return this.admitSpectator(connection, payload.resumeToken, payload.name);
    }

    // 客人恢复只接受全局 guest token：旁观者/房主凭据禁止跨身份使用。
    if (payload.resumeToken) {
      if (!this.guestResumeToken || payload.resumeToken !== this.guestResumeToken || !this.guest) {
        this.reject(connection, 'UNAUTHORIZED', 'bad-resume-token');
        return null;
      }
      const member = this.guest;
      this.supersedeConnection(member, connectionId);
      member.connectionId = connectionId;
      member.connected = true;
      member.leaveReason = null;
      if (this.match && this.lobby.phase === 'started') {
        const recRes = this.match.clock.onReconnect('guest', this.now());
        this.match.revision++;
        if (recRes.settlement) {
          this.match = finalizeMatch(this.match, recRes.settlement.winner, recRes.settlement.reason, this.now());
          this.stopClockBroadcast();
          this.clearClockTimer();
        } else {
          this.scheduleClockDeadline();
        }
        this.publishGame();
      }
      return member;
    }

    if (this.guest?.connected) {
      // 客人席位已被占用：普通加入自动分流为旁观者，不占执色、不参与准备就绪。
      return this.admitSpectator(connection, undefined, payload.name);
    }
    if (this.lobby.phase === 'started' && this.guest) {
      // 开局后保持已冻结身份，不接受新成员替换：后来者以旁观身份进入。
      return this.admitSpectator(connection, undefined, payload.name);
    }

    this.guestResumeToken = this.randomToken();
    const identity = this.resolveIdentity({ role: 'guest', requestedName: payload.name });
    const member: RoomMemberRecord = {
      memberId: asMemberId(this.randomId()),
      identity,
      role: 'guest',
      name: '客人',
      connectionId,
      connected: true,
      leaveReason: null,
    };
    // 只保留一个客人席位：离线客人卡片被新成员替换，不累积幽灵成员。
    if (this.guest) {
      this.applyLobby({ type: 'member-left', role: 'guest' }, connectionId);
    }
    this.guest = member;
    return member;
  }

  /**
   * 旁观者准入：有恢复凭据时只认本人凭据并替换旧连接（禁止跨身份 token），
   * 无凭据时新建旁观记录；错误凭据一律拒绝，不回退为新成员。
   */
  private admitSpectator(
    connection: SessionConnection,
    resumeToken: string | undefined,
    requestedName?: string,
  ): RoomMemberRecord | null {
    const connectionId = connection.connectionId;

    if (resumeToken) {
      const existing = this.spectators.find((member) => member.resumeToken && member.resumeToken === resumeToken);
      if (!existing) {
        this.reject(connection, 'UNAUTHORIZED', 'bad-resume-token');
        return null;
      }
      this.supersedeConnection(existing, connectionId);
      existing.connectionId = connectionId;
      existing.connected = true;
      existing.leaveReason = null;
      this.clearSpectatorExpiry(existing.memberId);
      return existing;
    }

    this.spectatorNameSeq += 1;
    const identity = this.resolveIdentity({ role: 'spectator', requestedName });
    const member: RoomMemberRecord = {
      memberId: asMemberId(this.randomId()),
      identity,
      role: 'spectator',
      name: `旁观${this.spectatorNameSeq}`,
      connectionId,
      connected: true,
      leaveReason: null,
      resumeToken: this.randomToken(),
    };
    this.spectators.push(member);
    return member;
  }

  /** 替换席位的旧连接：拒绝迟到消息并关闭旧连接，不影响新连接。 */
  private supersedeConnection(member: RoomMemberRecord, newConnectionId: ConnectionId): void {
    const oldConnectionId = member.connectionId;
    if (!oldConnectionId || oldConnectionId === newConnectionId) {
      return;
    }
    const oldRecord = this.connections.get(oldConnectionId);
    if (!oldRecord) {
      return;
    }
    oldRecord.connection.send(
      buildServerMessage({
        type: 'error',
        roomId: this.roomId,
        payload: { code: 'UNAUTHORIZED', message: 'socket-superseded' },
      }),
    );
    oldRecord.connection.close(closeCodeForError('UNAUTHORIZED'), 'socket-superseded');
  }

  /**
   * 在线席位准入：只依据传输层登记的可信身份。
   * - 建房者身份取得房主席位；
   * - 已在该房的同一身份恢复原席位（成员/角色不变，仅替换连接）；
   * - 新身份在大厅阶段且客人席位空缺时成为客人，否则成为只读旁观者。
   * 任何客户端自报的角色/成员/恢复凭据都不参与这里的分支。
   */
  private admitOnlineMember(connection: SessionConnection, identity: RoomIdentity): RoomMemberRecord | null {
    const connectionId = connection.connectionId;

    if (this.ownerIdentityId !== null && identity.identityId === this.ownerIdentityId) {
      if (!this.host) {
        this.host = {
          memberId: asMemberId(this.randomId()),
          identity,
          role: 'host',
          name: '房主',
          connectionId,
          connected: true,
          leaveReason: null,
        };
        return this.host;
      }
      return this.rebindMember(this.host, connectionId);
    }

    const existing = this.findMemberByIdentity(identity.identityId);
    if (existing) {
      return this.rebindMember(existing, connectionId);
    }

    if (!this.guest && this.lobby.phase !== 'started') {
      const member: RoomMemberRecord = {
        memberId: asMemberId(this.randomId()),
        identity,
        role: 'guest',
        name: '客人',
        connectionId,
        connected: true,
        leaveReason: null,
      };
      this.guest = member;
      return member;
    }

    return this.admitOnlineSpectator(connection, identity);
  }

  private findMemberByIdentity(identityId: IdentityId): RoomMemberRecord | null {
    if (this.host && this.host.identity.identityId === identityId) {
      return this.host;
    }
    if (this.guest && this.guest.identity.identityId === identityId) {
      return this.guest;
    }
    return this.spectators.find((member) => member.identity.identityId === identityId) ?? null;
  }

  /**
   * 在线重连：保持原成员席位与角色，只替换连接；对局中恢复按既有 MatchClock 裁决，
   * 不重置局时、不重发历史动作。
   */
  private rebindMember(member: RoomMemberRecord, connectionId: ConnectionId): RoomMemberRecord {
    this.supersedeConnection(member, connectionId);
    member.connectionId = connectionId;
    member.connected = true;
    member.leaveReason = null;

    if (member.role === 'spectator') {
      this.clearSpectatorExpiry(member.memberId);
      return member;
    }

    this.applyLobby({ type: 'member-joined', role: member.role });

    if (this.match && this.lobby.phase === 'started') {
      const reconnect = this.match.clock.onReconnect(member.role, this.now());
      this.match.revision += 1;
      if (reconnect.settlement) {
        this.match = finalizeMatch(this.match, reconnect.settlement.winner, reconnect.settlement.reason, this.now());
        this.stopClockBroadcast();
        this.clearClockTimer();
      } else {
        this.scheduleClockDeadline();
      }
      this.publishGame();
    }

    return member;
  }

  /** 在线旁观：同一身份再次进入恢复原旁观席位，否则新建；不占执色席位、不参与就绪。 */
  private admitOnlineSpectator(connection: SessionConnection, identity: RoomIdentity): RoomMemberRecord {
    this.spectatorNameSeq += 1;
    const member: RoomMemberRecord = {
      memberId: asMemberId(this.randomId()),
      identity,
      role: 'spectator',
      name: `旁观${this.spectatorNameSeq}`,
      connectionId: connection.connectionId,
      connected: true,
      leaveReason: null,
    };
    this.spectators.push(member);
    return member;
  }

  private clearSpectatorExpiry(memberId: MemberId): void {
    const timer = this.spectatorExpiryTimers.get(memberId);
    if (timer) {
      clearTimeout(timer);
      this.spectatorExpiryTimers.delete(memberId);
    }
  }

  /** 旁观者掉线后的恢复窗口：超时未恢复即清理记录并同步名单。 */
  private scheduleSpectatorExpiry(member: RoomMemberRecord): void {
    this.clearSpectatorExpiry(member.memberId);
    const timer = setTimeout(() => {
      this.spectatorExpiryTimers.delete(member.memberId);
      const index = this.spectators.indexOf(member);
      if (index >= 0 && !member.connected) {
        this.spectators.splice(index, 1);
        this.logger('ws.spectator_expired', { room: this.roomId, member: member.memberId });
        this.broadcastMembers();
      }
    }, this.spectatorResumeWindowMs);
    timer.unref?.();
    this.spectatorExpiryTimers.set(member.memberId, timer);
  }

  private handleGameAction(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'game.action' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (!this.match || this.lobby.phase !== 'started') {
      this.sendGameRejection(connection, '对局尚未开始', message.requestId);
      return;
    }

    // 双方在线检查：避免恢复窗口中的竞争
    if (!this.host?.connected || !this.guest?.connected) {
      this.sendGameRejection(connection, '对手已离线，暂无法操作', message.requestId);
      return;
    }

    // 去重键绑定对局与成员：同名的旧局/他人请求不会被当成重复。
    const cached = message.requestId
      ? this.findProcessedAction(message.requestId, this.match.matchId, member.memberId)
      : undefined;
    if (cached) {
      this.logger('game.action_duplicate', {
        room: this.roomId,
        requestId: message.requestId,
        stepNumber: cached.stepNumber,
      });
      // 只回执权威版本，不重播旧效果，也不广播。
      connection.send(
        buildServerMessage(
          buildServerGameReceipt(this.roomId, {
            matchId: this.match.matchId,
            revision: this.match.revision,
            stepNumber: this.match.stepNumber,
            acceptedRevision: cached.revision,
            acceptedStepNumber: cached.stepNumber,
            requestId: message.requestId!,
          }),
        ),
      );
      return;
    }

    if (message.payload.matchId !== this.match.matchId) {
      this.sendGameRejection(connection, '对局标识不匹配', message.requestId);
      return;
    }

    if (message.payload.stepNumber !== this.match.stepNumber) {
      this.sendGameRejection(connection, '操作步数已过期，请以最新棋盘为准', message.requestId);
      return;
    }

    // 版本也要对齐：悔棋会把步数降回旧值，只比步数会接纳悔棋前的迟到动作。
    if (message.payload.revision !== this.match.revision) {
      this.sendGameRejection(connection, '操作版本已过期，请以最新棋盘为准', message.requestId);
      return;
    }

    if (this.match.pendingNegotiation !== null) {
      this.sendGameRejection(connection, '协商正在进行中，棋盘操作已锁定', message.requestId);
      return;
    }

    const currentTurn = this.match.gameState.currentTurn;
    const expectedMemberId =
      currentTurn === 'red' ? this.match.startParameters.redMemberId : this.match.startParameters.blackMemberId;

    if (member.memberId !== expectedMemberId) {
      this.sendGameRejection(connection, '非己方回合，请等待对方行动', message.requestId);
      return;
    }

    const now = this.now();
    const revisionBefore = this.match.revision;
    const result = applyMatchAction(this.match, member.memberId, message.payload.action, now);
    if (!result.ok) {
      this.logger('game.action_rejected', {
        room: this.roomId,
        member: member.memberId,
        reason: result.reason,
      });
      this.sendGameRejection(connection, result.reason, message.requestId);
      // 超时检出会把对局结算为棋局变更（内部已递增 revision），必须照常发布结算补丁，
      // 不能只在动作成功时发布，否则客户端会一直停在旧版本。
      if (this.match.revision !== revisionBefore) {
        this.stopClockBroadcast();
        this.clearClockTimer();
        this.publishGame();
      }
      return;
    }

    this.match = result.match;
    if (this.match.settlement !== null) {
      this.stopClockBroadcast();
      this.clearClockTimer();
    } else {
      this.scheduleClockDeadline();
    }

    if (message.requestId) {
      this.processedActions.set(message.requestId, {
        matchId: this.match.matchId,
        memberId: member.memberId,
        revision: this.match.revision,
        stepNumber: this.match.stepNumber,
      });
      if (this.processedActions.size > 200) {
        const oldestKey = this.processedActions.keys().next().value;
        if (oldestKey) {
          this.processedActions.delete(oldestKey);
        }
      }
    }

    this.logger('game.action_applied', {
      room: this.roomId,
      matchId: this.match.matchId,
      stepNumber: this.match.stepNumber,
      member: member.memberId,
    });

    this.publishGame({
      requestId: message.requestId,
      actorMemberId: member.memberId,
      action: message.payload.action,
    });
  }

  private handleGameNegotiate(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'game.negotiate' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (!this.match || this.lobby.phase !== 'started') {
      this.sendGameRejection(connection, '对局尚未开始', message.requestId);
      return;
    }

    if (!this.host?.connected || !this.guest?.connected) {
      this.sendGameRejection(connection, '对手已离线，暂无法操作', message.requestId);
      return;
    }

    if (this.match.settlement !== null || this.match.gameState.winner !== null) {
      this.sendGameRejection(connection, '对局已经结束，请重新开局', message.requestId);
      return;
    }

    if (message.payload.matchId !== this.match.matchId) {
      this.sendGameRejection(connection, '对局标识不匹配', message.requestId);
      return;
    }

    if (message.payload.revision !== this.match.revision) {
      this.sendGameRejection(connection, '操作版本已过期，请以最新棋盘为准', message.requestId);
      return;
    }

    const now = this.now();

    // 先检查是否已有到期的协商
    if (this.match.pendingNegotiation && now >= this.match.pendingNegotiation.deadline) {
      this.handleNegotiationTimeout(this.match.matchId, this.match.pendingNegotiation.negotiationId);
    }

    if (this.match.pendingNegotiation !== null) {
      this.sendGameRejection(connection, '已有协商正在进行中，请等待其结束', message.requestId);
      return;
    }

    if (message.payload.kind === 'undo') {
      if (this.match.gameState.actionHistory.length === 0) {
        this.sendGameRejection(connection, '开局暂无走子记录，无法申请悔棋', message.requestId);
        return;
      }
    } else if (message.payload.kind === 'draw') {
      const cooldownUntil = this.match.drawCooldownUntil[member.memberId] ?? 0;
      if (now < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - now) / 1000);
        this.sendGameRejection(connection, `求和申请冷却中，请在 ${remaining} 秒后再试`, message.requestId);
        return;
      }
    }

    const responder = member.role === 'host' ? this.guest! : this.host!;
    const negotiationId = this.randomToken();
    const deadline = now + NEGOTIATION_TIMEOUT_MS;

    const pending: PendingNegotiation = {
      negotiationId,
      type: message.payload.kind,
      initiatorMemberId: member.memberId,
      responderMemberId: responder.memberId,
      baselineRevision: this.match.revision,
      createdAt: now,
      deadline,
    };

    this.match.pendingNegotiation = pending;
    this.match.clock.pauseNegotiation(now);
    this.clearClockTimer();
    this.match.revision++;

    const eventType: NegotiationEventType = message.payload.kind === 'undo' ? 'undo-request' : 'draw-request';
    const eventMsg = message.payload.kind === 'undo' ? '对方发起了悔棋申请' : '对方发起了求和申请';
    this.recordMatchEvent(eventType, member.memberId, 'requested', eventMsg, now);

    this.scheduleNegotiationDeadline(this.match.matchId, negotiationId, deadline);
    this.publishGame({ requestId: message.requestId });
  }

  private handleGameNegotiateReply(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'game.negotiate.reply' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (!this.match || this.lobby.phase !== 'started') {
      return;
    }

    const pending = this.match.pendingNegotiation;
    if (!pending || pending.negotiationId !== message.payload.negotiationId) {
      return;
    }

    if (member.memberId !== pending.responderMemberId) {
      this.sendGameRejection(connection, '非指定应答方，无法操作', message.requestId);
      return;
    }

    const now = this.now();
    if (now >= pending.deadline) {
      this.handleNegotiationTimeout(this.match.matchId, pending.negotiationId);
      return;
    }

    this.clearNegotiationTimer();

    if (message.payload.accept) {
      if (pending.type === 'undo') {
        const undoRes = undoMatchAction(this.match, now);
        if (undoRes.ok) {
          this.match = undoRes.match;
          this.match.clock.resumeNegotiation(now);
          this.match.pendingNegotiation = null;
          this.processedActions.clear();
          this.recordMatchEvent('undo-accepted', member.memberId, 'accepted', '对方同意了悔棋申请，棋盘已回退一步', now);
          this.publishGame({ requestId: message.requestId });
          this.scheduleClockDeadline();
        }
      } else if (pending.type === 'draw') {
        this.match = finalizeMatchDraw(this.match, 'draw-agreement', now);
        this.match.pendingNegotiation = null;
        this.stopClockBroadcast();
        this.clearClockTimer();
        this.recordMatchEvent('draw-accepted', member.memberId, 'accepted', '双方同意握手言和，对局平局', now);
        this.publishGame({ requestId: message.requestId });
      }
    } else {
      // 拒绝
      if (pending.type === 'undo') {
        this.match.clock.resumeNegotiation(now);
        this.match.pendingNegotiation = null;
        this.match.revision++;
        this.recordMatchEvent('undo-rejected', member.memberId, 'rejected', '对方拒绝了悔棋申请', now);
        this.publishGame({ requestId: message.requestId });
        this.scheduleClockDeadline();
      } else if (pending.type === 'draw') {
        this.match.drawCooldownUntil[pending.initiatorMemberId] = now + DRAW_COOLDOWN_MS;
        this.match.clock.resumeNegotiation(now);
        this.match.pendingNegotiation = null;
        this.match.revision++;
        this.recordMatchEvent('draw-rejected', member.memberId, 'rejected', '对方拒绝了求和申请', now);
        this.publishGame({ requestId: message.requestId });
        this.scheduleClockDeadline();
      }
    }
  }

  private handleGameResign(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'game.resign' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (!this.match || this.lobby.phase !== 'started') {
      return;
    }

    if (this.match.settlement !== null || this.match.gameState.winner !== null) {
      return;
    }

    const now = this.now();
    const adv = this.match.clock.advance(now);
    if (adv.timeoutResult) {
      this.match = finalizeMatch(this.match, adv.timeoutResult.winner!, adv.timeoutResult.reason, now);
      this.stopClockBroadcast();
      this.clearClockTimer();
      this.clearNegotiationTimer();
      this.publishGame({ requestId: message.requestId });
      return;
    }

    const resigningCamp = member.memberId === this.match.startParameters.redMemberId ? 'red' : 'black';
    const winningCamp = resigningCamp === 'red' ? 'black' : 'red';

    if (this.match.pendingNegotiation) {
      this.clearNegotiationTimer();
      this.match.pendingNegotiation = null;
    }

    this.match = finalizeMatch(this.match, winningCamp, 'resignation', now);
    this.stopClockBroadcast();
    this.clearClockTimer();
    this.recordMatchEvent('resigned', member.memberId, 'resigned', `${member.name} 认输，对局结束`, now);
    this.publishGame({ requestId: message.requestId });
  }

  private handleGameSync(
    connection: SessionConnection,
    _member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'game.sync' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }
    if (!this.match || this.lobby.phase !== 'started') {
      this.sendGameRejection(connection, '对局尚未开始', message.requestId);
      return;
    }
    // 显式同步永远返回当前权威局：客户端可能还停在旧 matchId，
    // 若按请求标识拒绝，跨局后就会无限收到「标识不匹配」。
    const text = this.buildGameStateMessage(
      message.requestId ? { requestId: message.requestId } : undefined,
    );
    if (text) {
      connection.send(text);
    }
  }

  /**
   * 轻量版本核对：只回权威 matchId / revision，不投影、不构造棋盘。
   * 供 5 秒巡检与跨局检测使用；没有对局时两者都为 null。
   */
  private handleGameVersion(
    connection: SessionConnection,
    message: Extract<ClientMessage, { type: 'game.version' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }
    connection.send(
      buildServerMessage(
        buildServerGameVersion(this.roomId, {
          matchId: this.match?.matchId ?? null,
          revision: this.match?.revision ?? null,
          requestId: message.requestId,
        }),
      ),
    );
  }

  /**
   * 结算即冻结：同一 matchId 只归档一次，过期与被关闭后不再可用。
   * 归档失败时记录日志但不阻断对局发布；随后请求会得到明确的不可用原因。
   */
  private archiveFinishedMatch(): void {
    const match = this.match;
    if (!match || !match.settlement || this.finishedRecords.has(match.matchId)) {
      return;
    }
    try {
      const { json, text } = buildFinishedMatchRecord(match);
      const entry = this.finishedRecords.archive({
        roomId: this.roomId,
        matchId: match.matchId,
        memberIds: [match.startParameters.redMemberId, match.startParameters.blackMemberId],
        endedAt: match.settlement.endedAt,
        json,
        text,
      });
      if (!entry) {
        return;
      }
      this.logger('record.archived', {
        room: this.roomId,
        matchId: entry.matchId,
        expiresAt: entry.expiresAt,
      });
      this.broadcast(
        buildServerMessage(buildServerGameRecords(this.roomId, { records: this.finishedRecords.summaries() })),
      );
    } catch (error) {
      this.logger('record.archive_failed', {
        room: this.roomId,
        matchId: match.matchId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * 只读终局棋谱请求：先完成握手/当前连接/房间归属校验（分发层已做），
   * 再按冻结参与者或本房获准旁观者授权，最后只查本会话档案。
   */
  private handleGameRecordRequest(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'game.record.request' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    const matchId = message.payload.matchId;
    const entry = this.finishedRecords.get(matchId);
    if (!entry) {
      const inProgress = this.match?.matchId === matchId && this.match.settlement === null;
      connection.send(
        buildServerMessage(
          buildServerGameRecordUnavailable(this.roomId, {
            requestId: message.requestId,
            matchId,
            code: inProgress ? 'NOT_FINISHED' : 'UNAVAILABLE',
            message: inProgress ? '对局尚未结束，暂不能获取棋谱' : '棋谱不存在或已过期',
          }),
        ),
      );
      return;
    }

    const isParticipant = entry.memberIds.includes(member.memberId);
    if (!isParticipant && member.role !== 'spectator') {
      connection.send(
        buildServerMessage(
          buildServerGameRecordUnavailable(this.roomId, {
            requestId: message.requestId,
            matchId,
            code: 'FORBIDDEN',
            message: '无权读取该房间的棋谱',
          }),
        ),
      );
      return;
    }

    this.logger('record.served', {
      room: this.roomId,
      matchId,
      member: member.memberId,
      role: member.role,
    });
    connection.send(
      buildServerMessage(
        buildServerGameRecord(this.roomId, {
          requestId: message.requestId,
          matchId,
          expiresAt: entry.expiresAt,
          json: entry.json,
          text: entry.text,
        }),
      ),
    );
  }

  /**
   * 已接受动作命中：同一 requestId 只在同一对局的同一成员下才算重复。
   * 旧局或另一成员的请求即使撞了 ID 也按新请求处理。
   */
  private findProcessedAction(
    requestId: string,
    matchId: string,
    memberId: string,
  ): ProcessedAction | undefined {
    const cached = this.processedActions.get(requestId);
    if (!cached || cached.matchId !== matchId || cached.memberId !== memberId) {
      return undefined;
    }
    return cached;
  }

  /**
   * 全量公开快照消息：只用于欢迎单播与显式同步单播。
   * 常规广播走 {@link publishGame} 的增量补丁。
   */
  private buildGameStateMessage(options?: {
    requestId?: string;
    actorMemberId?: string;
    action?: MatchAction;
  }): string | null {
    if (!this.match) {
      return null;
    }
    const snap = projectMatchSnapshot(this.match, this.now());
    return buildServerMessage({
      type: 'game.state',
      roomId: this.roomId,
      ...(options?.requestId ? { requestId: options.requestId } : {}),
      payload: {
        matchId: snap.matchId,
        stepNumber: snap.stepNumber,
        revision: snap.revision,
        state: snap.gameState,
        startParameters: snap.startParameters,
        ...(snap.clock ? { clock: snap.clock } : {}),
        // 可空字段始终显式给出：省略会被客户端当成「无更新」而保留旧值。
        settlement: snap.settlement,
        pendingNegotiation: snap.pendingNegotiation,
        drawCooldownUntil: snap.drawCooldownUntil,
        phraseCooldownUntil: snap.phraseCooldownUntil,
        negotiationEvent: snap.negotiationEvent,
        matchEvents: snap.matchEvents,
        ...(options?.actorMemberId ? { actorMemberId: options.actorMemberId } : {}),
        ...(options?.action ? { action: options.action } : {}),
      },
    });
  }

  /**
   * 发布一次公开棋局变化。
   *
   * - 新局第一次发布（或基线落后于当前版本）发完整公开快照，作为全房间基线；
   * - 之后每次只发 `game.patch`：棋子/历史/事件用差异，标量只带变化项；
   * - 即使本次公开局面无差异，也发一条只带版本的最小补丁，保证客户端版本
   *   与服务端一致，避免把它误判成缺口而不必要地全量同步；
   * - 时钟不进入补丁：1Hz 广播只走 `game.clock`，避免每秒构造完整快照。
   */
  private publishGame(options?: {
    requestId?: string;
    actorMemberId?: string;
    action?: MatchAction;
  }): void {
    if (!this.match) {
      this.published = null;
      return;
    }
    // 先幂等归档再发布结算：客户端看到结算后立刻请求也能取到同一份冻结棋谱。
    this.archiveFinishedMatch();
    const next = projectMatchSnapshot(this.match, this.now());
    const previous = this.published;

    if (!previous || previous.matchId !== next.matchId || next.revision <= previous.revision) {
      const text = this.buildGameStateMessage(options);
      this.published = next;
      if (text) {
        this.broadcast(text);
      }
      return;
    }

    const changes: PublicGameDelta = diffPublicSnapshot(previous, next);
    this.published = next;
    this.broadcast(
      buildServerMessage(
        buildServerGamePatch(this.roomId, {
          patch: {
            matchId: next.matchId,
            baseRevision: previous.revision,
            revision: next.revision,
            stepNumber: next.stepNumber,
            changes,
          },
          ...(options?.requestId ? { requestId: options.requestId } : {}),
          ...(options?.actorMemberId ? { actorMemberId: options.actorMemberId } : {}),
          ...(options?.action ? { action: options.action } : {}),
        }),
      ),
    );
  }

  private handleChatPhrase(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'chat.phrase' }>,
  ): void {
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    if (
      !this.match ||
      this.lobby.phase !== 'started' ||
      this.match.settlement !== null ||
      this.match.gameState.winner !== null
    ) {
      this.sendChatPhraseRejection(
        connection,
        {
          matchId: message.payload.matchId,
          requestId: message.requestId,
          code: 'MATCH_NOT_ACTIVE',
          message: '对局未处于进行中',
        },
        message.requestId,
      );
      return;
    }

    if (member.memberId !== this.host?.memberId && member.memberId !== this.guest?.memberId) {
      this.sendChatPhraseRejection(
        connection,
        {
          matchId: message.payload.matchId,
          requestId: message.requestId,
          code: 'NOT_A_PLAYER',
          message: '非对局玩家',
        },
        message.requestId,
      );
      return;
    }

    if (!this.host?.connected || !this.guest?.connected) {
      this.sendChatPhraseRejection(
        connection,
        {
          matchId: message.payload.matchId,
          requestId: message.requestId,
          code: 'MATCH_NOT_ACTIVE',
          message: '对方已离线，暂无法发送短语',
        },
        message.requestId,
      );
      return;
    }

    if (!isQuickPhraseId(message.payload.phraseId)) {
      this.sendChatPhraseRejection(
        connection,
        {
          matchId: message.payload.matchId,
          requestId: message.requestId,
          code: 'INVALID_PHRASE',
          message: '非法预置短语',
        },
        message.requestId,
      );
      return;
    }

    if (message.requestId && this.processedPhraseRequests.has(message.requestId)) {
      // 相同请求重传不重复广播或延长冷却
      return;
    }

    const now = this.now();
    const cooldownUntil = this.phraseCooldownUntil.get(member.memberId) ?? 0;
    if (now < cooldownUntil) {
      const remainingSeconds = Math.ceil((cooldownUntil - now) / 1000);
      this.sendChatPhraseRejection(
        connection,
        {
          matchId: message.payload.matchId,
          requestId: message.requestId,
          code: 'COOLDOWN',
          message: `短语发送冷却中，请等待 ${remainingSeconds} 秒`,
          retryAt: cooldownUntil,
        },
        message.requestId,
      );
      return;
    }

    const nextAllowedAt = now + QUICK_PHRASE_COOLDOWN_MS;
    this.phraseCooldownUntil.set(member.memberId, nextAllowedAt);
    if (this.match) {
      // 短语冷却也是公开持久字段：推进版本并发布小补丁，才能被版本核对发现。
      this.match.phraseCooldownUntil[member.memberId] = nextAllowedAt;
      this.match.revision++;
      this.publishGame();
    }

    const event: QuickPhraseEvent = {
      eventId: this.randomId(),
      matchId: this.match.matchId,
      senderMemberId: member.memberId,
      phraseId: message.payload.phraseId,
      text: getQuickPhraseText(message.payload.phraseId)!,
      sentAt: now,
      nextAllowedAt,
    };

    if (message.requestId) {
      this.processedPhraseRequests.set(message.requestId, { event });
      if (this.processedPhraseRequests.size > 200) {
        const oldestKey = this.processedPhraseRequests.keys().next().value;
        if (oldestKey) {
          this.processedPhraseRequests.delete(oldestKey);
        }
      }
    }

    this.logger('chat.phrase', {
      room: this.roomId,
      matchId: this.match.matchId,
      member: member.memberId,
      phraseId: message.payload.phraseId,
    });

    const text = buildServerMessage(buildServerChatPhrase(this.roomId, event));
    this.broadcast(text);
  }

  private sendChatPhraseRejection(
    connection: SessionConnection,
    rejection: QuickChatRejection,
    requestId?: string,
  ): void {
    connection.send(buildServerMessage(buildServerChatPhraseRejected(this.roomId, rejection, requestId)));
  }

  private handleLobbyReturn(
    connection: SessionConnection,
    member: RoomMemberRecord,
    message: Extract<ClientMessage, { type: 'lobby.return' }>,
  ): void {
    // 旁观消息已在分发层拒绝；这里仅为类型收窄到执色玩家。
    if (member.role === 'spectator') {
      return;
    }
    if (message.roomId !== this.roomId) {
      this.reject(connection, 'INVALID_MESSAGE', 'room-id-mismatch');
      return;
    }

    const { matchId, intent } = message.payload;

    if (this.match) {
      if (this.match.matchId !== matchId) {
        this.reject(connection, 'INVALID_MESSAGE', 'match-id-mismatch');
        return;
      }

      if (this.match.settlement === null && this.match.gameState.winner === null) {
        this.sendError(connection, 'INVALID_MESSAGE', 'game-not-finished');
        return;
      }

      this.stopClockBroadcast();
      this.clearClockTimer();
      this.clearNegotiationTimer();
      // 清当前局前确保档案已落地；已归档的旧记录不受再局影响。
      this.archiveFinishedMatch();
      this.match = null;
      this.published = null;
      this.processedActions.clear();
      this.phraseCooldownUntil.clear();
      this.processedPhraseRequests.clear();

      this.lobby = {
        ...this.lobby,
        phase: 'lobby',
        startParameters: null,
        ready: {
          host: intent === 'rematch' && member.role === 'host',
          guest: intent === 'rematch' && member.role === 'guest',
        },
      };

      this.logger('game.return_lobby', { room: this.roomId, member: member.memberId, intent });
      this.broadcastLobby();
      this.broadcastMembers();
      return;
    }

    if (this.lobby.phase === 'lobby') {
      if (intent === 'rematch') {
        if (!this.lobby.ready[member.role]) {
          this.lobby = {
            ...this.lobby,
            ready: {
              ...this.lobby.ready,
              [member.role]: true,
            },
          };
          this.broadcastLobby();
        }
      }
    }
  }

  /**
   * 旁观者动作拒绝：按消息所属通道给出非致命拒绝（大厅/对局/快捷短语各自通道），
   * 只回复请求方，不进入任何缓存、时钟、revision 或对局裁决逻辑。
   */
  private rejectSpectatorAction(connection: SessionConnection, message: ClientMessage): void {
    this.logger('ws.spectator_rejected', { room: this.roomId, type: message.type });
    if (message.type === 'chat.phrase') {
      connection.send(
        buildServerMessage(
          buildServerChatPhraseRejected(
            this.roomId,
            {
              matchId: message.payload.matchId,
              requestId: message.requestId ?? '',
              code: 'NOT_A_PLAYER',
              message: '旁观者不可发送快捷短语',
            },
            message.requestId,
          ),
        ),
      );
      return;
    }
    if (
      message.type === 'lobby.settings' ||
      message.type === 'lobby.lock' ||
      message.type === 'lobby.ready' ||
      message.type === 'lobby.start' ||
      message.type === 'lobby.return'
    ) {
      connection.send(
        buildServerMessage({
          type: 'lobby.rejected',
          roomId: this.roomId,
          payload: { code: 'SPECTATOR_READONLY', message: '旁观者不可执行大厅操作' },
        }),
      );
      return;
    }
    this.sendGameRejection(connection, '旁观者不可操作对局', message.requestId);
  }

  /**
   * 精简拒绝：只给权威版本与原因，不夹带棋局快照。
   * 有对局时报当前对局身份与版本（客户端据此发现版本落后并走权威同步）；
   * 无对局时明确为 null，不拿请求里的旧 matchId 冒充权威版本。
   */
  private sendGameRejection(connection: SessionConnection, reason: string, requestId?: string): void {
    const match = this.match;
    connection.send(
      buildServerMessage(
        buildServerGameRejected(this.roomId, {
          matchId: match?.matchId ?? null,
          revision: match?.revision ?? null,
          stepNumber: match?.stepNumber ?? 0,
          reason,
          ...(requestId ? { requestId } : {}),
        }),
      ),
    );
  }

  private sendError(connection: SessionConnection, code: ServerErrorCode, message: string): void {
    connection.send(
      buildServerMessage({
        type: 'error',
        roomId: this.roomId,
        payload: { code, message },
      }),
    );
  }

  private reject(connection: SessionConnection, code: ServerErrorCode, detail: string): void {
    this.logger('ws.rejected', { room: this.roomId, conn: connection.connectionId, code, detail });
    this.sendError(connection, code, detail);
    connection.close(closeCodeForError(code), code);
  }
}
