// @vitest-environment node
/**
 * 共享权威会话（RoomSession）边界回归：不依赖任何监听端口。
 *
 * 覆盖：
 * - 两个会话并行推进，同名 requestId / 凭据 / 断线 / 关闭只影响所属会话；
 * - 接入 → 就绪 → 开局 → 合法/非法动作 → 协商 → 结算 → 再局（真正新开一局）；
 * - 重连换接（保持身份与席位）、旧连接迟到操作与迟到 close、跨角色凭据拒绝；
 * - 旁观只读、快照副本、定时器归属与关闭幂等；
 * - 受控时间下 90 秒掉线宽限（期内恢复 / 到期结算）、双方掉线、协商中掉线取消、
 *   再局后旧 deadline 不影响新局。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSession, type RoomSessionOptions, type SessionConnection } from '../room-session';
import { asConnectionId, generateId, type ConnectionId } from '../room-identity';
import {
  buildClientChatPhrase,
  buildClientGameAction,
  buildClientGameNegotiate,
  buildClientGameNegotiateReply,
  buildClientGameSync,
  buildClientHello,
  buildClientLeave,
  buildClientLobbyReady,
  buildClientLobbyReturn,
  buildClientLobbyStart,
  encodeMessage,
  parseClientMessage,
  CLOSE_CODES,
  type ClientMessage,
} from '../../src/network/protocol';

type AnyMessage = Record<string, any>;

class FakeConnection implements SessionConnection {
  readonly connectionId: ConnectionId = asConnectionId(generateId());
  readonly sent: AnyMessage[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  closeCount = 0;

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  close(code: number, reason: string): void {
    this.closeCount += 1;
    if (this.closeCode === null) {
      this.closeCode = code;
      this.closeReason = reason;
    }
  }

  messages(type: string, predicate?: (message: AnyMessage) => boolean): AnyMessage[] {
    return this.sent.filter((message) => message.type === type && (!predicate || predicate(message)));
  }

  last(type: string, predicate?: (message: AnyMessage) => boolean): AnyMessage | null {
    const matches = this.messages(type, predicate);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }
}

/** 受控时钟：域时间与假定时器同步推进。 */
class FakeClock {
  now = 10_000;

  readonly nowFn = (): number => this.now;

  advance(ms: number): void {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(remaining, 250);
      this.now += step;
      vi.advanceTimersByTime(step);
      remaining -= step;
    }
  }
}

interface Harness {
  session: RoomSession;
  clock: FakeClock;
  roomId: string;
  host: FakeConnection;
  guest: FakeConnection;
  hostMemberId: string;
  guestMemberId: string;
  guestResumeToken: string;
}

function connect(session: RoomSession): FakeConnection {
  const connection = new FakeConnection();
  session.attach(connection);
  return connection;
}

/** 按传输层路径走一遍编解码 + 协议校验后交回会话。 */
function deliver(session: RoomSession, connection: FakeConnection, message: ClientMessage): void {
  const parsed = parseClientMessage(encodeMessage(message));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    session.handleMessage(connection.connectionId, parsed.message);
  }
}

function hello(
  session: RoomSession,
  connection: FakeConnection,
  payload: { role: 'host' | 'guest' | 'spectator'; name: string; token?: string; resumeToken?: string },
): AnyMessage {
  deliver(session, connection, buildClientHello({ ...payload, roomId: session.roomId }));
  return connection.last('welcome')!;
}

function createSession(overrides: Partial<RoomSessionOptions> = {}): {
  session: RoomSession;
  clock: FakeClock;
} {
  const clock = new FakeClock();
  const session = new RoomSession({
    nowFn: clock.nowFn,
    drawHostRed: () => true,
    drawSeed: () => 42,
    clockIntervalMs: 250,
    logger: () => undefined,
    ...overrides,
  });
  return { session, clock };
}

/** 接入 host + guest（host 执红）。 */
function joinPair(session: RoomSession): Omit<Harness, 'session' | 'clock' | 'roomId'> {
  const host = connect(session);
  const hostWelcome = hello(session, host, { role: 'host', name: '房主', token: session.hostToken });
  const guest = connect(session);
  const guestWelcome = hello(session, guest, { role: 'guest', name: '客人' });
  return {
    host,
    guest,
    hostMemberId: hostWelcome.payload.memberId,
    guestMemberId: guestWelcome.payload.memberId,
    guestResumeToken: guestWelcome.payload.resumeToken,
  };
}

