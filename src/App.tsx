import { useMemo, useRef, useState } from 'react';
import {
  applyAction,
  createInitialGameState,
  getPieceAt,
  listLegalMoves,
  restartGame,
  undoLastAction,
} from './game';
import type { GameHistoryConsequence, GameHistoryEndgameReason, GameState, Position } from './game';
import { Board } from './components/Board';
import { CapturedPieces } from './components/CapturedPieces';
import { MoveHistory, actionSummary, campLabel } from './components/MoveHistory';
import { GameControls } from './components/GameControls';
import { StatusPanel } from './components/StatusPanel';
import { useBoardFeedback } from './components/useBoardFeedback';
import type { LegalMoveHint } from './components/useBoardFeedback';
import { AudioControls } from './components/AudioControls';
import { useLocalGameAudio } from './components/useGameAudio';

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

function hasRevealedOpponentNonKingPieces(gameState: GameState): boolean {
  return gameState.pieces.some(
    (piece) =>
      !piece.captured &&
      piece.position !== null &&
      piece.revealed &&
      piece.camp !== gameState.currentTurn &&
      piece.type !== 'king',
  );
}

export default function App({ initialState }: AppProps) {
  const seedState = useMemo(() => initialState ?? createInitialGameState(), [initialState]);
  const [gameState, setGameState] = useState<GameState>(seedState);
  const [recentCompletedGames, setRecentCompletedGames] = useState<GameResultSummary[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [interactionMessage, setInteractionMessage] = useState<string | null>(null);
  const stepStartTimeRef = useRef<number>(Date.now());
  const feedback = useBoardFeedback(gameState);
  useLocalGameAudio(gameState);
  const displayState = feedback.displayState;
  const canUndo = gameState.undoStack.length > 0;
  const currentGameSummary = buildGameResultSummary(gameState);
  const displayedGameSummary = buildGameResultSummary(displayState);

  const legalMoves = useMemo(() => {
    const hints = new Map<string, LegalMoveHint>();

    if (gameState.winner || !selectedPosition) {
      return hints;
    }

    const piece = getPieceAt(gameState, selectedPosition);
    if (!piece || !piece.revealed || piece.captured || piece.camp !== gameState.currentTurn) {
      return hints;
    }

    for (const target of listLegalMoves(gameState, piece.id)) {
      const occupant = getPieceAt(gameState, target);
      hints.set(`${target.x}-${target.y}`, occupant ? 'capture' : 'empty');
    }

    return hints;
  }, [gameState, selectedPosition]);

  const handleCellClick = (position: Position) => {
    if (feedback.flip) {
      return;
    }

    const piece = getPieceAt(gameState, position);

    if (piece && !piece.revealed) {
      const durationSeconds = Math.max(1, Math.round((Date.now() - stepStartTimeRef.current) / 1000));
      stepStartTimeRef.current = Date.now();
      const nextState = applyAction(gameState, { type: 'flip', position }, { durationSeconds });
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
      if (hasRevealedOpponentNonKingPieces(gameState)) {
        setInteractionMessage('不能直接操作对方明子，请先选择己方明子');
      } else {
        setInteractionMessage('该格当前不可直接操作，请先选择己方明子或翻开暗子');
      }
      return;
    }

    if (selectedPosition) {
      const durationSeconds = Math.max(1, Math.round((Date.now() - stepStartTimeRef.current) / 1000));
      stepStartTimeRef.current = Date.now();
      const nextState = applyAction(gameState, { type: 'move', from: selectedPosition, to: position }, { durationSeconds });
      setInteractionMessage(null);
      setGameState(nextState);
      setSelectedPosition(null);
    }
  };

  const startNextGame = () => {
    if (currentGameSummary) {
      setRecentCompletedGames((current) => [currentGameSummary, ...current].slice(0, 3));
    }

    stepStartTimeRef.current = Date.now();
    setSelectedPosition(null);
    setInteractionMessage(null);
    setGameState(restartGame());
  };

  const handleRestart = () => {
    startNextGame();
  };

  const handleRematch = () => {
    startNextGame();
  };

  const handleUndo = () => {
    stepStartTimeRef.current = Date.now();
    setSelectedPosition(null);
    setInteractionMessage(null);
    setGameState((current) => undoLastAction(current));
  };

  return (
    <main className="app-shell">
      <header>
        <h1>翻牌中国象棋</h1>
        <p>本地双人对局：翻牌、走子、将军与终局结算。</p>
        <a className="menu-back-link" data-testid="back-to-menu" href="#/">
          ← 返回菜单
        </a>
      </header>

      <div className="layout">
        <Board
          captureGhost={feedback.captureGhost}
          checkPulse={feedback.checkPulse}
          flip={feedback.flip}
          gameState={displayState}
          legalMoves={legalMoves}
          onCellClick={handleCellClick}
          selectedPosition={selectedPosition}
          trace={feedback.trace}
        />
        <aside className="sidebar">
          <MoveHistory recentAction={displayState.recentAction} />
          <StatusPanel
            currentGameSummary={displayedGameSummary}
            gameState={displayState}
            interactionMessage={interactionMessage}
            recentCompletedGames={recentCompletedGames}
          />
          <CapturedPieces gameState={displayState} />
          <GameControls
            canUndo={canUndo}
            isGameOver={Boolean(gameState.winner)}
            onRematch={handleRematch}
            onRestart={handleRestart}
            onUndo={handleUndo}
          />
          <AudioControls />
        </aside>
      </div>
    </main>
  );
}
