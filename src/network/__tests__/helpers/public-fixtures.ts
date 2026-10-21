import { projectGameState, projectMatchSnapshot } from '../../../../server/public-view.js';
import type { MatchState } from '../../match.js';
import type { PublicGameState, PublicMatchSnapshot } from '../../public-game.js';
import type { ServerMessage } from '../../protocol.js';

type GameStatePayload = Extract<ServerMessage, { type: 'game.state' }>['payload'];

/** 测试用：把权威对局投影成真实下发的公开快照/公开局面。 */
export function publicSnapshotOf(match: MatchState, now?: number): PublicMatchSnapshot {
  return projectMatchSnapshot(match, now);
}

export function publicStateOf(match: MatchState): PublicGameState {
  return projectGameState(match);
}

/** 测试用：构造 game.state 的公开 payload（协议 v8 形状）。 */
export function publicGameStatePayload(
  snapshot: PublicMatchSnapshot,
  overrides: Partial<GameStatePayload> = {},
): GameStatePayload {
  return {
    matchId: snapshot.matchId,
    stepNumber: snapshot.stepNumber,
    revision: snapshot.revision,
    state: snapshot.gameState,
    startParameters: snapshot.startParameters,
    ...(snapshot.clock ? { clock: snapshot.clock } : {}),
    drawCooldownUntil: snapshot.drawCooldownUntil,
    phraseCooldownUntil: snapshot.phraseCooldownUntil,
    matchEvents: snapshot.matchEvents,
    ...overrides,
  };
}
