import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_SYMBOLS, getPieceAt } from '../game';
import type { Camp, GameState, Piece, Position } from '../game';
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

interface BoardProps {
  gameState: GameState;
  selectedPosition: Position | null;
  onCellClick: (position: Position) => void;
  captureGhost?: CaptureGhostFeedback | null;
  checkPulse?: CheckPulseFeedback | null;
  flip?: FlipFeedback | null;
  legalMoves?: ReadonlyMap<string, LegalMoveHint>;
  trace?: TraceFeedback | null;
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

function intersectionPoint(position: Position): { cx: number; cy: number } {
  return { cx: 50 + 100 * position.x, cy: 50 + 100 * position.y };
}

function buildBoardCells(
  gameState: GameState,
  selectedPosition: Position | null,
  legalMoves: ReadonlyMap<string, LegalMoveHint> | undefined,
  flip: FlipFeedback | null | undefined,
): BoardCellModel[] {
  const markers = getRecentActionMarkers(gameState);
  const cells: BoardCellModel[] = [];

  for (let y = 0; y < BOARD_HEIGHT; y += 1) {
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const position = { x, y };
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
        coordinateLabel: `${x},${y}`,
        flipPhase: flip && flip.cellKey === key ? flip.phase : null,
        isFaceDown: cellState === 'hidden',
        isSelected: position.x === selectedPosition?.x && position.y === selectedPosition?.y,
        key,
        legalMove: legalMoves?.get(key) ?? 'none',
        pieceCamp: piece?.revealed ? piece.camp : null,
        pieceLabel: piece ? (piece.revealed ? PIECE_SYMBOLS[piece.camp][piece.type] : '暗') : '',
        position,
        recentAction,
        testId: `cell-${x}-${y}`,
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
  legalMoves,
  onCellClick,
  selectedPosition,
  trace = null,
}: BoardProps) {
  const cells = buildBoardCells(gameState, selectedPosition, legalMoves, flip);
  const lastMove = findLastMove(gameState);
  const checkBanner = !gameState.winner && gameState.checkedCamp ? '将军警示：请立即应将' : null;

  return (
    <section className="board-shell" data-turn={gameState.winner ? 'finished' : gameState.currentTurn}>
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
      {checkBanner ? <p className="board-check-banner">{checkBanner}</p> : null}
      <div className="board-frame" data-check={gameState.winner ? 'none' : gameState.checkedCamp ?? 'none'}>
        {checkPulse ? <span aria-hidden="true" className="board-check-ripple" data-testid="check-ripple" /> : null}
        <div className="board" role="grid" aria-label="翻牌中国象棋棋盘">
          <BoardArtwork />
          <svg aria-hidden="true" className="board-trace-layer" focusable="false" viewBox="0 0 900 1000">
            {lastMove ? (
              <>
                <circle
                  className="board-last-move-ring board-last-move-from"
                  cx={intersectionPoint(lastMove.from).cx}
                  cy={intersectionPoint(lastMove.from).cy}
                  r="44"
                />
                <circle
                  className="board-last-move-ring board-last-move-to"
                  cx={intersectionPoint(lastMove.to).cx}
                  cy={intersectionPoint(lastMove.to).cy}
                  r="48"
                />
              </>
            ) : null}
            {trace ? (
              <line
                className="board-trace-line"
                x1={intersectionPoint(trace.from).cx}
                y1={intersectionPoint(trace.from).cy}
                x2={intersectionPoint(trace.to).cx}
                y2={intersectionPoint(trace.to).cy}
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
                onClick={() => onCellClick(cell.position)}
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
          {captureGhost ? (
            <span
              aria-hidden="true"
              className="capture-ghost"
              data-testid="capture-ghost"
              style={{
                left: `${((50 + 100 * captureGhost.position.x) / 900) * 100}%`,
                top: `${((50 + 100 * captureGhost.position.y) / 1000) * 100}%`,
              }}
            >
              <PieceFace
                cellState="revealed"
                pieceCamp={captureGhost.camp}
                pieceLabel={PIECE_SYMBOLS[captureGhost.camp][captureGhost.pieceType]}
              />
              <span className="piece-text">{PIECE_SYMBOLS[captureGhost.camp][captureGhost.pieceType]}</span>
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
