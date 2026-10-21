import { describe, expect, it } from 'vitest';
import {
  applyPublicGameDelta,
  comparePublicPieces,
  diffPublicSnapshot,
  parsePublicGameDelta,
  parsePublicGamePatch,
} from '../public-patch';
import { parsePublicMatchSnapshot } from '../public-game';
import { publicSnapshotOf } from './helpers/public-fixtures';
import { createMatch, undoMatchAction, applyMatchAction, finalizeMatch } from '../match';
import { buildStartParameters } from '../lobby';

function snapshot() {
  const startParameters = buildStartParameters({
    roomId: 'room',
    host: { memberId: 'host', name: '红方' },
    guest: { memberId: 'guest', name: '黑方' },
    settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
    hostSide: 'red',
  });
  return publicSnapshotOf(createMatch({ matchId: 'match', seed: 42, startParameters }));
}

describe('公开增量补丁格式', () => {
  it('接受完整补丁，拒绝未知字段、越界数组与倒序版本', () => {
    const patch = {
      matchId: 'm-1',
      baseRevision: 3,
      revision: 4,
      stepNumber: 1,
      changes: { currentTurn: 'black' },
    };
    expect(parsePublicGamePatch(patch)).not.toBeNull();
    expect(parsePublicGamePatch({ ...patch, baseRevision: 4 })).toBeNull();
    expect(parsePublicGamePatch({ ...patch, revision: 2 })).toBeNull();
    expect(parsePublicGamePatch({ ...patch, changes: { currentTurn: 'blue' } })).toBeNull();
    expect(parsePublicGamePatch({ ...patch, changes: { seed: 42 } })).toBeNull();
    expect(parsePublicGamePatch({ ...patch, changes: { history: { baseLength: 1, keep: 2, append: [] } } })).toBeNull();
    expect(parsePublicGamePatch({ ...patch, changes: { pieces: [{ id: 'p', position: { x: 0, y: 0 }, revealed: false, camp: 'red' }] } })).toBeNull();
    expect(parsePublicGamePatch({ ...patch, changes: { settlement: null, pendingNegotiation: null } })).not.toBeNull();
  });

  it('暗子差异不能夹带身份字段，明子必须完整', () => {
    expect(parsePublicGameDelta(undefined)).toBeNull();
    expect(parsePublicGameDelta({ pieces: [{ id: 'p-1', position: { x: 1, y: 1 }, revealed: false }] })).not.toBeNull();
    expect(parsePublicGameDelta({ pieces: [{ id: 'p-1', position: null, revealed: true, camp: 'red', type: 'rook', captured: true }] })).not.toBeNull();
    expect(parsePublicGameDelta({ pieces: [{ id: 'p-1', position: null, revealed: true, camp: 'red' }] })).toBeNull();
  });
});

describe('公开增量补丁求差与应用', () => {
  it('走子、翻牌、吃子与悔棋后的补丁应用结果与权威投影逐项一致', () => {
    const match = createMatch({
      matchId: 'match',
      seed: 42,
      startParameters: buildStartParameters({
        roomId: 'room',
        host: { memberId: 'host', name: '红方' },
        guest: { memberId: 'guest', name: '黑方' },
        settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
        hostSide: 'red',
      }),
    });

    let previous = publicSnapshotOf(match);
    let view = previous.gameState;
    let events = previous.matchEvents;
    let step = 0;

    const sync = (next: typeof previous) => {
      const delta = diffPublicSnapshot(previous, next);
      const applied = applyPublicGameDelta(view, events, delta);
      expect(applied.ok, applied.ok ? '' : applied.reason).toBe(true);
      if (!applied.ok) {
        return;
      }
      view = applied.gameState;
      events = applied.matchEvents;
      previous = next;
      step += 1;
      // 应用后的每一步都必须与同一时点的权威公开投影完全一致。
      expect(view).toEqual(next.gameState);
      expect(events).toEqual(next.matchEvents);
      expect(view.pieces.map((piece) => piece.id)).toEqual(
        [...view.pieces].sort(comparePublicPieces).map((piece) => piece.id),
      );
    };

    const hidden = () => match.gameState.pieces.find((piece) => !piece.revealed && piece.position)!;

    for (let i = 0; i < 6; i += 1) {
      const piece = hidden();
      const result = applyMatchAction(match, match.gameState.currentTurn === 'red' ? 'host' : 'guest', {
        type: 'flip',
        position: piece.position!,
      });
      expect(result.ok).toBe(true);
      Object.assign(match, result.ok ? result.match : match);
      sync(publicSnapshotOf(match));
    }

    // 悔棋：步数下降，但修订仍然前进。
    const revisionBeforeUndo = match.revision;
    const undone = undoMatchAction(match);
    expect(undone.ok).toBe(true);
    if (undone.ok) {
      Object.assign(match, undone.match);
    }
    const afterUndo = publicSnapshotOf(match);
    expect(afterUndo.revision).toBeGreaterThan(revisionBeforeUndo);
    expect(afterUndo.stepNumber).toBeLessThan(previous.stepNumber);
    sync(afterUndo);

    // 终局同样只靠差异收敛。
    const ended = finalizeMatch(match, 'red', 'resignation');
    Object.assign(match, ended);
    sync(publicSnapshotOf(match));
    expect(view.winner).toBe('red');
    expect(step).toBe(8);
  });

  it('拒绝不衔接的历史前缀、未知棋子，且失败不产生半份状态', () => {
    const snap = snapshot();
    const applied = applyPublicGameDelta(snap.gameState, snap.matchEvents, {
      history: { baseLength: snap.gameState.actionHistory.length + 1, keep: 0, append: [] },
    });
    expect(applied.ok).toBe(false);

    const unknown = applyPublicGameDelta(snap.gameState, snap.matchEvents, {
      pieces: [{ id: 'not-in-this-match', position: { x: 0, y: 0 }, revealed: false }],
    });
    expect(unknown.ok).toBe(false);

    const overlap = applyPublicGameDelta(snap.gameState, snap.matchEvents, {
      pieces: [
        { ...snap.gameState.pieces[0], id: snap.gameState.pieces[0].id },
        { ...snap.gameState.pieces[1], id: snap.gameState.pieces[1].id, position: { ...snap.gameState.pieces[0].position! } },
      ],
    });
    expect(overlap.ok).toBe(false);
  });

  it('重复与更旧快照求差为空，不会伪造变化', () => {
    const snap = snapshot();
    expect(diffPublicSnapshot(snap, snap)).toEqual({});
    expect(parsePublicMatchSnapshot(snap)).not.toBeNull();
  });
});
