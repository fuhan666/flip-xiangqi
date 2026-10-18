import { useEffect, useMemo, useState } from 'react';
import type { Camp, GameHistoryConsequence, GameHistoryEndgameReason, GameState, Position } from '../game/types.js';
import { getPieceAt, listLegalMoves, restoreState } from '../game/index.js';
import type { ConnectionState, RoomConnection } from '../network/client.js';
import { findTimeControl } from '../network/lobby.js';
import { Board } from './Board.js';
import { CapturedPieces } from './CapturedPieces.js';
import { MoveHistory, actionSummary, campLabel } from './MoveHistory.js';
import { StatusPanel } from './StatusPanel.js';
import type { LegalMoveHint } from './useBoardFeedback.js';
import { useOnlineBoardFeedback } from './useOnlineBoardFeedback.js';

interface GameResultSummary {
  archiveLabel: string;
  reasonLabel: string;
  recentActionLabel: string;
  winnerLabel: string;
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

export interface OnlineGameProps {
  client: RoomConnection;
  connection: ConnectionState;
  onExit: () => void;
}

export function OnlineGame({ client, connection, onExit }: OnlineGameProps) {
  const game = connection.game;
  const lobby = connection.lobby;
  const viewerRole = connection.role;

  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [interactionMessage, setInteractionMessage] = useState<string | null>(null);
  const [shuffling, setShuffling] = useState(true);

  // 首次开局短暂展示 ≤0.5 秒「洗牌中…」
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShuffling(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, []);

  // 发生回滚拒绝时清空本地可能残留的选中态
  useEffect(() => {
    if (game?.statusNotice) {
      setSelectedPosition(null);
    }
  }, [game?.statusNotice]);

  if (!game || !lobby) {
    return (
      <section className="room-panel" data-testid="online-game-loading">
        <p className="room-hint">正在加载联机对局状态…</p>
      </section>
    );
  }

  const startParameters = game.startParameters;
  const mySide: Camp = connection.memberId === startParameters.redMemberId ? 'red' : 'black';
  const opponentSide: Camp = mySide === 'red' ? 'black' : 'red';

  const rawGameState: GameState = useMemo(
    () => restoreState(game.displayState, []),
    [game.displayState],
  );

  const feedback = useOnlineBoardFeedback(rawGameState, game.lastAcceptedAction);
  const displayState = feedback.displayState;

  const isMyTurn = displayState.winner === null && displayState.currentTurn === mySide;
  const isBusy = game.pendingAction !== null || connection.reconnecting;

  const legalMoves = useMemo(() => {
    const hints = new Map<string, LegalMoveHint>();

    if (displayState.winner || !selectedPosition || !isMyTurn) {
      return hints;
    }

    const piece = getPieceAt(displayState, selectedPosition);
    if (!piece || !piece.revealed || piece.captured || piece.camp !== mySide) {
      return hints;
    }

    for (const target of listLegalMoves(displayState, piece.id)) {
      const occupant = getPieceAt(displayState, target);
      hints.set(`${target.x}-${target.y}`, occupant ? 'capture' : 'empty');
    }

    return hints;
  }, [displayState, selectedPosition, isMyTurn, mySide]);

  const handleCellClick = (position: Position) => {
    if (feedback.flip) {
      return;
    }

    if (displayState.winner !== null) {
      return;
    }

    if (connection.reconnecting) {
      setInteractionMessage('网络重连中，暂无法操作');
      return;
    }

    if (game.pendingAction !== null) {
      setInteractionMessage('上一操作处理中，请稍候');
      return;
    }

    const piece = getPieceAt(displayState, position);

    // 1. 点击暗子 -> 翻牌
    if (piece && !piece.revealed) {
      if (!isMyTurn) {
        setInteractionMessage('当前非己方回合，请等待对方行动');
        return;
      }
      const res = client.sendGameAction({ type: 'flip', position });
      if (!res.ok) {
        setInteractionMessage(res.reason ?? '无法翻开该棋子');
      } else {
        setSelectedPosition(null);
        setInteractionMessage(null);
      }
      return;
    }

    // 2. 点击已选中的己方棋子 -> 取消选中
    if (
      selectedPosition &&
      piece &&
      piece.revealed &&
      piece.camp === mySide &&
      selectedPosition.x === position.x &&
      selectedPosition.y === position.y
    ) {
      setSelectedPosition(null);
      setInteractionMessage('已取消选中，请重新选择棋子或翻开暗子');
      return;
    }

    // 3. 点击己方明子 -> 选中
    if (piece && piece.revealed && piece.camp === mySide) {
      if (!isMyTurn) {
        setInteractionMessage('当前非己方回合，请等待对方行动');
        return;
      }
      setSelectedPosition(position);
      setInteractionMessage(null);
      return;
    }

    // 4. 尚未选中任何棋子
    if (!selectedPosition) {
      if (!piece) {
        setInteractionMessage('该格当前不可直接操作，请先选择己方明子或翻开暗子');
      } else if (piece.revealed && piece.camp !== mySide) {
        setInteractionMessage('不能直接操作对方明子，请先选择己方明子');
      }
      return;
    }

    // 5. 已选中己方明子，点击目标格 -> 走子/吃子
    if (selectedPosition) {
      if (!isMyTurn) {
        setInteractionMessage('当前非己方回合，请等待对方行动');
        return;
      }
      const res = client.sendGameAction({ type: 'move', from: selectedPosition, to: position });
      if (!res.ok) {
        setInteractionMessage(res.reason ?? '非法着法');
      } else {
        setSelectedPosition(null);
        setInteractionMessage(null);
      }
    }
  };

  const time = findTimeControl(startParameters.timeControlId);
  const selfSeat = startParameters.players.find((seat) => seat.role === viewerRole);
  const opponentSeat = startParameters.players.find((seat) => seat.role !== viewerRole);
  const startSummaryText = `你执${selfSeat?.side === 'red' ? '红' : '黑'}，对手执${opponentSeat?.side === 'red' ? '红' : '黑'} · 局时 ${time.label}（${time.description}）`;

  const redSeat = startParameters.players.find((seat) => seat.side === 'red');
  const blackSeat = startParameters.players.find((seat) => seat.side === 'black');
  const preferenceText =
    startParameters.sidePreference === 'random'
      ? '随机分先'
      : startParameters.sidePreference === 'host-red'
        ? '房主执红'
        : '房主执黑';
  const startSnapshotText = `开局参数快照：分先「${preferenceText}」 → ${redSeat?.name ?? '红方'}执红 · ${blackSeat?.name ?? '黑方'}执黑 · 局时「${time.label}（${time.description}）」 · 设置版本 v${startParameters.settingsVersion}`;

  const turnLabel = displayState.winner
    ? `${campLabel(displayState.winner)}获胜`
    : isMyTurn
      ? `轮到你（${campLabel(mySide)}）`
      : `等待对方行动（${campLabel(opponentSide)}）`;

  return (
    <div className="online-game-container" data-testid="online-game">
      {/* 保持与已有大厅断言兼容的快照与摘要 */}
      <section className="room-panel online-summary-panel">
        <p className="room-notice" data-testid="lobby-started">
          {startSummaryText}
        </p>
        <p className="room-hint" data-testid="start-snapshot">
          {startSnapshotText}
        </p>

        <div className="online-players-bar">
          {connection.members.map((member) => (
            <span
              key={member.id}
              className={`online-player-badge ${member.connected ? 'online' : 'offline'}`}
              data-testid={member.role === 'host' ? 'member-host' : 'member-guest'}
            >
              <span className="online-player-role">{member.role === 'host' ? '房主' : '客人'}</span>
              <span className="online-player-name">{member.name}</span>
              <span className={`online-player-status ${member.connected ? 'status-connected' : 'status-dropped'}`}>
                {member.connected ? '在线' : '已掉线'}
              </span>
            </span>
          ))}
        </div>

        {shuffling ? (
          <div className="shuffling-banner" data-testid="shuffling-banner">
            洗牌中…
          </div>
        ) : null}

        {game.statusNotice ? (
          <p aria-live="assertive" className="room-error online-rejection-notice" data-testid="online-rejection-notice">
            {game.statusNotice}
          </p>
        ) : null}

        <div className="online-meta-bar">
          <span className="turn-indicator" data-testid="turn-indicator">
            {turnLabel}
          </span>
          <span className="step-counter" data-testid="step-number">
            第 {game.stepNumber} 步
          </span>
          {isBusy && !displayState.winner ? (
            <span className="online-busy-hint" data-testid="online-busy-hint">
              {connection.reconnecting ? '重连中…' : '正在提交…'}
            </span>
          ) : null}
        </div>
      </section>

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
            currentGameSummary={buildGameResultSummary(displayState)}
            gameState={displayState}
            interactionMessage={interactionMessage}
            recentCompletedGames={[]}
          />
          <CapturedPieces gameState={displayState} />
          <div className="panel-actions">
            <button
              className="panel-action-secondary"
              data-testid={viewerRole === 'host' ? 'close-room' : 'leave-room'}
              onClick={onExit}
              type="button"
            >
              {viewerRole === 'host' ? '关闭房间' : '离开房间'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
