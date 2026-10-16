import { describe, expect, it } from 'vitest';
import {
  buildClientHello,
  buildClientLeave,
  buildServerMessage,
  closeCodeForError,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  serverErrorCodeForCloseCode,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../protocol';

function welcome(roomId: string, memberId: string): ServerMessage {
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
