import { applyAction, createInitialGameState, undoLastAction } from '../../game';
import type { GameAction } from '../../game';
import { createSeededRng } from '../../network/match';

const flip = (x: number, y: number): GameAction => ({ type: 'flip', position: { x, y } });
const move = (x: number, y: number, tx: number, ty: number): GameAction => ({ type: 'move', from: { x, y }, to: { x: tx, y: ty } });
export const actions = [flip(7,2), flip(2,3), move(7,2,5,2), flip(1,0), flip(7,7), flip(7,0), move(7,7,7,4), flip(8,0), move(7,4,2,4), flip(0,0), move(2,4,2,3), flip(8,6), move(2,3,2,4), flip(0,3), move(2,4,6,4), flip(2,9), flip(3,9), flip(4,6), move(3,9,3,5), flip(6,3), move(3,5,6,5), flip(2,6), move(6,5,6,3), flip(8,9), move(5,2,4,2)];
export function playedGame() {
  const initial = createInitialGameState(createSeededRng(2));
  const frames = [initial];
  let state = initial;
  for (const action of actions) {
    state = applyAction(state, action);
    frames.push(state);
  }
  // Undo the finish and play it again, retaining only the valid main line.
  const final = applyAction(undoLastAction(state), actions[24]);
  return { initial, final, frames };
}
