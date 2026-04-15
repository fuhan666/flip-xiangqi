import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_SYMBOLS } from '../../game';
import type { Camp, GameState, PieceType, Position } from '../../game';

export const SCENE_CELL_SIZE = 1.18;
export const SCENE_BOARD_WORLD_WIDTH = BOARD_WIDTH * SCENE_CELL_SIZE;
export const SCENE_BOARD_WORLD_HEIGHT = BOARD_HEIGHT * SCENE_CELL_SIZE;

export type BoardSceneCellState = 'empty' | 'hidden' | 'revealed';
export type BoardSceneTurnState = 'neutral' | 'active' | 'opponent';
export type BoardSceneRecentAction = 'none' | 'flip' | 'move-from' | 'move-to' | 'capture';

export interface BoardSceneCellModel {
  cellState: BoardSceneCellState;
  key: string;
  coordinateLabel: string;
  isFaceDown: boolean;
  isSelected: boolean;
  pieceCamp: Camp | null;
  pieceLabel: string;
  position: Position;
  recentAction: BoardSceneRecentAction;
  testId: string;
  turnState: BoardSceneTurnState;
  worldX: number;
  worldZ: number;
}

export interface BoardScenePieceModel {
  camp: Camp;
  id: string;
  isHidden: boolean;
  isSelected: boolean;
  label: string;
  position: Position;
  recentAction: BoardSceneRecentAction;
  turnState: BoardSceneTurnState;
  type: PieceType;
  worldX: number;
  worldZ: number;
}

export interface BoardSceneModel {
  cells: BoardSceneCellModel[];
  pieces: BoardScenePieceModel[];
}

type PositionedScenePiece = GameState['pieces'][number] & { position: Position };

function isSelectedPosition(position: Position, selectedPosition: Position | null): boolean {
  return position.x === selectedPosition?.x && position.y === selectedPosition?.y;
}

function positionKey(position: Position): string {
  return `${position.x}-${position.y}`;
}

function getCellState(piece: PositionedScenePiece | null): BoardSceneCellState {
  if (!piece) {
    return 'empty';
  }

  return piece.revealed ? 'revealed' : 'hidden';
}

function getTurnState(piece: PositionedScenePiece | null, currentTurn: Camp): BoardSceneTurnState {
  if (!piece || !piece.revealed) {
    return 'neutral';
  }

  return piece.camp === currentTurn ? 'active' : 'opponent';
}

function getRecentActionMarkers(gameState: GameState): {
  sourceKey: string | null;
  targetKey: string | null;
  targetMarker: BoardSceneRecentAction;
} {
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
    targetMarker: recentAction.consequences.some((consequence) => consequence.type === 'capture') ? 'capture' : 'move-to',
  };
}

export function toSceneBoardPosition(position: Position): Pick<BoardSceneCellModel, 'worldX' | 'worldZ'> {
  return {
    worldX: (position.x - (BOARD_WIDTH - 1) / 2) * SCENE_CELL_SIZE,
    worldZ: ((BOARD_HEIGHT - 1) / 2 - position.y) * SCENE_CELL_SIZE,
  };
}

export function mapBoardSceneModel(gameState: GameState, selectedPosition: Position | null): BoardSceneModel {
  const pieces = gameState.pieces.filter(
    (piece): piece is PositionedScenePiece => !piece.captured && piece.position !== null,
  );
  const piecesByPosition = new Map<string, (typeof pieces)[number]>();

  for (const piece of pieces) {
    piecesByPosition.set(positionKey(piece.position), piece);
  }

  const recentActionMarkers = getRecentActionMarkers(gameState);

  const cells = Array.from({ length: BOARD_HEIGHT }, (_, y) =>
    Array.from({ length: BOARD_WIDTH }, (_, x) => {
      const position = { x, y };
      const worldPosition = toSceneBoardPosition(position);
      const piece = piecesByPosition.get(positionKey(position)) ?? null;
      const cellState = getCellState(piece);
      const turnState = getTurnState(piece, gameState.currentTurn);
      const key = positionKey(position);
      let recentAction: BoardSceneRecentAction = 'none';

      if (key === recentActionMarkers.sourceKey) {
        recentAction = 'move-from';
      } else if (key === recentActionMarkers.targetKey) {
        recentAction = recentActionMarkers.targetMarker;
      }

      return {
        cellState,
        key,
        coordinateLabel: `${x},${y}`,
        isFaceDown: cellState === 'hidden',
        isSelected: isSelectedPosition(position, selectedPosition),
        pieceCamp: piece?.revealed ? piece.camp : null,
        pieceLabel: piece ? (piece.revealed ? PIECE_SYMBOLS[piece.camp][piece.type] : '暗') : '',
        position,
        recentAction,
        testId: `cell-${x}-${y}`,
        turnState,
        worldX: worldPosition.worldX,
        worldZ: worldPosition.worldZ,
      } satisfies BoardSceneCellModel;
    }),
  ).flat();

  return {
    cells,
    pieces: pieces.map((piece) => {
      const worldPosition = toSceneBoardPosition(piece.position);

      return {
        camp: piece.camp,
        id: piece.id,
        isHidden: !piece.revealed,
        isSelected: isSelectedPosition(piece.position, selectedPosition),
        label: piece.revealed ? PIECE_SYMBOLS[piece.camp][piece.type] : '暗',
        position: piece.position,
        recentAction:
          positionKey(piece.position) === recentActionMarkers.targetKey
            ? recentActionMarkers.targetMarker
            : 'none',
        turnState: getTurnState(piece, gameState.currentTurn),
        type: piece.type,
        worldX: worldPosition.worldX,
        worldZ: worldPosition.worldZ,
      } satisfies BoardScenePieceModel;
    }),
  };
}
