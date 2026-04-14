import { useMemo, useState } from 'react';
import { applyAction, createInitialGameState, getPieceAt, restartGame } from './game';
import type { GameState, Position } from './game';
import { Board } from './components/Board';
import { CapturedPieces } from './components/CapturedPieces';
import { StatusPanel } from './components/StatusPanel';

interface AppProps {
  initialState?: GameState;
}

function isOwnRevealedPiece(gameState: GameState, position: Position): boolean {
  const piece = getPieceAt(gameState, position);
  return Boolean(piece && piece.revealed && piece.camp === gameState.currentTurn);
}

export default function App({ initialState }: AppProps) {
  const seedState = useMemo(() => initialState ?? createInitialGameState(), [initialState]);
  const [gameState, setGameState] = useState<GameState>(seedState);
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [interactionMessage, setInteractionMessage] = useState<string | null>(null);

  const handleCellClick = (position: Position) => {
    const piece = getPieceAt(gameState, position);

    if (piece && !piece.revealed) {
      const nextState = applyAction(gameState, { type: 'flip', position });
      setSelectedPosition(null);
      setInteractionMessage(null);
      setGameState(nextState);
      return;
    }

    if (
      selectedPosition &&
      isOwnRevealedPiece(gameState, position) &&
      selectedPosition.x === position.x &&
      selectedPosition.y === position.y
    ) {
      setSelectedPosition(null);
      setInteractionMessage('已取消选中，请重新选择棋子或翻开暗子');
      return;
    }

    if (isOwnRevealedPiece(gameState, position)) {
      setSelectedPosition(position);
      setInteractionMessage(null);
      return;
    }

    if (!selectedPosition && !piece) {
      setInteractionMessage('该格当前不可直接操作，请先选择己方明子或翻开暗子');
      return;
    }

    if (!selectedPosition && piece) {
      setInteractionMessage('不能直接操作对方明子，请先选择己方明子');
      return;
    }

    if (selectedPosition) {
      const nextState = applyAction(gameState, { type: 'move', from: selectedPosition, to: position });
      setInteractionMessage(null);
      setGameState(nextState);
      setSelectedPosition(null);
    }
  };

  const handleRestart = () => {
    setSelectedPosition(null);
    setInteractionMessage(null);
    setGameState(restartGame());
  };

  return (
    <main className="app-shell">
      <header>
        <h1>翻牌中国象棋</h1>
        <p>本地双人 MVP：翻牌、走子、将军与终局结算。</p>
      </header>

      <div className="layout">
        <Board gameState={gameState} selectedPosition={selectedPosition} onCellClick={handleCellClick} />
        <aside className="sidebar">
          <StatusPanel gameState={gameState} interactionMessage={interactionMessage} />
          <CapturedPieces gameState={gameState} />
          <section className="panel">
            <h2>操作</h2>
            <button onClick={handleRestart} type="button">
              重新开局
            </button>
          </section>
        </aside>
      </div>
    </main>
  );
}
