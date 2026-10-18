import { describe, expect, it } from 'vitest';
import { createLobbyState, applyLobbyCommand, type LobbyState } from '../lobby';
import {
  buildClientGameAction,
  buildClientGameSync,
  buildClientHello,
  buildClientLeave,
  buildClientLobbyReady,
  buildClientLobbySettings,
  buildPing,
  buildPong,
  buildServerMessage,
  closeCodeForError,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  serverErrorCodeForCloseCode,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../protocol';

function welcome(roomId: string, memberId: string, lobby: LobbyState = createLobbyState()): ServerMessage {
  return {
    version: PROTOCOL_VERSION,
    type: 'welcome',
    roomId,
    payload: {
      roomId,
      memberId,
      role: 'host',
      name: '房主',
      members: [{ id: memberId, role: 'host', name: '房主', connected: true }],
      lobby,
    },
  };
}

describe('protocol envelope', () => {
  it('accepts a well-formed hello and reports the identity fields', () => {
    const raw = encodeMessage(buildClientHello({ role: 'guest', name: '客人' }));
    const parsed = parseClientMessage(raw);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.message.type).toBe('hello');
    expect(parsed.message.roomId).toBeNull();
    expect(parsed.message.payload.role).toBe('guest');
    expect(parsed.message.payload.name).toBe('客人');
  });

  it('rejects malformed json and non-object payloads with INVALID_MESSAGE', () => {
    const notJson = parseClientMessage('{oops');
    const notObject = parseClientMessage('[1,2,3]');
    const missingType = parseClientMessage(JSON.stringify({ version: PROTOCOL_VERSION, roomId: null }));

    expect(notJson).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(notObject).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(missingType).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });

  it('rejects a different protocol version with VERSION_MISMATCH', () => {
    const raw = JSON.stringify({ version: PROTOCOL_VERSION + 1, type: 'hello', roomId: null, payload: { role: 'guest', name: '客人' } });
    expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: 'VERSION_MISMATCH' });
    expect(parseServerMessage(raw)).toMatchObject({ ok: false, code: 'VERSION_MISMATCH' });
  });

  it('rejects unknown message types and malformed hello payloads', () => {
    const unknownType = parseClientMessage(
      JSON.stringify({ version: PROTOCOL_VERSION, type: 'teleport', roomId: null, payload: {} }),
    );
    const badRole = parseClientMessage(
      JSON.stringify({ version: PROTOCOL_VERSION, type: 'hello', roomId: null, payload: { role: 'admin', name: 'x' } }),
    );
    const badName = parseClientMessage(
      JSON.stringify({ version: PROTOCOL_VERSION, type: 'hello', roomId: null, payload: { role: 'guest', name: '' } }),
    );

    expect(unknownType).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(badRole).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(badName).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });

  it('validates member snapshots in server messages', () => {
    const broken = JSON.stringify({
      version: PROTOCOL_VERSION,
      type: 'members',
      roomId: 'room-1',
      payload: { members: [{ id: 'm', role: 'guest', name: '客人', connected: 'yes' }] },
    });
    expect(parseServerMessage(broken)).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });

    const ok = parseServerMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: 'members',
        roomId: 'room-1',
        payload: { members: [{ id: 'm', role: 'guest', name: '客人', connected: false }] },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.message.type === 'members') {
      expect(ok.message.payload.members).toEqual([{ id: 'm', role: 'guest', name: '客人', connected: false }]);
    }
  });

  it('round-trips server messages and preserves the room id', () => {
    const parsed = parseServerMessage(JSON.stringify(welcome('room-7', 'member-1')));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'welcome') {
      expect(parsed.message.roomId).toBe('room-7');
      expect(parsed.message.payload.memberId).toBe('member-1');
      expect(parsed.message.payload.members).toHaveLength(1);
    }
  });

  it('builds leave messages bound to a room id', () => {
    const parsed = parseClientMessage(encodeMessage(buildClientLeave('room-7')));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message).toMatchObject({ type: 'leave', roomId: 'room-7' });
    }
  });

  it('wraps server messages with the current protocol version', () => {
    const raw = buildServerMessage({
      type: 'room.closed',
      roomId: 'room-7',
      payload: { reason: 'host-closed' },
    });
    expect(JSON.parse(raw).version).toBe(PROTOCOL_VERSION);
  });
});

