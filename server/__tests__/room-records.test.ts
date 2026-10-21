// @vitest-environment node
/**
 * 终局棋谱：结算冻结、按 matchId 保留、授权与保密边界。
 *
 * 覆盖：
 * - 正常将死 / 和棋 / 认输 / 超时 / 悔棋后终局各一份，内容来自服务器权威开局帧与有效主线；
 * - 双方玩家与本房获准旁观者可取回；未结算、过期、再局后旧档、其他房间均明确不可用；
 * - 进行中的任何出站消息都不含 seed / initial / 未翻身份。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSession, type RoomSessionOptions, type SessionConnection } from '../room-session';
import { asConnectionId, generateId, type ConnectionId } from '../room-identity';
import {
  buildClientGameAction,
  buildClientGameRecordRequest,
  buildClientGameResign,
  buildClientHello,
  buildClientLobbyReady,
  buildClientLobbyReturn,
  buildClientLobbySettings,
  buildClientLobbyStart,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
} from '../../src/network/protocol';
import { parseRecord } from '../../src/records/record';
import { actions as checkmateActions } from '../../src/records/__tests__/fixture';

type AnyMessage = Record<string, any>;

class FakeConnection implements SessionConnection {
  readonly connectionId: ConnectionId = asConnectionId(generateId());
  readonly sent: AnyMessage[] = [];
  closeCode: number | null = null;

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  close(code: number): void {
    this.closeCode = code;
  }

  messages(type: string, predicate?: (message: AnyMessage) => boolean): AnyMessage[] {
    return this.sent.filter((message) => message.type === type && (!predicate || predicate(message)));
  }

  last(type: string, predicate?: (message: AnyMessage) => boolean): AnyMessage | null {
    const matches = this.messages(type, predicate);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }
}

class FakeClock {
  now = 1_000_000;
  readonly nowFn = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
    vi.advanceTimersByTime(ms);
  }
}

function connect(session: RoomSession): FakeConnection {
  const connection = new FakeConnection();
  session.attach(connection);
  return connection;
}

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

interface Harness {
  session: RoomSession;
  clock: FakeClock;
  host: FakeConnection;
  guest: FakeConnection;
  hostMemberId: string;
  guestMemberId: string;
  matchId: string;
}

function createSession(overrides: Partial<RoomSessionOptions> = {}): { session: RoomSession; clock: FakeClock } {
  const clock = new FakeClock();
  const session = new RoomSession({
    nowFn: clock.nowFn,
    drawHostRed: () => true,
    drawSeed: () => 2,
    clockIntervalMs: 60_000,
    logger: () => undefined,
    ...overrides,
  });
  return { session, clock };
}

function startPair(overrides: Partial<RoomSessionOptions> = {}, timed = false): Harness {
  const { session, clock } = createSession(overrides);
  const host = connect(session);
  const hostWelcome = hello(session, host, { role: 'host', name: '房主', token: session.hostToken });
  const guest = connect(session);
  const guestWelcome = hello(session, guest, { role: 'guest', name: '客人' });
  if (timed) {
    deliver(session, host, buildClientLobbySettings(session.roomId, { sidePreference: 'host-red', timeControlId: 'standard' }));
  }
  const version = timed ? 2 : 1;
  deliver(session, host, buildClientLobbyReady(session.roomId, true, version));
  deliver(session, guest, buildClientLobbyReady(session.roomId, true, version));
  deliver(session, host, buildClientLobbyStart(session.roomId));
  const started = host.last('game.state')!;
  return {
    session,
    clock,
    host,
    guest,
    hostMemberId: hostWelcome.payload.memberId,
    guestMemberId: guestWelcome.payload.memberId,
    matchId: started.payload.matchId,
  };
}

function requestRecord(session: RoomSession, connection: FakeConnection, matchId: string, requestId: string): void {
  deliver(session, connection, buildClientGameRecordRequest(session.roomId, { requestId, matchId }));
}

function playCheckmate(h: Harness): void {
  let actor = h.host;
  for (const action of checkmateActions) {
    const state = h.session.getMatch()!;
    deliver(
      h.session,
      actor,
      buildClientGameAction(h.session.roomId, {
        requestId: `step-${state.stepNumber + 1}`,
        matchId: h.matchId,
        stepNumber: state.stepNumber,
        revision: state.revision,
        action,
      }),
    );
    actor = actor === h.host ? h.guest : h.host;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('终局棋谱的内容与结算', () => {
  it('将死后由服务器交付完整格式 1 棋谱，初始布局来自该局开局帧且只含有效主线', () => {
    vi.useFakeTimers();
    const h = startPair();
    playCheckmate(h);
    const settled = h.session.getMatch()!;
    expect(settled.gameState.winner).toBe('red');
    expect(settled.settlement?.reason).toBe('checkmate');

    requestRecord(h.session, h.host, h.matchId, 'rec-host');
    const message = h.host.last('game.record', (m) => m.requestId === 'rec-host')!;
    expect(message).toBeTruthy();
    const record = parseRecord(message.payload.json);
    expect(record.opening.mode).toBe('online');
    expect(record.opening.seats).toEqual({ red: '房主', black: '客人' });
    expect(record.opening.seed).toBeUndefined();
    expect(record.initial).toEqual(JSON.parse(JSON.stringify(settled.initial)));
    expect(record.final).toEqual(JSON.parse(JSON.stringify(settled.gameState)));
    expect(record.moves).toHaveLength(25);
    expect(record.result).toMatchObject({ winner: 'red', reason: 'checkmate', totalSteps: 25, timeBasis: 'player-clocks' });
    expect(record.result.durationSeconds).toBe(
      (settled.settlement!.redDurationSeconds + settled.settlement!.blackDurationSeconds),
    );
    expect(message.payload.text).toContain('将死');
    expect(message.payload.expiresAt).toBe(settled.settlement!.endedAt + 30 * 60_000);
    // 初始布局含未翻暗子，但只在授权终局响应里出现。
    expect(record.initial.pieces.some((p) => !p.revealed)).toBe(true);
  });

  it.each(['draw-agreement', 'resignation'] as const)('零步 %s 生成不含虚构步数的棋谱', (reason) => {
    vi.useFakeTimers();
    const h = startPair();
    if (reason === 'resignation') {
      deliver(h.session, h.host, buildClientGameResign(h.session.roomId, { requestId: 'r1', matchId: h.matchId, revision: h.session.getMatch()!.revision }));
    } else {
      const now = h.clock.now;
      // 通过 direct finalize 不可用：走协商两步，双方同意和棋。
      // 这里以房主发起、客人接受的真实消息链完成和棋。
      const revision = h.session.getMatch()!.revision;
      deliver(h.session, h.host, {
        version: 10,
        type: 'game.negotiate',
        requestId: 'n1',
        roomId: h.session.roomId,
        payload: { matchId: h.matchId, revision, kind: 'draw' },
      } as ClientMessage);
      const pending = h.session.getMatch()!.pendingNegotiation!;
      deliver(h.session, h.guest, {
        version: 10,
        type: 'game.negotiate.reply',
        requestId: 'n2',
        roomId: h.session.roomId,
        payload: { matchId: h.matchId, negotiationId: pending.negotiationId, accept: true },
      } as ClientMessage);
      expect(h.session.getMatch()!.settlement!.endedAt).toBe(now);
    }
    requestRecord(h.session, h.host, h.matchId, 'rec');
    const record = parseRecord(h.host.last('game.record')!.payload.json);
    expect(record.moves).toEqual([]);
    expect(record.result.reason).toBe(reason);
    expect(record.result.winner).toBe(reason === 'resignation' ? 'black' : null);
    expect(record.result.totalSteps).toBe(0);
  });

  it('悔棋后再终局只保留最终有效主线，撤销步骤不进入棋谱', () => {
    vi.useFakeTimers();
    const h = startPair();
    const state = h.session.getMatch()!;
    const hidden = state.gameState.pieces.find((p) => !p.revealed && p.position !== null)!;
    deliver(h.session, h.host, buildClientGameAction(h.session.roomId, {
      requestId: 'a1', matchId: h.matchId, stepNumber: 0, revision: state.revision,
      action: { type: 'flip', position: hidden.position! },
    }));
    const afterFirst = h.session.getMatch()!;
    const revision = afterFirst.revision;
    deliver(h.session, h.host, {
      version: 10, type: 'game.negotiate', requestId: 'u1', roomId: h.session.roomId,
      payload: { matchId: h.matchId, revision, kind: 'undo' },
    } as ClientMessage);
    const pending = h.session.getMatch()!.pendingNegotiation!;
    deliver(h.session, h.guest, {
      version: 10, type: 'game.negotiate.reply', requestId: 'u2', roomId: h.session.roomId,
      payload: { matchId: h.matchId, negotiationId: pending.negotiationId, accept: true },
    } as ClientMessage);
    deliver(h.session, h.host, buildClientGameResign(h.session.roomId, { requestId: 'r1', matchId: h.matchId, revision: h.session.getMatch()!.revision }));

    requestRecord(h.session, h.host, h.matchId, 'rec');
    const record = parseRecord(h.host.last('game.record')!.payload.json);
    expect(record.moves).toEqual([]);
    expect(record.final.actionHistory).toEqual([]);
    expect(record.result.reason).toBe('resignation');
  });

  it('步时超时结算的棋谱使用权威用时且不虚构最后一步', () => {
    vi.useFakeTimers();
    const h = startPair({}, true);
    // 超过 standard 局时后由下一次动作的权威时钟推进检出超时并结算。
    h.clock.advance(11 * 60_000);
    const before = h.session.getMatch()!;
    const hidden = before.gameState.pieces.find((p) => !p.revealed && p.position !== null)!;
    deliver(h.session, h.host, buildClientGameAction(h.session.roomId, {
      requestId: 'too-late', matchId: h.matchId, stepNumber: before.stepNumber, revision: before.revision,
      action: { type: 'flip', position: hidden.position! },
    }));
    const settled = h.session.getMatch()!;
    expect(settled.settlement?.reason).toBe('step-timeout');
    expect(settled.stepNumber).toBe(0);
    requestRecord(h.session, h.guest, h.matchId, 'rec');
    const record = parseRecord(h.guest.last('game.record')!.payload.json);
    expect(record.moves).toEqual([]);
    expect(record.result.reason).toBe('step-timeout');
    expect(record.result.durationSeconds).toBe(
      settled.settlement!.redDurationSeconds + settled.settlement!.blackDurationSeconds,
    );
  });
});

describe('授权、房间隔离与保留期限', () => {
  it('掉线超时结算同样归档，棋谱不再等待掉线方', () => {
    vi.useFakeTimers();
    const h = startPair();
    h.session.handleDisconnect(h.guest.connectionId, 1006, 'net-down');
    h.clock.advance(96_000);
    const settled = h.session.getMatch()!;
    expect(settled.settlement?.reason).toBe('disconnect-timeout');
    requestRecord(h.session, h.host, h.matchId, 'drop');
    const record = parseRecord(h.host.last('game.record')!.payload.json);
    expect(record.result.reason).toBe('disconnect-timeout');
    expect(record.result.winner).toBe('red');
    expect(record.moves).toEqual([]);
  });

  it('进行中的对局明确不可用，且所有出站消息都不含 seed / initial / 未翻身份', () => {
    vi.useFakeTimers();
    const h = startPair();
    requestRecord(h.session, h.host, h.matchId, 'early');
    const unavailable = h.host.last('game.record.unavailable')!;
    expect(unavailable.payload).toEqual({ matchId: h.matchId, code: 'NOT_FINISHED', message: expect.any(String) });
    expect(h.host.messages('game.record')).toHaveLength(0);

    const serialized = JSON.stringify([
      ...h.host.sent,
      ...h.guest.sent,
    ]);
    expect(serialized).not.toContain('"seed"');
    expect(serialized).not.toContain('"initial"');
    expect(serialized).not.toContain('publicPieceIds');
  });

  it('本房双方与获准旁观者可读；另一房间、伪造 matchId 与离开后的旁观者均不可读', () => {
    vi.useFakeTimers();
    const a = startPair();
    deliver(a.session, a.host, buildClientGameResign(a.session.roomId, { requestId: 'r1', matchId: a.matchId, revision: a.session.getMatch()!.revision }));
    const spectator = connect(a.session);
    const spectatorWelcome = hello(a.session, spectator, { role: 'spectator', name: '观众' });
    expect(spectatorWelcome.payload.records).toEqual([
      { matchId: a.matchId, endedAt: a.clock.now, expiresAt: a.clock.now + 30 * 60_000 },
    ]);

    requestRecord(a.session, a.guest, a.matchId, 'g1');
    expect(parseRecord(a.guest.last('game.record')!.payload.json).result.reason).toBe('resignation');
    requestRecord(a.session, spectator, a.matchId, 's1');
    expect(parseRecord(spectator.last('game.record')!.payload.json).result.reason).toBe('resignation');

    // 另一房间：只能按自己的会话取档，跨房 matchId 明确不可用。
    const b = startPair();
    requestRecord(b.session, b.host, a.matchId, 'cross');
    expect(b.host.last('game.record.unavailable')!.payload).toMatchObject({ matchId: a.matchId, code: 'UNAVAILABLE' });
    expect(b.host.messages('game.record')).toHaveLength(0);

    // 伪造不存在的 matchId：同样不暴露是否存在其他房间。
    requestRecord(a.session, a.host, 'made-up', 'fake');
    expect(a.host.last('game.record.unavailable')!.payload).toMatchObject({ matchId: 'made-up', code: 'UNAVAILABLE' });

    // 离开后的旁观众连接不再属于房间，无法继续请求。
    deliver(a.session, spectator, {
      version: 10, type: 'leave', roomId: a.session.roomId, payload: {},
    } as ClientMessage);
    const before = spectator.messages('game.record').length;
    deliver(a.session, spectator, buildClientGameRecordRequest(a.session.roomId, { requestId: 'after-leave', matchId: a.matchId }));
    expect(spectator.messages('game.record').length).toBe(before);
  });

  it('30 分钟保留：到期前可读，到期后明确不可用；重复请求不续期', () => {
    vi.useFakeTimers();
    const h = startPair();
    deliver(h.session, h.host, buildClientGameResign(h.session.roomId, { requestId: 'r1', matchId: h.matchId, revision: h.session.getMatch()!.revision }));
    const endedAt = h.session.getMatch()!.settlement!.endedAt;

    h.clock.advance(29 * 60_000 + 59_999);
    requestRecord(h.session, h.host, h.matchId, 'late-1');
    expect(h.host.last('game.record')).toBeTruthy();
    requestRecord(h.session, h.host, h.matchId, 'late-2');
    expect(h.host.last('game.record')!.payload.expiresAt).toBe(endedAt + 30 * 60_000);

    h.clock.advance(1);
    requestRecord(h.session, h.host, h.matchId, 'expired');
    expect(h.host.last('game.record.unavailable')!.payload).toMatchObject({ matchId: h.matchId, code: 'UNAVAILABLE' });
  });

  it('再局后旧棋谱仍按原 matchId 保留且不读取新局；进行中的新局仅返回 NOT_FINISHED', () => {
    vi.useFakeTimers();
    const h = startPair();
    deliver(h.session, h.host, buildClientGameResign(h.session.roomId, { requestId: 'r1', matchId: h.matchId, revision: h.session.getMatch()!.revision }));
    requestRecord(h.session, h.host, h.matchId, 'old-1');
    const oldJson = h.host.last('game.record')!.payload.json;
    const oldExpiry = h.host.last('game.record')!.payload.expiresAt;

    deliver(h.session, h.host, buildClientLobbyReturn(h.session.roomId, { matchId: h.matchId, intent: 'rematch' }));
    deliver(h.session, h.guest, buildClientLobbyReturn(h.session.roomId, { matchId: h.matchId, intent: 'rematch' }));
    deliver(h.session, h.host, buildClientLobbyStart(h.session.roomId));
    const second = h.session.getMatch()!;
    expect(second.matchId).not.toBe(h.matchId);

    requestRecord(h.session, h.host, h.matchId, 'old-2');
    expect(h.host.last('game.record', (m) => m.requestId === 'old-2')!.payload.json).toBe(oldJson);
    expect(h.host.last('game.record', (m) => m.requestId === 'old-2')!.payload.expiresAt).toBe(oldExpiry);

    requestRecord(h.session, h.host, second.matchId, 'new');
    expect(h.host.last('game.record.unavailable', (m) => m.requestId === 'new')!.payload).toMatchObject({
      matchId: second.matchId,
      code: 'NOT_FINISHED',
    });
    const newUnavailable = h.host.last('game.record.unavailable', (m) => m.requestId === 'new')!;
    expect(JSON.stringify(newUnavailable.payload)).not.toContain('initial');
    expect(JSON.stringify(newUnavailable.payload)).not.toContain('seed');
  });

  it('无人请求时到期档案也会被定时清理；关闭房间后档案不可用', () => {
    vi.useFakeTimers();
    const h = startPair({ recordTtlMs: 1_000 });
    deliver(h.session, h.host, buildClientGameResign(h.session.roomId, { requestId: 'r1', matchId: h.matchId, revision: h.session.getMatch()!.revision }));
    h.clock.advance(61_000);
    requestRecord(h.session, h.host, h.matchId, 'gone');
    expect(h.host.last('game.record.unavailable')!.payload.code).toBe('UNAVAILABLE');

    const other = startPair();
    deliver(other.session, other.host, buildClientGameResign(other.session.roomId, { requestId: 'r1', matchId: other.matchId, revision: other.session.getMatch()!.revision }));
    other.session.close('host-closed');
    requestRecord(other.session, other.guest, other.matchId, 'closed');
    // 关闭后会话不再处理消息，也不存在任何记录正文。
    expect(other.guest.messages('game.record')).toHaveLength(0);
  });
});
