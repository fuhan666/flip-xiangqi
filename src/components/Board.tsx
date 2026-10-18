import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_SYMBOLS, getPieceAt } from '../game';
import type { Camp, GameState, Piece, Position } from '../game';
import { displayToLogical, logicalToDisplay } from './board-perspective';
import type { Perspective } from './board-perspective';
import { BoardArtwork } from './BoardArtwork';
import { PieceFace } from './PieceFace';
import type {
  CaptureGhostFeedback,
  CheckPulseFeedback,
  FlipFeedback,
  FlipPhase,
  LegalMoveHint,
  TraceFeedback,
} from './useBoardFeedback';

export interface BoardProps {
  gameState: GameState;
  selectedPosition: Position | null;
  onCellClick: (position: Position) => void;
  captureGhost?: CaptureGhostFeedback | null;
  checkPulse?: CheckPulseFeedback | null;
  flip?: FlipFeedback | null;
  legalMoves?: ReadonlyMap<string, LegalMoveHint>;
  trace?: TraceFeedback | null;
  perspective?: Perspective;
  hideHeader?: boolean;
  disabled?: boolean;
}

type CellState = 'empty' | 'hidden' | 'revealed';
type TurnState = 'neutral' | 'active' | 'opponent';
type RecentAction = 'none' | 'flip' | 'move-from' | 'move-to' | 'capture';

interface BoardCellModel {
  cellState: CellState;
  coordinateLabel: string;
  flipPhase: FlipPhase | null;
  isFaceDown: boolean;
  isSelected: boolean;
  key: string;
  legalMove: LegalMoveHint | 'none';
  pieceCamp: Camp | null;
  pieceLabel: string;
  position: Position;
  recentAction: RecentAction;
  testId: string;
  turnState: TurnState;
}

interface LastMoveMarker {
  from: Position;
  to: Position;
}

interface RecentActionMarkers {
  sourceKey: string | null;
  targetKey: string | null;
  targetMarker: RecentAction;
}

function currentTurnLabel(gameState: GameState): string {
  if (gameState.winner) {
    return '终局已定';
  }

  return gameState.currentTurn === 'red' ? '红方回合' : '黑方回合';
}

function positionKey(position: Position): string {
  return `${position.x}-${position.y}`;
}

function getCellState(piece: Piece | undefined): CellState {
  if (!piece) {
    return 'empty';
  }

  return piece.revealed ? 'revealed' : 'hidden';
}

function getTurnState(piece: Piece | undefined, currentTurn: Camp): TurnState {
  if (!piece || !piece.revealed) {
    return 'neutral';
  }

  return piece.camp === currentTurn ? 'active' : 'opponent';
}

function getRecentActionMarkers(gameState: GameState): RecentActionMarkers {
  const recentAction = gameState.recentAction;

  if (!recentAction) {
    return {
      sourceKey: null,
      targetKey: null,
      targetMarker: 'none',
    };
  }

  if (recentAction.action.type === 'flip') {
    return {
      sourceKey: null,
      targetKey: positionKey(recentAction.action.position),
      targetMarker: 'flip',
    };
  }

  return {
    sourceKey: positionKey(recentAction.action.from),
    targetKey: positionKey(recentAction.action.to),
    targetMarker: recentAction.consequences.some((consequence) => consequence.type === 'capture')
      ? 'capture'
      : 'move-to',
  };
}

function findLastMove(gameState: GameState): LastMoveMarker | null {
  for (let index = gameState.actionHistory.length - 1; index >= 0; index -= 1) {
    const entry = gameState.actionHistory[index];
    if (entry.action.type === 'move') {
      return { from: entry.action.from, to: entry.action.to };
    }
  }

  return null;
}

function intersectionPoint(position: Position, perspective: Perspective = 'red'): { cx: number; cy: number } {
  const display = logicalToDisplay(position, perspective);
  return { cx: 50 + 100 * display.x, cy: 50 + 100 * display.y };
}

function buildBoardCells(
  gameState: GameState,
  selectedPosition: Position | null,
  legalMoves: ReadonlyMap<string, LegalMoveHint> | undefined,
  flip: FlipFeedback | null | undefined,
  perspective: Perspective = 'red',
): BoardCellModel[] {
  const markers = getRecentActionMarkers(gameState);
  const cells: BoardCellModel[] = [];

  for (let dy = 0; dy < BOARD_HEIGHT; dy += 1) {
    for (let dx = 0; dx < BOARD_WIDTH; dx += 1) {
      const position = displayToLogical({ x: dx, y: dy }, perspective);
      const key = positionKey(position);
      const piece = getPieceAt(gameState, position);
      const cellState = getCellState(piece);
      let recentAction: RecentAction = 'none';

      if (key === markers.sourceKey) {
        recentAction = 'move-from';
      } else if (key === markers.targetKey) {
        recentAction = markers.targetMarker;
      }

      cells.push({
        cellState,
        coordinateLabel: `${position.x},${position.y}`,
        flipPhase: flip && flip.cellKey === key ? flip.phase : null,
        isFaceDown: cellState === 'hidden',
        isSelected: position.x === selectedPosition?.x && position.y === selectedPosition?.y,
        key,
        legalMove: legalMoves?.get(key) ?? 'none',
        pieceCamp: piece?.revealed ? piece.camp : null,
        pieceLabel: piece ? (piece.revealed ? PIECE_SYMBOLS[piece.camp][piece.type] : '暗') : '',
        position,
        recentAction,
        testId: `cell-${position.x}-${position.y}`,
        turnState: getTurnState(piece, gameState.currentTurn),
      });
    }
  }

  return cells;
}

