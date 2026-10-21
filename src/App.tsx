import { useCallback, useMemo, useRef, useState } from 'react';
import {
  applyAction,
  cloneStateSnapshot,
  createInitialGameState,
  getPieceAt,
  listLegalMoves,
  restartGame,
  snapshotState,
  undoLastAction,
} from './game';
import type { GameHistoryConsequence, GameHistoryEndgameReason, GameState, GameStateSnapshot, Position } from './game';
import { Board } from './components/Board';
import { CapturedPieces } from './components/CapturedPieces';
import { MoveHistory, actionSummary, campLabel } from './components/MoveHistory';
import { GameControls } from './components/GameControls';
import { StatusPanel } from './components/StatusPanel';
import { useBoardFeedback } from './components/useBoardFeedback';
import type { LegalMoveHint } from './components/useBoardFeedback';
import { AudioControls } from './components/AudioControls';
import { useLocalGameAudio } from './components/useGameAudio';

import { createRecord } from './records/record';
import type { GameRecord } from './records/record';
import { GameRecordControls, RecordImporter, RecordReplay } from './components/GameRecordControls';

interface GameResultSummary {
  archiveLabel: string;
  reasonLabel: string;
  recentActionLabel: string;
  winnerLabel: string;
}

interface AppProps {
  initialState?: GameState;
  /** 明确的开局上下文（空历史开局帧）；注入进行中棋局时必须提供。 */
  opening?: GameStateSnapshot;
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

/** 开局上下文只认显式传入或全新的空历史棋局；进行中棋局不得用当前盘面猜测开局。 */
function resolveOpening(seedState: GameState, opening?: GameStateSnapshot): GameStateSnapshot {
  if (opening) {
    return cloneStateSnapshot(opening);
  }
  if (seedState.actionHistory.length > 0) {
    throw new Error('进行中棋局必须显式提供开局 initial，不能用当前盘面猜测开局');
  }
  return snapshotState(seedState);
}

export default function App({ initialState, opening }: AppProps) {
  const seedState = useMemo(() => initialState ?? createInitialGameState(), [initialState]);
  const [gameState, setGameState] = useState<GameState>(seedState);
  const [openingSnapshot, setOpeningSnapshot] = useState<GameStateSnapshot>(() => resolveOpening(seedState, opening));
  const gameStart = useRef(Date.now());
  const gameEnd = useRef<number | null>(seedState.winner ? Date.now() : null);
  const [replay, setReplay] = useState<GameRecord | null>(null);
  const closeReplay = useCallback(() => setReplay(null), []);
  const commitState = (next: GameState) => {
    if (next.winner && gameEnd.current === null) gameEnd.current = Date.now();
    if (!next.winner) gameEnd.current = null;
    setGameState(next);
  };
  const record = useMemo(() => gameState.winner ? createRecord(openingSnapshot, gameState,
    { mode: 'local', seats: { red: '本地红方', black: '本地黑方' } },
    { winner: gameState.winner, reason: gameState.recentAction?.consequences.find((c) => c.type === 'endgame')?.reason ?? 'checkmate',
      durationSeconds: Math.max(0, ((gameEnd.current ?? Date.now()) - gameStart.current) / 1000), timeBasis: 'elapsed' }) : null, [gameState, openingSnapshot]);
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
      commitState(nextState);
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
      commitState(nextState);
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
    const next = restartGame();
    gameStart.current = Date.now();
    gameEnd.current = null;
    setOpeningSnapshot(snapshotState(next));
    setGameState(next);
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
    commitState(undoLastAction(gameState));
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
            recordControls={record ? <GameRecordControls record={record} onReplay={setReplay} /> : undefined}
          />
          <CapturedPieces gameState={displayState} />
          <GameControls
            canUndo={canUndo}
            isGameOver={Boolean(gameState.winner)}
            onRematch={handleRematch}
            onRestart={handleRestart}
            onUndo={handleUndo}
          />
          <RecordImporter onReplay={setReplay} />
          <AudioControls />
        </aside>
      </div>
      <RecordReplay record={replay} onClose={closeReplay} />
    </main>
  );
}
