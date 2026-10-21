// @vitest-environment node
/**
 * 在线模式会话：可信匿名身份准入、席位恢复与入口互斥。
 * 这里只驱动 RoomSession（无 socket），真实 HTTPS/WSS 链路由 online-runtime 测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import { RoomSession, type SessionConnection } from '../room-session';
import { asConnectionId, asIdentityId, generateId, type ConnectionId, type RoomIdentity } from '../room-identity';
import {
  buildClientGameAction,
  buildClientHello,
  buildClientLeave,
  buildClientLobbyReady,
  buildClientLobbyStart,
  buildClientOnlineHello,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
} from '../../src/network/protocol';

type AnyMessage = Record<string, any>;

class FakeConnection implements SessionConnection {
  readonly connectionId: ConnectionId = asConnectionId(generateId());
  readonly sent: AnyMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  last(type: string): AnyMessage | null {
    const matches = this.sent.filter((message) => message.type === type);
    return matches.length > 0 ? matches[matches.length - 1]! : null;
  }

  types(): string[] {
    return this.sent.map((message) => message.type);
  }
}

function deliver(session: RoomSession, connection: FakeConnection, message: ClientMessage): void {
  const parsed = parseClientMessage(encodeMessage(message));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    session.handleMessage(connection.connectionId, parsed.message);
  }
}

function identity(id: string): RoomIdentity {
  return { identityId: asIdentityId(id), kind: 'anonymous', displayName: '匿名玩家' };
}

function createSession(owner: string): RoomSession {
  return new RoomSession({
    roomId: 'room-online-1',
    mode: 'online',
    ownerIdentityId: asIdentityId(owner),
    nowFn: () => 10_000,
    drawHostRed: () => true,
    drawSeed: () => 42,
    clockIntervalMs: 60_000,
    logger: () => undefined,
    randomId: (() => {
      let seq = 0;
      return () => `member-${(seq += 1)}`;
    })(),
  });
}

function joinOnline(session: RoomSession, roomIdentity: RoomIdentity): { connection: FakeConnection; welcome: AnyMessage } {
  const connection = new FakeConnection();
  session.attach(connection, { identity: roomIdentity });
  deliver(session, connection, buildClientOnlineHello(session.roomId));
  const welcome = connection.last('welcome');
  expect(welcome).not.toBeNull();
  return { connection, welcome: welcome! };
}

describe('在线会话准入', () => {
  it('建房者身份取得房主，新身份成为客人，第三人只得到旁观席位', () => {
    const session = createSession('owner-1');
    const host = joinOnline(session, identity('owner-1'));
    const guest = joinOnline(session, identity('guest-1'));
    const spectator = joinOnline(session, identity('watcher-1'));

    expect(host.welcome.payload.role).toBe('host');
    expect(guest.welcome.payload.role).toBe('guest');
    expect(spectator.welcome.payload.role).toBe('spectator');
    // 在线 welcome 不携带任何 LAN 恢复凭据。
    for (const joined of [host, guest, spectator]) {
      expect(joined.welcome.payload.resumeToken).toBeUndefined();
      expect(joined.welcome.payload).not.toHaveProperty('hostToken');
    }
  });

  it('同一身份重连保持成员与角色，只替换连接；旧连接被拒', () => {
    const session = createSession('owner-1');
    joinOnline(session, identity('owner-1'));
    const guest = joinOnline(session, identity('guest-1'));

    const resumed = joinOnline(session, identity('guest-1'));
    expect(resumed.welcome.payload.memberId).toBe(guest.welcome.payload.memberId);
    expect(resumed.welcome.payload.role).toBe('guest');
    expect(session.getMembers().filter((member) => member.role === 'guest')).toHaveLength(1);

    // 旧连接被替换：迟到消息与迟到关闭都不影响新连接。
    deliver(
      session,
      guest.connection,
      buildClientGameAction(session.roomId, {
        requestId: 'late-action',
        matchId: 'no-match',
        stepNumber: 0,
        action: { type: 'flip', position: { x: 0, y: 6 } },
      }),
    );
    expect(guest.connection.last('error')?.payload.code).toBe('UNAUTHORIZED');
    session.handleDisconnect(guest.connection.connectionId, 1006, 'late');
    expect(session.getMembers().find((member) => member.role === 'guest')?.connected).toBe(true);
  });

  it('在线入口拒绝 LAN hello，LAN 会话拒绝 online.hello', () => {
    const online = createSession('owner-1');
    const lanHello = new FakeConnection();
    online.attach(lanHello, { identity: identity('owner-1') });
    deliver(online, lanHello, buildClientHello({ role: 'host', name: '房主', token: 'anything' }));
    expect(lanHello.last('error')?.payload.message).toBe('lan-hello-not-allowed');

    const lanSession = new RoomSession({ roomId: 'room-lan', logger: () => undefined });
    const onlineHello = new FakeConnection();
    lanSession.attach(onlineHello);
    deliver(lanSession, onlineHello, buildClientOnlineHello('room-lan'));
    expect(onlineHello.last('error')?.payload.message).toBe('online-hello-not-allowed');
  });

  it('没有可信身份登记的连接无法用 online.hello 落座', () => {
    const session = createSession('owner-1');
    const connection = new FakeConnection();
    session.attach(connection);
    deliver(session, connection, buildClientOnlineHello('room-online-1'));

    expect(connection.last('error')?.payload.code).toBe('UNAUTHORIZED');
    expect(connection.last('welcome')).toBeNull();
    expect(session.getMembers()).toHaveLength(0);
  });

  it('在线等待阶段房主掉线保留房间与席位，刷新后恢复房主', () => {
    const session = createSession('owner-1');
    const host = joinOnline(session, identity('owner-1'));
    session.handleDisconnect(host.connection.connectionId, 1006, 'refresh');

    expect(session.isClosed).toBe(false);
    expect(session.isHostConnected()).toBe(false);

    const resumed = joinOnline(session, identity('owner-1'));
    expect(resumed.welcome.payload.role).toBe('host');
    expect(resumed.welcome.payload.memberId).toBe(host.welcome.payload.memberId);
    expect(session.isHostConnected()).toBe(true);
  });

  it('其他身份不能顶替已有客人席位，也不能通过自报字段改变角色', () => {
    const session = createSession('owner-1');
    joinOnline(session, identity('owner-1'));
    const guest = joinOnline(session, identity('guest-1'));

    const intruder = joinOnline(session, identity('intruder-1'));
    expect(intruder.welcome.payload.role).toBe('spectator');
    expect(session.getMembers().find((member) => member.role === 'guest')?.id).toBe(
      guest.welcome.payload.memberId,
    );

    // 旁观者写动作被拒绝，不改变房间状态。
    deliver(
      session,
      intruder.connection,
      buildClientGameAction(session.roomId, {
        requestId: 'spectator-action',
        matchId: 'no-match',
        stepNumber: 0,
        action: { type: 'flip', position: { x: 0, y: 6 } },
      }),
    );
    expect(intruder.connection.last('error')).toBeNull();
    expect(intruder.connection.last('game.rejected')).not.toBeNull();
  });

  it('在线显式离开由服务器按角色处理：客人释放席位，房主关闭房间', () => {
    const session = createSession('owner-1');
    const host = joinOnline(session, identity('owner-1'));
    const guest = joinOnline(session, identity('guest-1'));

    deliver(session, guest.connection, buildClientLeave(session.roomId));
    expect(session.getMembers().some((member) => member.role === 'guest')).toBe(false);

    const replacement = joinOnline(session, identity('guest-2'));
    expect(replacement.welcome.payload.role).toBe('guest');

    const closed: string[] = [];
    const closing = new RoomSession({
      roomId: 'room-online-2',
      mode: 'online',
      ownerIdentityId: asIdentityId('owner-2'),
      logger: () => undefined,
      onClose: (reason) => closed.push(reason),
    });
    const closingHost = joinOnline(closing, identity('owner-2'));
    deliver(closing, closingHost.connection, buildClientLeave(closing.roomId));
    expect(closed).toEqual(['host-closed']);
    expect(host.connection.last('welcome')).not.toBeNull();
  });

  it('在线对局掉线沿用权威计时，不重发历史动作', () => {
    let now = 10_000;
    const session = new RoomSession({
      roomId: 'room-online-3',
      mode: 'online',
      ownerIdentityId: asIdentityId('owner-3'),
      nowFn: () => now,
      drawHostRed: () => true,
      drawSeed: () => 42,
      clockIntervalMs: 60_000,
      logger: () => undefined,
    });

    const host = joinOnline(session, identity('owner-3'));
    const guest = joinOnline(session, identity('guest-3'));
    const settingsVersion = session.getLobby().settings.settingsVersion;

    deliver(session, host.connection, buildClientLobbyReady(session.roomId, true, settingsVersion));
    deliver(session, guest.connection, buildClientLobbyReady(session.roomId, true, settingsVersion));
    now += 10;
    deliver(session, host.connection, buildClientLobbyStart(session.roomId));
    expect(session.getLobbyPhase()).toBe('started');

    const before = session.getMatch()!;
    const revisionBefore = before.revision;
    const stepBefore = before.stepNumber;

    session.handleDisconnect(guest.connection.connectionId, 1006, 'network');
    expect(session.isClosed).toBe(false);
    const afterDrop = session.getMatch()!;
    expect(afterDrop.stepNumber).toBe(stepBefore);
    expect(afterDrop.revision).toBeGreaterThan(revisionBefore);
    expect(afterDrop.gameState.actionHistory).toHaveLength(stepBefore);
    expect(afterDrop.settlement).toBeNull() ;

    // 重新上线恢复原席位，动作历史不重放。
    const resumed = joinOnline(session, identity('guest-3'));
    expect(resumed.welcome.payload.memberId).toBe(guest.welcome.payload.memberId);
    expect(resumed.welcome.payload.game?.stepNumber).toBe(stepBefore);
    expect(session.getMatch()!.gameState.actionHistory).toHaveLength(stepBefore);
  });
});
