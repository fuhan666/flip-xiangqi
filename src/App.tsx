import { useMemo, useState } from 'react';
import { applyAction, createInitialGameState, getPieceAt, restartGame, undoLastAction } from './game';
import type { GameHistoryConsequence, GameHistoryEndgameReason, GameState, Position } from './game';
import { Board } from './components/Board';
import { CapturedPieces } from './components/CapturedPieces';
import { MoveHistory, actionSummary, campLabel } from './components/MoveHistory';
import { GameControls } from './components/GameControls';
import { StatusPanel } from './components/StatusPanel';

interface GameResultSummary {
  archiveLabel: string;
  reasonLabel: string;
  recentActionLabel: string;
  winnerLabel: string;
}

interface AppProps {
  initialState?: GameState;
}

function isEndgameConsequence(
  consequence: GameHistoryConsequence,
): consequence is Extract<GameHistoryConsequence, { type: 'endgame' }> {
  return consequence.type === 'endgame';
}

function endgameReasonLabel(reason: GameHistoryEndgameReason | null): string {
  if (reason === 'checkmate') {
    return '将死获胜';
  }

  if (reason === 'king-captured') {
    return '吃掉对方将/帅获胜';
  }

  return '终局获胜';
}

function buildGameResultSummary(gameState: GameState): GameResultSummary | null {
  if (!gameState.winner) {
    return null;
  }

  const endgameConsequence = gameState.recentAction?.consequences.find(isEndgameConsequence) ?? null;
  const reasonLabel = endgameReasonLabel(endgameConsequence?.reason ?? null);
  const winnerLabel = `${campLabel(gameState.winner)}获胜`;
  const recentActionLabel = gameState.recentAction ? actionSummary(gameState.recentAction) : gameState.statusMessage;

  return {
    archiveLabel: `${winnerLabel}（${reasonLabel}）`,
    reasonLabel,
    recentActionLabel,
    winnerLabel,
  };
}

function isOwnRevealedPiece(gameState: GameState, position: Position): boolean {
  const piece = getPieceAt(gameState, position);
  return Boolean(piece && piece.revealed && piece.camp === gameState.currentTurn);
}

export default function App({ initialState }: AppProps) {
  const seedState = useMemo(() => initialState ?? createInitialGameState(), [initialState]);
  const [gameState, setGameState] = useState<GameState>(seedState);
  const [recentCompletedGames, setRecentCompletedGames] = useState<GameResultSummary[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const canUndo = gameState.undoStack.length > 0;
  const currentGameSummary = buildGameResultSummary(gameState);

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

  const startNextGame = () => {
    if (currentGameSummary) {
      setRecentCompletedGames((current) => [currentGameSummary, ...current].slice(0, 3));
    }

    setSelectedPosition(null);
    setGameState(restartGame());
  };

  const handleRestart = () => {
    startNextGame();
  };

  const handleRematch = () => {
    startNextGame();
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
          <StatusPanel
            currentGameSummary={currentGameSummary}
            gameState={gameState}
            recentCompletedGames={recentCompletedGames}
          />
          <CapturedPieces gameState={gameState} />
          <GameControls
            canUndo={canUndo}
            isGameOver={Boolean(gameState.winner)}
            onRematch={handleRematch}
            onRestart={handleRestart}
            onUndo={handleUndo}
          />
        </aside>
      </div>
    </main>
  );
}
