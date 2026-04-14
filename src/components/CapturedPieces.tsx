import { PIECE_SYMBOLS } from '../game';
import type { Camp, GameState } from '../game';

interface CapturedPiecesProps {
  gameState: GameState;
}

function renderCamp(gameState: GameState, camp: Camp): string {
  return gameState.pieces
    .filter((piece) => piece.camp === camp && piece.captured)
    .map((piece) => PIECE_SYMBOLS[piece.camp][piece.type])
    .join(' ');
}

export function CapturedPieces({ gameState }: CapturedPiecesProps) {
  return (
    <section className="panel">
      <h2>吃子区</h2>
      <p>红方阵亡：{renderCamp(gameState, 'red') || '暂无'}</p>
      <p>黑方阵亡：{renderCamp(gameState, 'black') || '暂无'}</p>
    </section>
  );
}
