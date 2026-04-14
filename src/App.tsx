import { useMemo, useState } from 'react';
import { applyAction, createInitialGameState, getPieceAt, restartGame, undoLastAction } from './game';
import type { GameState, Position } from './game';
import { Board } from './components/Board';
import { CapturedPieces } from './components/CapturedPieces';
import { MoveHistory } from './components/MoveHistory';
import { GameControls } from './components/GameControls';
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
  const canUndo = gameState.undoStack.length > 0;

  const handleCellClick = (position: Position) => {
    const piece = getPieceAt(gameState, position);

    if (piece && !piece.revealed) {
      setSelectedPosition(null);
      setGameState((current) => applyAction(current, { type: 'flip', position }));
      return;
    }

    if (isOwnRevealedPiece(gameState, position)) {
      setSelectedPosition(position);
      return;
    }

    if (selectedPosition) {
      setGameState((current) => applyAction(current, { type: 'move', from: selectedPosition, to: position }));
      setSelectedPosition(null);
    }
  };

  const handleRestart = () => {
    setSelectedPosition(null);
    setGameState(restartGame());
  };

  const handleUndo = () => {
    setSelectedPosition(null);
    setGameState((current) => undoLastAction(current));
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
          <MoveHistory recentAction={gameState.recentAction} />
          <StatusPanel gameState={gameState} />
          <CapturedPieces gameState={gameState} />
          <GameControls canUndo={canUndo} onRestart={handleRestart} onUndo={handleUndo} />
        </aside>
      </div>
    </main>
  );
}