export function Board({
  captureGhost = null,
  checkPulse = null,
  flip = null,
  gameState,
  hideHeader = false,
  legalMoves,
  onCellClick,
  perspective = 'red',
  selectedPosition,
  trace = null,
  disabled = false,
}: BoardProps) {
  const cells = buildBoardCells(gameState, selectedPosition, legalMoves, flip, perspective);
  const lastMove = findLastMove(gameState);
  const checkBanner = !gameState.winner && gameState.checkedCamp ? '将军警示：请立即应将' : null;

  return (
    <section
      className={`board-shell${disabled ? ' is-disabled' : ''}`}
      data-disabled={disabled ? 'true' : undefined}
      data-perspective={perspective}
      data-turn={gameState.winner ? 'finished' : gameState.currentTurn}
    >
      {!hideHeader ? (
        <div className="board-shell-header">
          <div className="board-turn-indicator">
            <span className="board-turn-label">回合焦点</span>
            <strong className="board-turn-value">{currentTurnLabel(gameState)}</strong>
          </div>
          <div className="board-stage-meta">
            <span className="board-beta-badge">操作提示</span>
            <p className="board-stage-copy">点击暗子翻开；选中己方明子后点击目标位置走子。</p>
          </div>
          <ul aria-label="棋盘状态说明" className="board-legend">
            <li className="board-legend-item board-legend-item-hidden">暗子</li>
            <li className="board-legend-item board-legend-item-active">己方明子</li>
            <li className="board-legend-item board-legend-item-opponent">对方明子</li>
            <li className="board-legend-item board-legend-item-selected">当前选中</li>
            <li className="board-legend-item board-legend-item-recent">最近动作</li>
          </ul>
        </div>
      ) : null}
      {checkBanner ? <p className="board-check-banner">{checkBanner}</p> : null}
      <div
        className="board-frame"
        data-check={gameState.winner ? 'none' : gameState.checkedCamp ?? 'none'}
        data-perspective={perspective}
      >
        {checkPulse ? <span aria-hidden="true" className="board-check-ripple" data-testid="check-ripple" /> : null}
        <div className={`board${disabled ? ' is-disabled' : ''}`} role="grid" aria-label="翻牌中国象棋棋盘" data-perspective={perspective}>
          <BoardArtwork perspective={perspective} />
          <svg aria-hidden="true" className="board-trace-layer" focusable="false" viewBox="0 0 900 1000">
            {lastMove ? (
              <>
                <circle
                  className="board-last-move-ring board-last-move-from"
                  cx={intersectionPoint(lastMove.from, perspective).cx}
                  cy={intersectionPoint(lastMove.from, perspective).cy}
                  r="44"
                />
                <circle
                  className="board-last-move-ring board-last-move-to"
                  cx={intersectionPoint(lastMove.to, perspective).cx}
                  cy={intersectionPoint(lastMove.to, perspective).cy}
                  r="48"
                />
              </>
            ) : null}
            {trace ? (
              <line
                className="board-trace-line"
                x1={intersectionPoint(trace.from, perspective).cx}
                y1={intersectionPoint(trace.from, perspective).cy}
                x2={intersectionPoint(trace.to, perspective).cx}
                y2={intersectionPoint(trace.to, perspective).cy}
              />
            ) : null}
          </svg>
          {cells.map((cell) => {
            const classes = ['cell'];
            if (cell.pieceCamp) {
              classes.push(cell.pieceCamp);
            }
            if (cell.isFaceDown) {
              classes.push('hidden');
            }
            if (cell.isSelected) {
              classes.push('selected');
            }

            return (
              <button
                key={cell.key}
                aria-label={`第 ${cell.position.x + 1} 列，第 ${cell.position.y + 1} 行`}
                aria-pressed={cell.isSelected}
                className={classes.join(' ')}
                data-cell-state={cell.cellState}
                data-flip-phase={cell.flipPhase ?? 'none'}
                data-legal-move={cell.legalMove}
                data-recent-action={cell.recentAction}
                data-testid={cell.testId}
                data-turn-state={cell.turnState}
                disabled={disabled}
                onClick={() => {
                  if (!disabled) {
                    onCellClick(cell.position);
                  }
                }}
                type="button"
              >
                <span className="coordinate">{cell.coordinateLabel}</span>
                <span aria-hidden="true" className="state-ring" />
                <span className={`piece-visual${cell.flipPhase ? ` flip-${cell.flipPhase}` : ''}`}>
                  <PieceFace cellState={cell.cellState} pieceCamp={cell.pieceCamp} pieceLabel={cell.pieceLabel} />
                  <span className="piece-text">{cell.pieceLabel}</span>
                </span>
                {cell.legalMove === 'none' ? null : (
                  <span aria-hidden="true" className={`legal-move legal-move-${cell.legalMove}`} />
                )}
              </button>
            );
          })}
          {captureGhost ? (() => {
            const displayGhost = logicalToDisplay(captureGhost.position, perspective);
            return (
              <span
                aria-hidden="true"
                className="capture-ghost"
                data-testid="capture-ghost"
                style={{
                  left: `${((50 + 100 * displayGhost.x) / 900) * 100}%`,
                  top: `${((50 + 100 * displayGhost.y) / 1000) * 100}%`,
                }}
              >
                <PieceFace
                  cellState="revealed"
                  pieceCamp={captureGhost.camp}
                  pieceLabel={PIECE_SYMBOLS[captureGhost.camp][captureGhost.pieceType]}
                />
                <span className="piece-text">{PIECE_SYMBOLS[captureGhost.camp][captureGhost.pieceType]}</span>
              </span>
            );
          })() : null}
        </div>
      </div>
    </section>
  );
}
