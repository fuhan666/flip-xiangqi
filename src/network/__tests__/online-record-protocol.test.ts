import { describe, expect, it } from 'vitest';
import {
  buildClientGameRecordRequest,
  buildServerGameRecord,
  buildServerGameRecordUnavailable,
  buildServerGameRecords,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
} from '../protocol';

describe('v10 终局棋谱消息', () => {
  it('请求带必填 matchId 与 requestId，版本统一为 v10', () => {
    const parsed = parseClientMessage(encodeMessage(buildClientGameRecordRequest('room-1', { requestId: 'r1', matchId: 'm1' })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message).toMatchObject({ version: PROTOCOL_VERSION, type: 'game.record.request', roomId: 'room-1', requestId: 'r1', payload: { matchId: 'm1' } });
  });

  it.each([
    [{ version: PROTOCOL_VERSION, type: 'game.record.request', roomId: 'room-1', payload: { matchId: 'm1' } }, 'game-record-request-id'],
    [{ version: PROTOCOL_VERSION, type: 'game.record.request', requestId: 'r1', roomId: 'room-1', payload: {} }, 'game-record-match-id'],
    [{ version: PROTOCOL_VERSION, type: 'game.record.request', requestId: 'r1', roomId: '', payload: { matchId: 'm1' } }, 'game-record-room-id'],
  ])('拒绝缺少关联标识的请求', (raw, detail) => {
    const parsed = parseClientMessage(JSON.stringify(raw));
    expect(parsed).toMatchObject({ ok: false, code: 'INVALID_MESSAGE', detail });
  });

  it('完整棋谱与不可用响应可往返校验', () => {
    const record = parseServerMessage(encodeMessage(buildServerGameRecord('room-1', {
      requestId: 'r1', matchId: 'm1', expiresAt: 123, json: '{}', text: 'text',
    })));
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.message).toMatchObject({ type: 'game.record', payload: { matchId: 'm1', expiresAt: 123, json: '{}', text: 'text' } });
    }

    const unavailable = parseServerMessage(encodeMessage(buildServerGameRecordUnavailable('room-1', {
      requestId: 'r2', matchId: 'm1', code: 'UNAVAILABLE', message: '棋谱不存在或已过期',
    })));
    expect(unavailable.ok).toBe(true);

    const summary = parseServerMessage(encodeMessage(buildServerGameRecords('room-1', {
      records: [{ matchId: 'm1', endedAt: 100, expiresAt: 200 }],
    })));
    expect(summary.ok).toBe(true);
  });

  it.each([
    [{ requestId: 'r', matchId: 'm', expiresAt: 1, json: '{}' }, 'game-record-body'],
    [{ requestId: 'r', matchId: 'm', expiresAt: -1, json: '{}', text: '' }, 'game-record-expires-at'],
  ])('拒绝字段缺失或非法的棋谱响应', (payload, detail) => {
    const parsed = parseServerMessage(JSON.stringify({ version: PROTOCOL_VERSION, type: 'game.record', roomId: 'room-1', ...payload, payload }));
    expect(parsed).toMatchObject({ ok: false, code: 'INVALID_MESSAGE', detail });
  });

  it('拒绝未知的不可用原因与超长摘要列表', () => {
    expect(parseServerMessage(JSON.stringify({
      version: PROTOCOL_VERSION, type: 'game.record.unavailable', requestId: 'r', roomId: 'room-1',
      payload: { matchId: 'm', code: 'LEAK', message: 'x' },
    }))).toMatchObject({ ok: false, detail: 'game-record-unavailable-code' });
    expect(parseServerMessage(JSON.stringify({
      version: PROTOCOL_VERSION, type: 'game.records', roomId: 'room-1',
      payload: { records: Array.from({ length: 201 }, (_, i) => ({ matchId: `m${i}`, endedAt: 1, expiresAt: 2 })) },
    }))).toMatchObject({ ok: false, detail: 'game-records-list' });
  });
});
