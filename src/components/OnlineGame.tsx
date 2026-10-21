import { useEffect, useMemo, useState } from 'react';
import type { Camp, GameHistoryConsequence, GameHistoryEndgameReason, GameViewState, Position } from '../game/types.js';
import { getPieceViewAt } from '../game/index.js';
import type { ConnectionState, RoomConnection } from '../network/client.js';
import { findTimeControl } from '../network/lobby.js';
import type { MatchSettlement } from '../network/protocol.js';
import { Board } from './Board.js';
import { CapturedPieces } from './CapturedPieces.js';
import { GameResultDialog } from './GameResultDialog.js';
import { MoveHistory, actionSummary, campLabel } from './MoveHistory.js';
import { NegotiationDialog } from './NegotiationDialog.js';
import { NegotiationToast } from './NegotiationToast.js';
import { PlayerClock } from './PlayerClock.js';
import { StatusPanel } from './StatusPanel.js';
import { ConnectionStatus } from './rooms/ConnectionStatus.js';
import { SpectatorList } from './rooms/MemberList.js';
import type { LegalMoveHint } from './useBoardFeedback.js';
import { useOnlineBoardFeedback } from './useOnlineBoardFeedback.js';
import { AudioControls } from './AudioControls.js';
import { useOnlineGameAudio } from './useGameAudio.js';
import { PhraseBubble } from './PhraseBubble.js';
import { QuickPhrasePanel } from './QuickPhrasePanel.js';
import { OnlineRecordPanel } from './OnlineRecordPanel.js';
import type { QuickPhraseId } from '../network/quick-chat.js';

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

