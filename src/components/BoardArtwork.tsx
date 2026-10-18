import type { Perspective } from './board-perspective';

const VIEW_BOX_WIDTH = 900;
const VIEW_BOX_HEIGHT = 1000;
const GRID_ORIGIN = 50;
const GRID_STEP = 100;
const GRID_LAST_X = GRID_ORIGIN + GRID_STEP * 8;
const GRID_LAST_Y = GRID_ORIGIN + GRID_STEP * 9;
const RIVER_TOP = GRID_ORIGIN + GRID_STEP * 4;
const RIVER_BOTTOM = GRID_ORIGIN + GRID_STEP * 5;

const HORIZONTAL_LINE_Y = Array.from({ length: 10 }, (_, y) => GRID_ORIGIN + GRID_STEP * y);
const INNER_VERTICAL_X = Array.from({ length: 7 }, (_, index) => GRID_ORIGIN + GRID_STEP * (index + 1));

const CANNON_MARKS: Array<[number, number]> = [
  [1, 2],
  [7, 2],
  [1, 7],
  [7, 7],
];

const PAWN_MARKS: Array<[number, number]> = [
  [0, 3],
  [2, 3],
  [4, 3],
  [6, 3],
  [8, 3],
  [0, 6],
  [2, 6],
  [4, 6],
  [6, 6],
  [8, 6],
];

const MARK_OFFSET = 15;
const MARK_ARM = 20;

function centerX(x: number): number {
  return GRID_ORIGIN + GRID_STEP * x;
}

function centerY(y: number): number {
  return GRID_ORIGIN + GRID_STEP * y;
}

function cornerMark(x: number, y: number): string[] {
  const px = centerX(x);
  const py = centerY(y);
  const d = MARK_OFFSET;
  const arm = MARK_ARM;
  const segments: string[] = [];

  if (x > 0) {
    if (y > 0) {
      segments.push(`M ${px - d} ${py - d + arm} V ${py - d} H ${px - d + arm}`);
    }
    if (y < 9) {
      segments.push(`M ${px - d} ${py + d - arm} V ${py + d} H ${px - d + arm}`);
    }
  }

  if (x < 8) {
    if (y > 0) {
      segments.push(`M ${px + d} ${py - d + arm} V ${py - d} H ${px + d - arm}`);
    }
    if (y < 9) {
      segments.push(`M ${px + d} ${py + d - arm} V ${py + d} H ${px + d - arm}`);
    }
  }

  return segments;
}

const MARK_PATHS = [...CANNON_MARKS, ...PAWN_MARKS].flatMap(([x, y]) => cornerMark(x, y)).join(' ');

export interface BoardArtworkProps {
  perspective?: Perspective;
}

export function BoardArtwork({ perspective = 'red' }: BoardArtworkProps) {
  return (
    <svg
      aria-hidden="true"
      className="board-artwork"
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`0 0 ${VIEW_BOX_WIDTH} ${VIEW_BOX_HEIGHT}`}
    >
      <defs>
        <linearGradient id="board-frame-sheen" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#7a4c22" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#4a2b12" stopOpacity="0.28" />
          <stop offset="1" stopColor="#331d0c" stopOpacity="0.5" />
        </linearGradient>
      </defs>

      <rect
        className="board-artwork-frame-outer"
        height={VIEW_BOX_HEIGHT - 16}
        rx="18"
        width={VIEW_BOX_WIDTH - 16}
        x="8"
        y="8"
      />
      <rect
        className="board-artwork-frame-inner"
        height={VIEW_BOX_HEIGHT - 56}
        rx="10"
        width={VIEW_BOX_WIDTH - 56}
        x="28"
        y="28"
      />

      <g className="board-artwork-lines">
        {HORIZONTAL_LINE_Y.map((y) => (
          <line key={`h-${y}`} x1={GRID_ORIGIN} x2={GRID_LAST_X} y1={y} y2={y} />
        ))}
        <line key="v-edge-left" x1={GRID_ORIGIN} x2={GRID_ORIGIN} y1={GRID_ORIGIN} y2={GRID_LAST_Y} />
        <line key="v-edge-right" x1={GRID_LAST_X} x2={GRID_LAST_X} y1={GRID_ORIGIN} y2={GRID_LAST_Y} />
        {INNER_VERTICAL_X.map((x) => (
          <g key={`v-${x}`}>
            <line x1={x} x2={x} y1={GRID_ORIGIN} y2={RIVER_TOP} />
            <line x1={x} x2={x} y1={RIVER_BOTTOM} y2={GRID_LAST_Y} />
          </g>
        ))}
      </g>

      <g className="board-artwork-palace">
        <line x1={centerX(3)} x2={centerX(5)} y1={centerY(0)} y2={centerY(2)} />
        <line x1={centerX(5)} x2={centerX(3)} y1={centerY(0)} y2={centerY(2)} />
        <line x1={centerX(3)} x2={centerX(5)} y1={centerY(7)} y2={centerY(9)} />
        <line x1={centerX(5)} x2={centerX(3)} y1={centerY(7)} y2={centerY(9)} />
      </g>

      <path className="board-artwork-marks" d={MARK_PATHS} />

      <g className="board-artwork-river">
        <text dominantBaseline="middle" textAnchor="middle" x={perspective === 'black' ? 675 : 225} y={502}>
          楚河
        </text>
        <text dominantBaseline="middle" textAnchor="middle" x={perspective === 'black' ? 225 : 675} y={502}>
          汉界
        </text>
      </g>
    </svg>
  );
}

