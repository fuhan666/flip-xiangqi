import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_SYMBOLS } from '../../game';
import type { Camp, GameState, PieceType, Position } from '../../game';

export const SCENE_CELL_SIZE = 1.18;
export const SCENE_BOARD_WORLD_WIDTH = BOARD_WIDTH * SCENE_CELL_SIZE;
export const SCENE_BOARD_WORLD_HEIGHT = BOARD_HEIGHT * SCENE_CELL_SIZE;

export interface BoardSceneCellModel {
  key: string;
  coordinateLabel: string;
  isFaceDown: boolean;
  isSelected: boolean;
  pieceCamp: Camp | null;
  pieceLabel: string;
  position: Position;
  testId: string;
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
    piecesByPosition.set(`${piece.position.x}-${piece.position.y}`, piece);
  }

  const cells = Array.from({ length: BOARD_HEIGHT }, (_, y) =>
    Array.from({ length: BOARD_WIDTH }, (_, x) => {
      const position = { x, y };
      const worldPosition = toSceneBoardPosition(position);
      const piece = piecesByPosition.get(`${x}-${y}`) ?? null;

      return {
        key: `${x}-${y}`,
        coordinateLabel: `${x},${y}`,
        isFaceDown: !piece?.revealed,
        isSelected: isSelectedPosition(position, selectedPosition),
        pieceCamp: piece?.revealed ? piece.camp : null,
        pieceLabel: piece ? (piece.revealed ? PIECE_SYMBOLS[piece.camp][piece.type] : '暗') : '',
        position,
        testId: `cell-${x}-${y}`,
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
        type: piece.type,
        worldX: worldPosition.worldX,
        worldZ: worldPosition.worldZ,
      } satisfies BoardScenePieceModel;
    }),
  };
}
