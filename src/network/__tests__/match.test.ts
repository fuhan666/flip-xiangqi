import { describe, expect, it } from 'vitest';
import {
  applyMatchAction,
  createMatch,
  createSeededRng,
  parseGameStateSnapshot,
  parseMatchAction,
  parseMatchSnapshot,
  parsePiece,
  snapshotMatch,
} from '../match.js';
import { buildStartParameters } from '../lobby.js';
import { getPieceAt } from '../../game/index.js';

describe('match engine and deterministic RNG', () => {
  it('deterministic LCG produces identical random sequence for same seed', () => {
    const rng1 = createSeededRng(123456);
    const rng2 = createSeededRng(123456);

    const values1 = Array.from({ length: 20 }, () => rng1());
    const values2 = Array.from({ length: 20 }, () => rng2());

    expect(values1).toEqual(values2);
    expect(values1.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('different seeds produce different piece distributions', () => {
    const startParameters = buildStartParameters({
      roomId: 'room1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });

    const matchA = createMatch({ matchId: 'm1', seed: 42, startParameters });
    const matchB = createMatch({ matchId: 'm2', seed: 99999, startParameters });

    // 初始明置两将帅位置固定
    const hostKingA = getPieceAt(matchA.gameState, { x: 4, y: 9 });
    const hostKingB = getPieceAt(matchB.gameState, { x: 4, y: 9 });
    expect(hostKingA?.id).toBe('red-king');
    expect(hostKingB?.id).toBe('red-king');

    // 暗子身份分布不同
    const piecesA = matchA.gameState.pieces.filter((p) => !p.revealed).map((p) => `${p.id}@${p.position?.x},${p.position?.y}`);
    const piecesB = matchB.gameState.pieces.filter((p) => !p.revealed).map((p) => `${p.id}@${p.position?.x},${p.position?.y}`);
    expect(piecesA).not.toEqual(piecesB);
  });

  it('initializes match with stepNumber 0 and identical layout for same seed', () => {
    const startParameters = buildStartParameters({
      roomId: 'room1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });

    const match1 = createMatch({ matchId: 'm1', seed: 1001, startParameters });
    const match2 = createMatch({ matchId: 'm2', seed: 1001, startParameters });

    expect(match1.stepNumber).toBe(0);
    expect(match1.gameState.pieces).toEqual(match2.gameState.pieces);

    const snapshot = snapshotMatch(match1);
    expect(snapshot.matchId).toBe('m1');
    expect(snapshot.seed).toBe(1001);
    expect(snapshot.stepNumber).toBe(0);
  });

  it('enforces turn arbitration based on startParameters', () => {
    const startParameters = buildStartParameters({
      roomId: 'room1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });

    // 红方先手（host-1），guest-1 不能在红方回合行动
    const match = createMatch({ matchId: 'm1', seed: 1001, startParameters });
    expect(match.gameState.currentTurn).toBe('red');

    // 找到一个暗子位置
    const hiddenPiece = match.gameState.pieces.find((p) => !p.revealed && p.position !== null)!;
    const flipAction = { type: 'flip' as const, position: hiddenPiece.position! };

    // 客人尝试在红方回合行动 -> 拒绝
    const rejectResult = applyMatchAction(match, 'guest-1', flipAction);
    expect(rejectResult.ok).toBe(false);
    if (!rejectResult.ok) {
      expect(rejectResult.reason).toContain('非己方回合');
    }

    // 房主在红方回合翻牌 -> 成功
    const acceptResult = applyMatchAction(match, 'host-1', flipAction);
    expect(acceptResult.ok).toBe(true);
    if (acceptResult.ok) {
      expect(acceptResult.match.stepNumber).toBe(1);
      expect(acceptResult.match.gameState.currentTurn).toBe('black');
    }
  });

  it('parses valid match actions and rejects malformed inputs', () => {
    expect(parseMatchAction({ type: 'flip', position: { x: 0, y: 0 } })).toEqual({
      type: 'flip',
      position: { x: 0, y: 0 },
    });

    expect(parseMatchAction({ type: 'move', from: { x: 1, y: 2 }, to: { x: 1, y: 3 } })).toEqual({
      type: 'move',
      from: { x: 1, y: 2 },
      to: { x: 1, y: 3 },
    });

    // 越界坐标
    expect(parseMatchAction({ type: 'flip', position: { x: 9, y: 0 } })).toBeNull();
    expect(parseMatchAction({ type: 'flip', position: { x: 0, y: 10 } })).toBeNull();
    expect(parseMatchAction({ type: 'move', from: { x: -1, y: 0 }, to: { x: 0, y: 0 } })).toBeNull();
    expect(parseMatchAction({ type: 'unknown' })).toBeNull();
  });

  it('validates pieces, coordinates, and snapshot boundaries', () => {
    const validPiece = {
      id: 'p1',
      camp: 'red',
      type: 'pawn',
      position: { x: 0, y: 6 },
      revealed: false,
      captured: false,
    };

    // Captured piece with non-null position is rejected
    const invalidCaptured = {
      ...validPiece,
      captured: true,
      position: { x: 0, y: 6 },
    };

    // Overlapping uncaptured pieces on same coordinate rejected
    const overlapping = [
      validPiece,
      { ...validPiece, id: 'p2' },
    ];

    const validHistoryEntry = {
      turnNumber: 1,
      actor: 'red',
      action: { type: 'flip', position: { x: 0, y: 6 } },
      consequences: [],
      nextTurn: 'black',
      checkedCamp: null,
      winner: null,
      statusMessage: '红方翻开',
    };

    const validSnapshot = {
      pieces: [validPiece],
      currentTurn: 'red',
      winner: null,
      checkedCamp: null,
      lastError: null,
      statusMessage: '进行中',
      actionHistory: [validHistoryEntry],
    };

    // Malformed seed / stepNumber in match snapshot
    const startParameters = buildStartParameters({
      roomId: 'room1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });

    const matchSnap = {
      matchId: 'm1',
      seed: 42,
      stepNumber: 0,
      startParameters,
      gameState: validSnapshot,
    };

    expect(parsePiece(validPiece)).toEqual(validPiece);
    expect(parsePiece(invalidCaptured)).toBeNull();
    expect(parsePiece({ ...validPiece, type: 'invalid-type' })).toBeNull();
    expect(parsePiece({ ...validPiece, position: { x: 10, y: 0 } })).toBeNull();

    expect(parseGameStateSnapshot(validSnapshot)).not.toBeNull();
    expect(parseGameStateSnapshot({ ...validSnapshot, pieces: overlapping })).toBeNull();
    expect(parseGameStateSnapshot({ ...validSnapshot, currentTurn: 'invalid' })).toBeNull();

    expect(parseMatchSnapshot(matchSnap)).not.toBeNull();
    expect(parseMatchSnapshot({ ...matchSnap, seed: -1 })).toBeNull();
    expect(parseMatchSnapshot({ ...matchSnap, seed: 0x100000000 })).toBeNull();
    expect(parseMatchSnapshot({ ...matchSnap, stepNumber: -1 })).toBeNull();
    expect(parseMatchSnapshot({ ...matchSnap, stepNumber: 1.5 })).toBeNull();
    expect(parseMatchSnapshot({ ...matchSnap, stepNumber: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });
});