function readyBoth(session: RoomSession, pair: { host: FakeConnection; guest: FakeConnection }, version = 1): void {
  deliver(session, pair.host, buildClientLobbyReady(session.roomId, true, version));
  deliver(session, pair.guest, buildClientLobbyReady(session.roomId, true, version));
}

function startMatch(session: RoomSession, pair: { host: FakeConnection; guest: FakeConnection }): AnyMessage {
  readyBoth(session, pair);
  deliver(session, pair.host, buildClientLobbyStart(session.roomId));
  return pair.host.last('game.state')!;
}

function flipAction(session: RoomSession, actor: FakeConnection, matchId: string, stepNumber: number, requestId: string): void {
  const state = session.getMatch()!;
  const hidden = state.gameState.pieces.find((piece) => !piece.revealed && piece.position !== null);
  expect(hidden).toBeTruthy();
  deliver(
    session,
    actor,
    buildClientGameAction(session.roomId, {
      requestId,
      matchId,
      stepNumber,
      action: { type: 'flip', position: hidden!.position! },
    }),
  );
}

function fullHarness(): Harness {
  const { session, clock } = createSession();
  const pair = joinPair(session);
  return { session, clock, roomId: session.roomId, ...pair };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('无监听器的独立会话', () => {
  it('两个会话并行推进，同名 requestId / 凭据 / 断线 / 关闭只影响所属会话', () => {
    vi.useFakeTimers();
    const a = fullHarness();
    const b = fullHarness();
    expect(a.roomId).not.toBe(b.roomId);

    const startedA = startMatch(a.session, a);
    const startedB = startMatch(b.session, b);
    const matchIdA = startedA.payload.matchId;
    const matchIdB = startedB.payload.matchId;

    // 同名 requestId：A 先消费，B 仍能正常应用，互不串缓存。
    flipAction(a.session, a.host, matchIdA, 0, 'dup-act');
    expect(a.session.getMatch()!.stepNumber).toBe(1);
    flipAction(b.session, b.host, matchIdB, 0, 'dup-act');
    expect(b.session.getMatch()!.stepNumber).toBe(1);

    // 同一会话内重复 requestId 走幂等缓存，不再推进步数。
    flipAction(a.session, a.host, matchIdA, 1, 'dup-act');
    expect(a.session.getMatch()!.stepNumber).toBe(1);
    expect(a.host.last('game.state', (m) => m.requestId === 'dup-act')!.payload.stepNumber).toBe(1);

    // 凭据互不通用：A 的 host token / guest resumeToken 在 B 一律拒绝。
    const fakeHost = connect(b.session);
    deliver(b.session, fakeHost, buildClientHello({ role: 'host', name: '冒充', token: a.session.hostToken, roomId: b.roomId }));
    expect(fakeHost.last('error')!.payload.code).toBe('UNAUTHORIZED');
    expect(fakeHost.closeCode).toBe(CLOSE_CODES.UNAUTHORIZED);

    const fakeGuest = connect(b.session);
    deliver(b.session, fakeGuest, buildClientHello({ role: 'guest', name: '冒充', resumeToken: a.guestResumeToken, roomId: b.roomId }));
    expect(fakeGuest.last('error')!.payload.message).toBe('bad-resume-token');

    // A 的断线不影响 B 的成员与对局。
    a.session.handleDisconnect(a.guest.connectionId, 1006, 'net-down');
    expect(a.session.getMembers().find((m) => m.role === 'guest')!.connected).toBe(false);
    expect(b.session.getMembers().find((m) => m.role === 'guest')!.connected).toBe(true);
    expect(b.session.getMatch()!.settlement).toBeNull();

    // A 关闭不影响 B：B 连接不被关闭，仍可继续对局。
    a.session.close('host-closed');
    expect(a.host.closeCode).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect(b.host.closeCode).toBeNull();
    flipAction(b.session, b.guest, matchIdB, 1, 'b-next');
    expect(b.session.getMatch()!.stepNumber).toBe(2);
    expect(b.session.isClosed).toBe(false);
  });
});

describe('完整对局生命周期', () => {
  it('接入→就绪→开局→合法/非法动作→协商→结算→再局真正新开一局', () => {
    vi.useFakeTimers();
    const { session, clock, host, guest } = fullHarness();

    const started = startMatch(session, { host, guest });
    const matchId = started.payload.matchId;
    expect(session.getMatch()!.stepNumber).toBe(0);
    expect(started.payload.startParameters.redMemberId).toBe(session.getMembers()[0].id);

    // 非法动作：错误步数 / 错误对局 / 非己方回合，均不改变权威状态。
    flipAction(session, host, matchId, 7, 'bad-step');
    expect(host.last('game.rejected', (m) => m.requestId === 'bad-step')!.payload.reason).toContain('操作步数已过期');
    flipAction(session, host, 'other-match', 0, 'bad-match');
    expect(host.last('game.rejected', (m) => m.requestId === 'bad-match')!.payload.reason).toContain('对局标识不匹配');
    flipAction(session, guest, matchId, 0, 'not-your-turn');
    expect(guest.last('game.rejected', (m) => m.requestId === 'not-your-turn')!.payload.reason).toContain('非己方回合');
    expect(session.getMatch()!.stepNumber).toBe(0);

    // 合法动作：host 翻子推进一步，双方收到同一权威状态。
    flipAction(session, host, matchId, 0, 'flip-1');
    expect(session.getMatch()!.stepNumber).toBe(1);
    expect(guest.last('game.state')!.payload.stepNumber).toBe(1);

    // 协商：客人申请悔棋，房主同意后棋盘回退。
    const revisionAfterFlip = session.getMatch()!.revision;
    deliver(session, guest, buildClientGameNegotiate(session.roomId, { requestId: 'neg-undo', matchId, revision: revisionAfterFlip, kind: 'undo' }));
    const negotiationId = session.getMatch()!.pendingNegotiation!.negotiationId;
    deliver(
      session,
      host,
      buildClientGameNegotiateReply(session.roomId, { requestId: 'rep-undo', matchId, negotiationId, accept: true }),
    );
    expect(session.getMatch()!.stepNumber).toBe(0);
    expect(session.getMatch()!.pendingNegotiation).toBeNull();

    // 协商：求和达成 → 结算。
    flipAction(session, host, matchId, 0, 'flip-2');
    const revisionForDraw = session.getMatch()!.revision;
    deliver(session, guest, buildClientGameNegotiate(session.roomId, { requestId: 'neg-draw', matchId, revision: revisionForDraw, kind: 'draw' }));
    const drawNegotiationId = session.getMatch()!.pendingNegotiation!.negotiationId;
    deliver(
      session,
      host,
      buildClientGameNegotiateReply(session.roomId, { requestId: 'rep-draw', matchId, negotiationId: drawNegotiationId, accept: true }),
    );
    expect(session.getMatch()!.settlement).toMatchObject({ winner: null, reason: 'draw-agreement' });

    // 再局：回大厅后重新就绪开局，真正生成新对局。
    deliver(session, host, buildClientLobbyReturn(session.roomId, { matchId, intent: 'rematch' }));
    expect(session.getLobby().phase).toBe('lobby');
    expect(session.getLobby().ready).toMatchObject({ host: true, guest: false });
    deliver(session, guest, buildClientLobbyReady(session.roomId, true, 1));
    deliver(session, host, buildClientLobbyStart(session.roomId));
    const rematch = session.getMatch()!;
    expect(rematch.matchId).not.toBe(matchId);
    expect(rematch.stepNumber).toBe(0);
    expect(rematch.settlement).toBeNull();

    // 再局后旧 deadline 不影响新局：推进超过旧协商时限（30s）后新局不受任何旧事件干扰。
    clock.advance(31_000);
    expect(session.getMatch()!.matchId).toBe(rematch.matchId);
    expect(session.getMatch()!.settlement).toBeNull();
    expect(session.getMatch()!.pendingNegotiation).toBeNull();
    // 新局的协商链路仍然可用。
    deliver(session, guest, buildClientGameNegotiate(session.roomId, { requestId: 'neg-new', matchId: rematch.matchId, revision: session.getMatch()!.revision, kind: 'draw' }));
    expect(session.getMatch()!.pendingNegotiation).not.toBeNull();
    expect(host.last('game.state')!.payload.pendingNegotiation.type).toBe('draw');
  });
});

describe('连接归属与身份边界', () => {
  it('重连保持身份与席位、只替换连接；旧连接的迟到操作与迟到 close 不影响新连接', () => {
    vi.useFakeTimers();
    const { session, host, guest, guestMemberId, guestResumeToken } = fullHarness();
    const started = startMatch(session, { host, guest });
    const matchId = started.payload.matchId;

    // 客人以恢复凭据换接：身份与席位保持，仅连接替换。
    const guest2 = connect(session);
    const welcome = hello(session, guest2, { role: 'guest', name: '客人', resumeToken: guestResumeToken });
    expect(welcome.payload.memberId).toBe(guestMemberId);
    expect(guest.closeCode).toBe(CLOSE_CODES.UNAUTHORIZED);
    expect(guest.last('error')!.payload.message).toBe('socket-superseded');
    expect(session.getStanding(guest2.connectionId)).toBe('active');
    expect(session.getStanding(guest.connectionId)).toBe('superseded');

    // 旧连接迟到操作：拒绝且不改变权威状态。
    flipAction(session, guest, matchId, 0, 'late-act');
    expect(guest.last('error')!.payload.message).toBe('socket-superseded');
    expect(session.getMatch()!.stepNumber).toBe(0);

    // 新连接正常操作。
    flipAction(session, host, matchId, 0, 'fresh-act');
    expect(session.getMatch()!.stepNumber).toBe(1);

    // 旧连接迟到 close：不得把新连接标为离线，也不得触发掉线宽限。
    session.handleDisconnect(guest.connectionId, 1006, 'late-close');
    const guestSnapshot = session.getMembers().find((m) => m.role === 'guest')!;
    expect(guestSnapshot.connected).toBe(true);
    expect(session.getMatch()!.clock.disconnectGrace).toBeNull();
  });

  it('跨角色凭据互不通用：错误凭据一律拒绝，不回退为新成员', () => {
    vi.useFakeTimers();
    const { session, guest, guestResumeToken } = joinPairAndSpectate();

    // 客人凭据不能当旁观凭据。
    const fakeSpectator = connect(session);
    deliver(session, fakeSpectator, buildClientHello({ role: 'spectator', name: '冒充', resumeToken: guestResumeToken, roomId: session.roomId }));
    expect(fakeSpectator.last('error')!.payload.message).toBe('bad-resume-token');
    expect(fakeSpectator.closeCode).toBe(CLOSE_CODES.UNAUTHORIZED);

    // 旁观凭据不能当客人凭据。
    const spectator = connect(session);
    const spectatorWelcome = hello(session, spectator, { role: 'spectator', name: '旁观' });
    const spectatorResumeToken = spectatorWelcome.payload.resumeToken;
    const fakeGuest = connect(session);
    deliver(session, fakeGuest, buildClientHello({ role: 'guest', name: '冒充', resumeToken: spectatorResumeToken, roomId: session.roomId }));
    expect(fakeGuest.last('error')!.payload.message).toBe('bad-resume-token');

    // 房主凭据错误直接拒绝。
    const fakeHost = connect(session);
    deliver(session, fakeHost, buildClientHello({ role: 'host', name: '冒充', token: 'not-the-token', roomId: session.roomId }));
    expect(fakeHost.last('error')!.payload.message).toBe('bad-host-token');

    // 伪造凭据的连接不会进入成员名单。
    expect(session.getMembers().filter((m) => m.role === 'spectator')).toHaveLength(1);
    expect(guest.closeCode).toBeNull();
  });

  function joinPairAndSpectate(): { session: RoomSession; guest: FakeConnection; guestResumeToken: string } {
    const { session } = createSession();
    const pair = joinPair(session);
    return { session, guest: pair.guest, guestResumeToken: pair.guestResumeToken };
  }
});

describe('旁观只读', () => {
  it('旁观者可收听与 game.sync，其余动作按各自通道被拒', () => {
    vi.useFakeTimers();
    const { session, host, guest } = fullHarness();
    const spectator = connect(session);
    hello(session, spectator, { role: 'spectator', name: '旁观' });

    const started = startMatch(session, { host, guest });
    const matchId = started.payload.matchId;

    // 大厅动作：只回复请求方。
    deliver(session, spectator, buildClientLobbyReady(session.roomId, true, 1));
    expect(spectator.last('lobby.rejected')!.payload.code).toBe('SPECTATOR_READONLY');

    // 对局动作：非致命拒绝。
    flipAction(session, spectator, matchId, 0, 'spec-act');
    expect(spectator.last('game.rejected', (m) => m.requestId === 'spec-act')!.payload.reason).toContain('旁观者不可操作对局');

    // 快捷短语：走短语通道拒绝。
    deliver(session, spectator, buildClientChatPhrase(session.roomId, { requestId: 'spec-chat', matchId, phraseId: 'phrase-gg-1' }));
    expect(spectator.last('chat.phrase.rejected')!.payload.code).toBe('NOT_A_PLAYER');

    // game.sync 只读可用。
    deliver(session, spectator, buildClientGameSync(session.roomId, matchId, 'spec-sync'));
    expect(spectator.last('game.state', (m) => m.requestId === 'spec-sync')!.payload.matchId).toBe(matchId);

    // 旁观者收到对局广播，且不影响权威状态。
    flipAction(session, host, matchId, 0, 'flip-1');
    expect(spectator.last('game.state')!.payload.stepNumber).toBe(1);
    expect(session.getMatch()!.stepNumber).toBe(1);

    // 旁观者离开不影响对局。
    deliver(session, spectator, buildClientLeave(session.roomId));
    expect(session.getMembers().filter((m) => m.role === 'spectator')).toHaveLength(0);
    expect(session.getMatch()!.settlement).toBeNull();
  });
});

describe('快照副本与关闭幂等', () => {
  it('getLobby / getMatch 返回独立副本', () => {
    vi.useFakeTimers();
    const { session, host, guest } = fullHarness();
    const started = startMatch(session, { host, guest });

    const lobbyCopy = session.getLobby();
    // 大厅快照为深拷贝 + 冻结：外部改动既抛错也不会回灌权威状态。
    expect(Object.isFrozen(lobbyCopy)).toBe(true);
    expect(() => {
      (lobbyCopy.ready as { host: boolean }).host = false;
    }).toThrow();
    expect(() => {
      (lobbyCopy.settings as { settingsVersion: number }).settingsVersion = 999;
    }).toThrow();
    expect(session.getLobby().ready.host).toBe(true);
    expect(session.getLobby().settings.settingsVersion).toBe(1);

    const matchCopy = session.getMatch()!;
    matchCopy.stepNumber = 42;
    matchCopy.gameState.pieces.pop();
    const fresh = session.getMatch()!;
    expect(fresh.stepNumber).toBe(0);
    expect(fresh.matchId).toBe(started.payload.matchId);
    expect(fresh.gameState.pieces.length).toBeGreaterThan(matchCopy.gameState.pieces.length);
  });

  it('close 幂等：只通知一次、连接只关闭一次，关闭后命令与定时器不再生效', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { session, clock, host, guest } = fullHarnessWith(onClose);
    startMatch(session, { host, guest });

    session.close('host-closed');
    session.close('server-stopped');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('host-closed');
    expect(host.closeCode).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect(guest.closeCode).toBe(CLOSE_CODES.ROOM_CLOSED);
    expect(host.closeCount).toBe(1);

    const sentAfterClose = host.sent.length;
    deliver(session, host, buildClientLobbyStart(session.roomId));
    expect(host.sent.length).toBe(sentAfterClose);
    expect(session.getMatch()).toBeNull();

    // 关闭后推进时间不应再有任何定时器副作用或异常。
    clock.advance(300_000);
    expect(host.sent.length).toBe(sentAfterClose);
    session.handleDisconnect(guest.connectionId, 1006, 'late');
    expect(session.isClosed).toBe(true);
  });

  function fullHarnessWith(onClose: (reason: string) => void): Harness {
    const { session, clock } = createSession({ onClose });
    const pair = joinPair(session);
    return { session, clock, roomId: session.roomId, ...pair };
  }
});

