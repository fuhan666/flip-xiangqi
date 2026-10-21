import { describe, expect, it } from 'vitest';
import {
  createEmptyPublicGameState,
  parsePublicGameState,
  parsePublicMatchSnapshot,
  parsePublicPiece,
} from '../public-game';
import { buildStartParameters } from '../lobby';

const baseState = () => ({
  pieces: [
    { id: 'a', position: { x: 4, y: 9 }, revealed: true, camp: 'red', type: 'king', captured: false },
    { id: 'b', position: { x: 0, y: 0 }, revealed: false },
  ],
  currentTurn: 'red',
  winner: null,
  checkedCamp: null,
  lastError: null,
  statusMessage: '红方先行',
  actionHistory: [],
  recentAction: null,
  legalMoves: [
    { pieceId: 'a', from: { x: 4, y: 9 }, targets: [{ position: { x: 4, y: 8 }, kind: 'empty' }] },
  ],
});

describe('公开棋子校验', () => {
  it('接受暗子（仅 id/position/revealed）与已明子（含完整身份）', () => {
    expect(parsePublicPiece({ id: 'p1', position: { x: 1, y: 2 }, revealed: false })).toEqual({
      id: 'p1',
      position: { x: 1, y: 2 },
      revealed: false,
    });
    expect(
      parsePublicPiece({ id: 'p2', position: null, revealed: true, camp: 'black', type: 'rook', captured: true }),
    ).toEqual({ id: 'p2', position: null, revealed: true, camp: 'black', type: 'rook', captured: true });
  });

  it('拒绝携带阵营/棋种的暗子，以及缺字段的明子', () => {
    expect(parsePublicPiece({ id: 'p1', position: { x: 1, y: 2 }, revealed: false, camp: 'red' })).toBeNull();
    expect(
      parsePublicPiece({ id: 'p1', position: { x: 1, y: 2 }, revealed: false, type: 'rook' }),
    ).toBeNull();
    expect(parsePublicPiece({ id: 'p1', position: { x: 1, y: 2 }, revealed: false, captured: false })).toBeNull();
    expect(parsePublicPiece({ id: 'p2', position: { x: 1, y: 2 }, revealed: true, camp: 'red' })).toBeNull();
    expect(
      parsePublicPiece({ id: 'p2', position: { x: 1, y: 2 }, revealed: true, camp: 'red', type: 'dragon', captured: false }),
    ).toBeNull();
    // 已吃明子必须 position 为 null
    expect(
      parsePublicPiece({ id: 'p2', position: { x: 1, y: 2 }, revealed: true, camp: 'red', type: 'rook', captured: true }),
    ).toBeNull();
  });
});

describe('公开局面校验', () => {
  it('接受完整公开局面', () => {
    const parsed = parsePublicGameState(baseState());
    expect(parsed).not.toBeNull();
    expect(parsed!.pieces).toHaveLength(2);
    expect(parsed!.legalMoves).toHaveLength(1);
  });

  it('拒绝重复占位、非法阵营与非法落点类型', () => {
    const duplicate = baseState();
    duplicate.pieces[1].position = { x: 4, y: 9 };
    expect(parsePublicGameState(duplicate)).toBeNull();

    const badCamp = { ...baseState(), currentTurn: 'green' };
    expect(parsePublicGameState(badCamp)).toBeNull();

    const badTarget = baseState();
    badTarget.legalMoves[0].targets[0].kind = 'unknown';
    expect(parsePublicGameState(badTarget)).toBeNull();
  });

  it('拒绝未知字段的暗子（保密字段不能借额外键混入）', () => {
    const leaked = baseState();
    (leaked.pieces[1] as Record<string, unknown>).camp = 'black';
    expect(parsePublicGameState(leaked)).toBeNull();
  });

  it('无对局时使用统一的空公开局面', () => {
    const empty = createEmptyPublicGameState();
    expect(parsePublicGameState(empty)).not.toBeNull();
    expect(empty.pieces).toHaveLength(0);
    expect(empty.legalMoves).toHaveLength(0);
  });
});

describe('公开对局快照校验', () => {
  const startParameters = buildStartParameters({
    roomId: 'room-1',
    host: { memberId: 'host-1', name: '房主' },
    guest: { memberId: 'guest-1', name: '客人' },
    settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
    hostSide: 'red',
  });

  it('接受公开快照并拒绝缺失 revision', () => {
    const snapshot = {
      matchId: 'm1',
      stepNumber: 0,
      revision: 0,
      startParameters,
      gameState: baseState(),
      clock: null,
      settlement: null,
      pendingNegotiation: null,
      drawCooldownUntil: {},
      phraseCooldownUntil: {},
      negotiationEvent: null,
      matchEvents: [],
    };
    expect(parsePublicMatchSnapshot(snapshot)).not.toBeNull();
    expect(parsePublicMatchSnapshot({ ...snapshot, revision: undefined })).toBeNull();
    expect(parsePublicMatchSnapshot({ ...snapshot, matchId: '' })).toBeNull();
    expect(parsePublicMatchSnapshot({ ...snapshot, gameState: { ...baseState(), pieces: [] } })).not.toBeNull();
  });

  it('公开快照不带 seed / initial 概念，出现也只会被忽略而非解析', () => {
    const snapshot = {
      matchId: 'm1',
      stepNumber: 0,
      revision: 0,
      startParameters,
      gameState: baseState(),
      clock: null,
      settlement: null,
      pendingNegotiation: null,
      drawCooldownUntil: {},
      phraseCooldownUntil: {},
      negotiationEvent: null,
      matchEvents: [],
      seed: 42,
      initial: { pieces: [] },
    };
    const parsed = parsePublicMatchSnapshot(snapshot);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('seed');
    expect(parsed).not.toHaveProperty('initial');
  });
});