describe('lobby messages', () => {
  it('parses lobby requests with strict payload validation', () => {
    const settings = parseClientMessage(encodeMessage(buildClientLobbySettings('room-7', { sidePreference: 'host-red', timeControlId: 'blitz' })));
    expect(settings.ok).toBe(true);
    if (settings.ok && settings.message.type === 'lobby.settings') {
      expect(settings.message.roomId).toBe('room-7');
      expect(settings.message.payload).toEqual({ sidePreference: 'host-red', timeControlId: 'blitz' });
    }

    const ready = parseClientMessage(encodeMessage(buildClientLobbyReady('room-7', true, 3)));
    expect(ready.ok).toBe(true);
    if (ready.ok && ready.message.type === 'lobby.ready') {
      expect(ready.message.payload).toEqual({ ready: true, settingsVersion: 3 });
    }

    expect(
      parseClientMessage(
        JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.settings', roomId: 'room-7', payload: { sidePreference: 'purple', timeControlId: 'none' } }),
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(
      parseClientMessage(
        JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.ready', roomId: 'room-7', payload: { ready: true, settingsVersion: 0 } }),
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(
      parseClientMessage(
        JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.lock', roomId: 'room-7', payload: { locked: 'yes' } }),
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(
      parseClientMessage(JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.start', roomId: null, payload: {} })),
    ).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });

  it('requires the lobby snapshot in welcome and round-trips lobby.state', () => {
    const withoutLobby = JSON.stringify({
      version: PROTOCOL_VERSION,
      type: 'welcome',
      roomId: 'room-7',
      payload: { roomId: 'room-7', memberId: 'm-1', role: 'host', name: '房主', members: [] },
    });
    expect(parseServerMessage(withoutLobby)).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });

    const started = applyLobbyCommand(
      {
        phase: 'lobby',
        settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: false, settingsVersion: 2 },
        ready: { host: true, guest: true },
        presence: { host: true, guest: true },
        startParameters: null,
      },
      {
        type: 'start',
        actor: 'host',
        roomId: 'room-7',
        host: { memberId: 'host-1', name: '房主' },
        guest: { memberId: 'guest-1', name: '客人' },
        hostRedWhenRandom: null,
      },
    );
    if (!started.ok) {
      throw new Error('start fixture failed');
    }

    const parsed = parseServerMessage(JSON.stringify(welcome('room-7', 'host-1', started.state)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'welcome') {
      expect(parsed.message.payload.lobby).toEqual(started.state);
      expect(parsed.message.payload.lobby.startParameters).toMatchObject({
        timeControlId: 'standard',
        baseTimeSeconds: 1200,
        incrementSeconds: 60,
        redMemberId: 'host-1',
      });
    }

    const stateMessage = parseServerMessage(
      JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.state', roomId: 'room-7', payload: { lobby: started.state } }),
    );
    expect(stateMessage.ok).toBe(true);
    if (stateMessage.ok && stateMessage.message.type === 'lobby.state') {
      expect(stateMessage.message.payload.lobby.phase).toBe('started');
    }

    const brokenState = parseServerMessage(
      JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.state', roomId: 'room-7', payload: { lobby: { phase: 'lobby' } } }),
    );
    expect(brokenState).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });

  it('round-trips non-fatal lobby rejections', () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: 'lobby.rejected',
        roomId: 'room-7',
        payload: { code: 'NOT_READY', message: 'not-ready' },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === 'lobby.rejected') {
      expect(parsed.message.payload.code).toBe('NOT_READY');
    }

    const bad = parseServerMessage(
      JSON.stringify({ version: PROTOCOL_VERSION, type: 'lobby.rejected', roomId: 'room-7', payload: { code: 'NOPE', message: '' } }),
    );
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });
});

describe('error code and close code mapping', () => {
  it('maps every server error code to a distinct close code and back', () => {
    const codes = ['INVALID_MESSAGE', 'VERSION_MISMATCH', 'UNAUTHORIZED', 'ROOM_FULL', 'ROOM_CLOSED', 'HANDSHAKE_TIMEOUT', 'INTERNAL_ERROR'] as const;
    const seen = new Set<number>();

    for (const code of codes) {
      const closeCode = closeCodeForError(code);
      expect(closeCode).toBeGreaterThanOrEqual(4000);
      expect(seen.has(closeCode)).toBe(false);
      seen.add(closeCode);
      expect(serverErrorCodeForCloseCode(closeCode)).toBe(code);
    }

    expect(serverErrorCodeForCloseCode(1006)).toBeNull();
  });
});

describe('heartbeat and session resumption envelopes', () => {
  it('encodes and parses client and server ping/pong messages with seq numbers', () => {
    const clientPing = encodeMessage(buildPing('room-1', 42));
    const parsedClientPing = parseClientMessage(clientPing);
    expect(parsedClientPing.ok).toBe(true);
    if (parsedClientPing.ok) {
      expect(parsedClientPing.message.type).toBe('ping');
      expect(parsedClientPing.message.roomId).toBe('room-1');
      expect(parsedClientPing.message.payload).toEqual({ seq: 42 });
    }

    const serverPong = encodeMessage(buildPong('room-1', 42));
    const parsedServerPong = parseServerMessage(serverPong);
    expect(parsedServerPong.ok).toBe(true);
    if (parsedServerPong.ok) {
      expect(parsedServerPong.message.type).toBe('pong');
      expect(parsedServerPong.message.roomId).toBe('room-1');
      expect(parsedServerPong.message.payload).toEqual({ seq: 42 });
    }
  });

  it('rejects invalid ping/pong with missing or non-integer seq', () => {
    const badSeq = JSON.stringify({ version: PROTOCOL_VERSION, type: 'ping', roomId: 'r1', payload: { seq: -1 } });
    expect(parseClientMessage(badSeq)).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(parseServerMessage(badSeq)).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });

    const nonNumberSeq = JSON.stringify({ version: PROTOCOL_VERSION, type: 'pong', roomId: 'r1', payload: { seq: '1' } });
    expect(parseClientMessage(nonNumberSeq)).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(parseServerMessage(nonNumberSeq)).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });

  it('preserves resumeToken in hello and welcome payloads', () => {
    const hello = buildClientHello({ role: 'guest', name: '客人', roomId: 'room-1', resumeToken: 'token-abc' });
    const parsedHello = parseClientMessage(encodeMessage(hello));
    expect(parsedHello.ok).toBe(true);
    if (parsedHello.ok && parsedHello.message.type === 'hello') {
      expect(parsedHello.message.payload.resumeToken).toBe('token-abc');
      expect(parsedHello.message.roomId).toBe('room-1');
    }

    const welcomeMsg = buildServerMessage({
      type: 'welcome',
      roomId: 'room-1',
      payload: {
        roomId: 'room-1',
        memberId: 'guest-1',
        role: 'guest',
        name: '客人',
        members: [{ id: 'guest-1', role: 'guest', name: '客人', connected: true }],
        lobby: createLobbyState(),
        resumeToken: 'token-xyz',
      },
    });
    const parsedWelcome = parseServerMessage(welcomeMsg);
    expect(parsedWelcome.ok).toBe(true);
    if (parsedWelcome.ok && parsedWelcome.message.type === 'welcome') {
      expect(parsedWelcome.message.payload.resumeToken).toBe('token-xyz');
    }
  });

  it('encodes and parses game.action, game.state, game.rejected, and game.sync', () => {
    // game.action
    const clientAction = buildClientGameAction('room-1', {
      requestId: 'req-1',
      matchId: 'match-1',
      stepNumber: 0,
      action: { type: 'flip', position: { x: 4, y: 2 } },
    });
    const parsedAction = parseClientMessage(encodeMessage(clientAction));
    expect(parsedAction.ok).toBe(true);
    if (parsedAction.ok && parsedAction.message.type === 'game.action') {
      expect(parsedAction.message.requestId).toBe('req-1');
      expect(parsedAction.message.payload.matchId).toBe('match-1');
      expect(parsedAction.message.payload.stepNumber).toBe(0);
      expect(parsedAction.message.payload.action).toEqual({ type: 'flip', position: { x: 4, y: 2 } });
    }

    // game.sync
    const clientSync = buildClientGameSync('room-1', 'match-1', 'req-sync');
    const parsedSync = parseClientMessage(encodeMessage(clientSync));
    expect(parsedSync.ok).toBe(true);
    if (parsedSync.ok && parsedSync.message.type === 'game.sync') {
      expect(parsedSync.message.requestId).toBe('req-sync');
      expect(parsedSync.message.payload.matchId).toBe('match-1');
    }

    // game.state
    const serverState = buildServerMessage({
      type: 'game.state',
      roomId: 'room-1',
      requestId: 'req-1',
      payload: {
        matchId: 'match-1',
        seed: 12345,
        stepNumber: 1,
        state: {
          currentTurn: 'black',
          winner: null,
          checkedCamp: null,
          lastError: null,
          statusMessage: '黑方行动',
          pieces: [],
          actionHistory: [],
          recentAction: null,
        },
        actorMemberId: 'host-1',
        action: { type: 'flip', position: { x: 4, y: 2 } },
      },
    });
    const parsedState = parseServerMessage(serverState);
    expect(parsedState.ok).toBe(true);
    if (parsedState.ok && parsedState.message.type === 'game.state') {
      expect(parsedState.message.payload.matchId).toBe('match-1');
      expect(parsedState.message.payload.stepNumber).toBe(1);
      expect(parsedState.message.payload.actorMemberId).toBe('host-1');
    }

    // game.rejected
    const serverRejected = buildServerMessage({
      type: 'game.rejected',
      roomId: 'room-1',
      requestId: 'req-1',
      payload: {
        matchId: 'match-1',
        stepNumber: 0,
        reason: '非己方回合',
        state: {
          currentTurn: 'red',
          winner: null,
          checkedCamp: null,
          lastError: null,
          statusMessage: '红方行动',
          pieces: [],
          actionHistory: [],
          recentAction: null,
        },
      },
    });
    const parsedRejected = parseServerMessage(serverRejected);
    expect(parsedRejected.ok).toBe(true);
    if (parsedRejected.ok && parsedRejected.message.type === 'game.rejected') {
      expect(parsedRejected.message.payload.reason).toBe('非己方回合');
      expect(parsedRejected.message.payload.stepNumber).toBe(0);
    }
  });
});