describe('受控时间：掉线宽限与协商', () => {
  it('客人 90 秒内恢复不结算，超过 90 秒按 disconnect-timeout 结算', () => {
    vi.useFakeTimers();
    const first = fullHarness();
    startMatch(first.session, { host: first.host, guest: first.guest });

    first.session.handleDisconnect(first.guest.connectionId, 1006, 'net-down');
    const grace = first.session.getMatch()!.clock.disconnectGrace!;
    expect(grace.guestDeadlineMs).toBe(first.clock.now + 90_000);
    expect(first.session.getMatch()!.settlement).toBeNull();

    // 89 秒内恢复：不结算，宽限清除。
    first.clock.advance(89_000);
    const guest2 = connect(first.session);
    hello(first.session, guest2, { role: 'guest', name: '客人', resumeToken: first.guestResumeToken });
    expect(first.session.getMatch()!.settlement).toBeNull();
    expect(first.session.getMatch()!.clock.disconnectGrace).toBeNull();
    first.clock.advance(300_000);
    expect(first.session.getMatch()!.settlement).toBeNull();

    // 超过 90 秒未恢复：判负结算。
    const second = fullHarness();
    startMatch(second.session, { host: second.host, guest: second.guest });
    second.session.handleDisconnect(second.guest.connectionId, 1006, 'net-down');
    second.clock.advance(91_000);
    expect(second.session.getMatch()!.settlement).toMatchObject({ winner: 'red', reason: 'disconnect-timeout' });
  });

  it('双方掉线按各自宽限到期结算，先到期方判负', () => {
    vi.useFakeTimers();
    const { session, clock, host, guest } = fullHarness();
    startMatch(session, { host, guest });

    session.handleDisconnect(host.connectionId, 1006, 'host-down');
    clock.advance(5_000);
    session.handleDisconnect(guest.connectionId, 1006, 'guest-down');

    const grace = session.getMatch()!.clock.disconnectGrace!;
    expect(grace.hostDeadlineMs).toBeLessThan(grace.guestDeadlineMs!);
    expect(session.getMembers().every((m) => m.role === 'spectator' || m.connected === false)).toBe(true);

    clock.advance(92_000);
    // 房主执红且先掉线：先到期判负，客人（黑）获胜。
    expect(session.getMatch()!.settlement).toMatchObject({ winner: 'black', reason: 'disconnect-timeout' });
  });

  it('协商中掉线取消协商并恢复时钟，旧 deadline 不影响后续对局', () => {
    vi.useFakeTimers();
    const { session, clock, host, guest, guestResumeToken } = fullHarness();
    const started = startMatch(session, { host, guest });
    const matchId = started.payload.matchId;

    flipAction(session, host, matchId, 0, 'flip-1');
    deliver(session, guest, buildClientGameNegotiate(session.roomId, { requestId: 'neg-undo', matchId, revision: session.getMatch()!.revision, kind: 'undo' }));
    expect(session.getMatch()!.pendingNegotiation!.type).toBe('undo');

    // 协商进行中掉线：协商取消、时钟恢复。
    session.handleDisconnect(guest.connectionId, 1006, 'net-down');
    expect(session.getMatch()!.pendingNegotiation).toBeNull();
    expect(session.getMatch()!.negotiationEvent!.type).toBe('negotiation-cancelled');

    // 推进越过旧协商 deadline（30s）：不再产生任何旧事件。
    clock.advance(31_000);
    expect(session.getMatch()!.pendingNegotiation).toBeNull();
    expect(session.getMatch()!.settlement).toBeNull();

    // 恢复连接后对局继续，走子与协商照常。
    const guest2 = connect(session);
    const welcome = hello(session, guest2, { role: 'guest', name: '客人', resumeToken: guestResumeToken });
    expect(welcome.payload.memberId).toBe(session.getMembers()[1].id);
    flipAction(session, guest2, matchId, 1, 'flip-2');
    expect(session.getMatch()!.stepNumber).toBe(2);
  });
});