function buildGameResultSummary(gameState: GameViewState): GameResultSummary | null {
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
  const isSpectator = viewerRole === 'spectator';

  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [interactionMessage, setInteractionMessage] = useState<string | null>(null);
  const [shuffling, setShuffling] = useState(true);
  const [showCheckToast, setShowCheckToast] = useState(false);
  const [, setGraceTick] = useState(0);
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

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
  // 旁观视角固定红方在下；玩家视角按自己执色。
  const mySide: Camp = isSpectator
    ? 'red'
    : connection.memberId === startParameters.redMemberId
      ? 'red'
      : 'black';
  const opponentSide: Camp = mySide === 'red' ? 'black' : 'red';

  // 客户端只消费服务端公开局面：不还原、不推演、不补造隐藏信息。
  const confirmedState = game.gameState;
  const feedback = useOnlineBoardFeedback(confirmedState, game.lastAcceptedAction);
  useOnlineGameAudio(confirmedState, game.lastAcceptedAction, game.settlement);
  const displayState = feedback.displayState;

  // 1.5 秒将军横幅提示
  useEffect(() => {
    if (displayState.checkedCamp !== null) {
      setShowCheckToast(true);
      const timer = window.setTimeout(() => {
        setShowCheckToast(false);
      }, 1500);
      return () => window.clearTimeout(timer);
    } else {
      setShowCheckToast(false);
    }
  }, [displayState.checkedCamp, displayState.actionHistory.length]);

  // 90秒断线宽限期倒计时
  const clock = game.clock;
  const isGraceActive = Boolean(
    clock?.paused &&
    clock?.disconnectGrace &&
    (clock.disconnectGrace.hostDeadlineMs !== null || clock.disconnectGrace.guestDeadlineMs !== null),
  );
  const graceDeadline = clock?.disconnectGrace?.guestDeadlineMs ?? clock?.disconnectGrace?.hostDeadlineMs ?? null;

  useEffect(() => {
    if (!isGraceActive) {
      return;
    }
    const interval = setInterval(() => setGraceTick((t) => t + 1), 500);
    return () => clearInterval(interval);
  }, [isGraceActive]);

  const graceSecondsRemaining = graceDeadline
    ? Math.max(0, Math.ceil((graceDeadline - (Date.now() + (game.clockOffsetMs ?? 0))) / 1000))
    : 90;

  // 权威终局结算数据
  const settlement: MatchSettlement | null = useMemo(() => {
    if (game.settlement) {
      return game.settlement;
    }
    if (displayState.winner) {
      const endgameConsequence = displayState.recentAction?.consequences.find(isEndgameConsequence);
      return {
        winner: displayState.winner,
        loser: displayState.winner === 'red' ? 'black' : 'red',
        reason: (endgameConsequence as any)?.reason ?? 'checkmate',
        redDurationSeconds: Math.floor((game.clock?.red.accumulatedDurationMs ?? 0) / 1000),
        blackDurationSeconds: Math.floor((game.clock?.black.accumulatedDurationMs ?? 0) / 1000),
        endedAt: Date.now(),
      };
    }
    return null;
  }, [game.settlement, displayState.winner, displayState.recentAction, game.clock]);

  const isMyTurn = !isSpectator && displayState.winner === null && displayState.currentTurn === mySide;
  // 底部信息条归属（旁观视角固定红方在下）：只用于展示样式，不代表可操作。
  const bottomActive = displayState.winner === null && displayState.currentTurn === mySide;
  const isBusy = game.pendingAction !== null || connection.reconnecting;

  // 落点提示直接使用服务端下发的公开 legalMoves；客户端不再本地推演规则。
  const legalMoves = useMemo(() => {
    const hints = new Map<string, LegalMoveHint>();

    if (confirmedState.winner || !selectedPosition || !isMyTurn) {
      return hints;
    }

    const piece = getPieceViewAt(confirmedState.pieces, selectedPosition);
    if (!piece || !piece.revealed || piece.captured || piece.camp !== mySide) {
      return hints;
    }

    const group = confirmedState.legalMoves.find((candidate) => candidate.pieceId === piece.id);
    for (const target of group?.targets ?? []) {
      hints.set(`${target.position.x}-${target.position.y}`, target.kind);
    }

    return hints;
  }, [confirmedState, selectedPosition, isMyTurn, mySide]);

  const handleCellClick = (position: Position) => {
    // 旁观者只读：不产生任何选中态、乐观局面或网络消息。
    if (isSpectator) {
      return;
    }
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

    if (Boolean(game.pendingNegotiation)) {
      setInteractionMessage('协商进行中，棋盘操作已锁定');
      return;
    }

    const piece = getPieceViewAt(displayState.pieces, position);

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

  const myMemberId = connection.memberId ?? '';
  const drawCooldownUntil = game.drawCooldownUntil?.[myMemberId] ?? 0;
  const isDrawCooldown = drawCooldownUntil > currentTime;
  const drawCooldownRemainingSec = isDrawCooldown ? Math.ceil((drawCooldownUntil - currentTime) / 1000) : 0;

  const isMatchEnded = Boolean(displayState.winner || game.settlement);
  const isNegotiating = Boolean(game.pendingNegotiation);
  const isConnected = connection.status === 'connected';

  const canUndo = isConnected && !isMatchEnded && !isNegotiating && game.stepNumber > 0;
  const canDraw = isConnected && !isMatchEnded && !isNegotiating && !isDrawCooldown;
  const canResign = isConnected && !isMatchEnded;

  const handleUndo = () => {
    const res = client.sendGameNegotiate('undo');
    if (!res.ok && res.reason) {
      setInteractionMessage(res.reason);
    }
  };

  const handleDraw = () => {
    const res = client.sendGameNegotiate('draw');
    if (!res.ok && res.reason) {
      setInteractionMessage(res.reason);
    }
  };

  const handleResign = () => {
    setShowResignConfirm(true);
  };

  const handleConfirmResign = () => {
    setShowResignConfirm(false);
    const res = client.sendGameResign();
    if (!res.ok && res.reason) {
      setInteractionMessage(res.reason);
    }
  };

  const handleSendPhrase = (phraseId: QuickPhraseId) => {
    const res = client.sendChatPhrase(phraseId);
    if (!res.ok && res.reason) {
      setInteractionMessage(res.reason);
    }
  };

  const time = findTimeControl(startParameters.timeControlId);
  const redSeat = startParameters.players.find((seat) => seat.side === 'red');
  const blackSeat = startParameters.players.find((seat) => seat.side === 'black');
  const playerRole = viewerRole === 'host' || viewerRole === 'guest' ? viewerRole : null;
  // 旁观视角固定红方在下：红方信息条在底部、黑方在顶部。
  const selfSeat = playerRole ? startParameters.players.find((seat) => seat.role === playerRole) : redSeat;
  const opponentSeat = playerRole ? startParameters.players.find((seat) => seat.role !== playerRole) : blackSeat;
  const startSummaryText = isSpectator
    ? `旁观视角（红方在下） · 局时 ${time.label}（${time.description}）`
    : `你执${selfSeat?.side === 'red' ? '红' : '黑'}，对手执${opponentSeat?.side === 'red' ? '红' : '黑'} · 局时 ${time.label}（${time.description}）`;

  const preferenceText =
    startParameters.sidePreference === 'random'
      ? '随机分先'
      : startParameters.sidePreference === 'host-red'
        ? '房主执红'
        : '房主执黑';
  const startSnapshotText = `开局参数快照：分先「${preferenceText}」 → ${redSeat?.name ?? '红方'}执红 · ${blackSeat?.name ?? '黑方'}执黑 · 局时「${time.label}（${time.description}）」 · 设置版本 v${startParameters.settingsVersion}`;

  const turnLabel = displayState.winner
    ? `${campLabel(displayState.winner)}获胜`
    : isSpectator
      ? `轮到${campLabel(displayState.currentTurn)}行动`
      : isMyTurn
        ? `轮到你（${campLabel(mySide)}）`
        : `等待对方行动（${campLabel(opponentSide)}）`;

  const opponentRole = isSpectator ? (blackSeat?.role ?? 'guest') : viewerRole === 'host' ? 'guest' : 'host';
  const selfRole = isSpectator ? (redSeat?.role ?? 'host') : viewerRole === 'host' ? 'host' : 'guest';
  const opponentMember = isSpectator
    ? connection.members.find((member) => member.id === startParameters.blackMemberId)
    : connection.members.find((member) => member.role === opponentRole) ??
      connection.members.find((member) => member.id !== connection.memberId);
  const selfMember = isSpectator
    ? connection.members.find((member) => member.id === startParameters.redMemberId)
    : connection.members.find((member) => member.role === selfRole) ??
      connection.members.find((member) => member.id === connection.memberId);

  const opponentConnected = opponentMember ? opponentMember.connected : false;
  const selfConnected = selfMember ? selfMember.connected : connection.status === 'connected';

  const opponentName = opponentMember?.name ?? opponentSeat?.name ?? (opponentRole === 'host' ? '房主' : '客人');
  const selfName = selfMember?.name ?? selfSeat?.name ?? (selfRole === 'host' ? '房主' : '客人');

  const opponentPhraseEvent = useMemo(() => {
    if (!opponentMember?.id || !game.recentPhraseEvents) {
      return null;
    }
    return game.recentPhraseEvents[opponentMember.id] ?? null;
  }, [opponentMember?.id, game.recentPhraseEvents]);

  const selfPhraseEvent = useMemo(() => {
    const selfMemberId = isSpectator ? startParameters.redMemberId : myMemberId;
    if (!selfMemberId || !game.recentPhraseEvents) {
      return null;
    }
    return game.recentPhraseEvents[selfMemberId] ?? null;
  }, [isSpectator, startParameters.redMemberId, myMemberId, game.recentPhraseEvents]);

  return (
    <div className="online-game-container" data-testid="online-game">
      <div className="layout online-game-layout">
        <div className="online-board-column">
          {/* 顶部对手信息条 */}
          <header className="online-opponent-bar" data-testid="online-opponent-bar">
            <span
              className={`online-player-badge online-player-top ${opponentConnected ? 'online' : 'offline'}`}
              data-testid={opponentRole === 'host' ? 'member-host' : 'member-guest'}
            >
              <span className="online-player-role">{opponentRole === 'host' ? '房主' : '客人'}</span>
              <span className="online-player-name">{opponentName}</span>
              <span className={`online-player-camp camp-${opponentSide}`}>执{campLabel(opponentSide)}</span>
              <span className={`online-player-status ${opponentConnected ? 'status-connected' : 'status-dropped'}`}>
                {opponentConnected ? '在线' : '已掉线'}
              </span>
            </span>

            <PlayerClock
              clockOffsetMs={game.clockOffsetMs}
              clockSnapshot={game.clock}
              isCurrentTurn={displayState.winner === null && displayState.currentTurn === opponentSide}
              isPaused={Boolean(game.clock?.paused)}
              label={opponentName}
              side={opponentSide}
              timeControlId={startParameters.timeControlId}
            />

            <PhraseBubble
              event={opponentPhraseEvent}
              side="opponent"
            />

            <ConnectionStatus rtt={connection.rtt} status={connection.status} />
          </header>

          {isGraceActive ? (
            <div className="disconnect-grace-banner" data-testid="disconnect-grace-banner" role="status">
              <span className="grace-pulse-dot" />
              <span>
                {isSpectator
                  ? '有棋手连接中断，对局时钟暂停中，等待重连…'
                  : opponentConnected
                    ? '己方网络出现波动，对局时钟已暂停…'
                    : `对手已掉线，对局时钟暂停中。等待重连（剩余 ${graceSecondsRemaining} 秒，共 90 秒）…`}
              </span>
            </div>
          ) : null}

          {showCheckToast ? (
            <div className="check-toast-banner" data-testid="check-toast" role="alert">
              将军！
            </div>
          ) : null}

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

          <Board
            captureGhost={feedback.captureGhost}
            checkPulse={feedback.checkPulse}
            disabled={isSpectator || isNegotiating || isMatchEnded}
            flip={feedback.flip}
            gameState={displayState}
            hideHeader={true}
            legalMoves={legalMoves}
            onCellClick={handleCellClick}
            perspective={mySide}
            selectedPosition={selectedPosition}
            trace={feedback.trace}
          />

          {/* 底部己方信息条 */}
          <footer
            className={`online-self-bar ${
              displayState.winner ? 'turn-finished' : bottomActive ? 'turn-active' : 'turn-waiting'
            }`}
            data-testid="online-self-bar"
            data-turn-state={displayState.winner ? 'finished' : bottomActive ? 'active' : 'waiting'}
          >
            <span
              className={`online-player-badge online-player-bottom ${selfConnected ? 'online' : 'offline'}`}
              data-testid={selfRole === 'host' ? 'member-host' : 'member-guest'}
            >
              <span className="online-player-role">{selfRole === 'host' ? '房主' : '客人'}</span>
              <span className="online-player-name">{selfName}</span>
              <span className={`online-player-camp camp-${mySide}`}>执{campLabel(mySide)}</span>
              <span className={`online-player-status ${selfConnected ? 'status-connected' : 'status-dropped'}`}>
                {selfConnected ? '在线' : '已掉线'}
              </span>
            </span>

            <PlayerClock
              clockOffsetMs={game.clockOffsetMs}
              clockSnapshot={game.clock}
              isCurrentTurn={isMyTurn}
              isPaused={Boolean(game.clock?.paused)}
              label={selfName}
              side={mySide}
              timeControlId={startParameters.timeControlId}
            />

            <PhraseBubble
              event={selfPhraseEvent}
              side="self"
            />

            <div className="online-turn-center">
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

            {isSpectator ? (
              <p className="spectator-readonly-note" data-testid="spectator-readonly-note">
                旁观中 · 只读观看，不可操作棋局
              </p>
            ) : (
            <div className="online-negotiation-actions">
              <QuickPhrasePanel
                cooldownUntil={game.phraseCooldownUntil?.[myMemberId] ?? 0}
                disabled={!isConnected || isMatchEnded || !opponentConnected}
                onSendPhrase={handleSendPhrase}
                serverClockOffsetMs={game.clockOffsetMs}
              />
              <button
                className="online-action-btn online-btn-undo"
                data-testid="btn-undo"
                disabled={!canUndo}
                onClick={handleUndo}
                type="button"
              >
                悔棋
              </button>
              <button
                className="online-action-btn online-btn-draw"
                data-testid="btn-draw"
                disabled={!canDraw}
                onClick={handleDraw}
                type="button"
              >
                {isDrawCooldown ? `求和 (${drawCooldownRemainingSec}s)` : '求和'}
              </button>
              <button
                className="online-action-btn online-btn-resign"
                data-testid="btn-resign"
                disabled={!canResign}
                onClick={handleResign}
                type="button"
              >
                认输
              </button>
            </div>
            )}

            <button
              className="panel-action-secondary online-exit-button"
              data-testid={isSpectator ? 'spectate-exit' : viewerRole === 'host' ? 'close-room' : 'leave-room'}
              onClick={onExit}
              type="button"
            >
              {isSpectator ? '离开观看' : viewerRole === 'host' ? '关闭房间' : '离开房间'}
            </button>
          </footer>
        </div>

        <aside className="sidebar">
          <section className="room-panel online-summary-panel">
            <p className="room-notice" data-testid="lobby-started">
              {startSummaryText}
            </p>
            <p className="room-hint" data-testid="start-snapshot">
              {startSnapshotText}
            </p>
          </section>
          <section className="room-panel online-spectator-panel" data-testid="online-spectator-panel">
            <h2>旁观者</h2>
            <SpectatorList members={connection.members} selfId={connection.memberId} />
          </section>
          {connection.records.length > 0 ? (
            <section className="room-panel online-record-panel" data-testid="online-record-list">
              <h2>本房终局棋谱</h2>
              <p className="room-hint">服务器保留 30 分钟；过期或服务器重启后不可再取回。</p>
              <ul className="record-actions">
                {connection.records.map((item) => (
                  <li key={item.matchId}>
                    <button
                      className="panel-action-secondary"
                      data-testid={`online-record-entry-${item.matchId}`}
                      onClick={() => setSelectedRecordId(item.matchId)}
                      type="button"
                    >
                      {new Date(item.endedAt).toLocaleTimeString()} 结束的对局
                    </button>
                  </li>
                ))}
              </ul>
              {selectedRecordId ? (
                <OnlineRecordPanel
                  client={client}
                  matchId={selectedRecordId}
                  perspective={mySide}
                  recordError={connection.recordError}
                  recordResult={connection.recordResult}
                />
              ) : null}
            </section>
          ) : null}
          <MoveHistory recentAction={displayState.recentAction} />
          <StatusPanel
            currentGameSummary={buildGameResultSummary(displayState)}
            gameState={displayState}
            interactionMessage={interactionMessage}
            recentCompletedGames={[]}
          />
          <CapturedPieces gameState={displayState} />
          <AudioControls className="room-panel audio-controls" />
        </aside>
      </div>

      {showResignConfirm ? (
        <div
          aria-labelledby="resign-confirm-title"
          aria-modal="true"
          className="resign-confirm-overlay"
          data-testid="resign-confirm-dialog"
          role="dialog"
        >
          <div className="resign-confirm-panel">
            <h3 className="resign-confirm-title" id="resign-confirm-title">
              确认认输？
            </h3>
            <p className="resign-confirm-prompt">
              认输后对方将立即获胜，本局将以失败定格。是否确认认输？
            </p>
            <div className="resign-confirm-actions">
              <button
                className="resign-btn resign-btn-danger"
                data-testid="confirm-resign-btn"
                onClick={handleConfirmResign}
                type="button"
              >
                确认认输
              </button>
              <button
                className="resign-btn resign-btn-cancel"
                data-testid="cancel-resign-btn"
                onClick={() => setShowResignConfirm(false)}
                type="button"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {game.pendingNegotiation ? (
        <NegotiationDialog
          isSpectator={isSpectator}
          isTarget={!isSpectator && game.pendingNegotiation.responderMemberId === connection.memberId}
          onReply={(agree) => client.sendGameNegotiateReply(agree)}
          pendingNegotiation={game.pendingNegotiation}
        />
      ) : null}

      <NegotiationToast event={game.negotiationEvent} />

      {settlement ? (
        <GameResultDialog
          recordControls={
            settlement ? (
              <OnlineRecordPanel
                client={client}
                matchId={game.matchId}
                perspective={mySide}
                recordError={connection.recordError}
                recordResult={connection.recordResult}
              />
            ) : null
          }
          onLeave={onExit}
          onRematch={() => client.sendLobbyReturn('rematch')}
          onReturnLobby={() => client.sendLobbyReturn('return-lobby')}
          settlement={settlement}
          viewerSide={isSpectator ? null : mySide}
        />
      ) : null}
    </div>
  );
}
