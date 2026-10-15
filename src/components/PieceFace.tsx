type FaceCellState = 'empty' | 'hidden' | 'revealed';
type FaceCamp = 'red' | 'black';

interface PieceFaceProps {
  cellState: FaceCellState;
  pieceCamp: FaceCamp | null;
  pieceLabel: string;
}

const WAVE_RING_SEGMENTS = 22;
const WAVE_RING_RADIUS = 33.5;
const WAVE_RING_AMPLITUDE = 3.2;

function waveRingPath(): string {
  const points: string[] = [];

  for (let i = 0; i <= WAVE_RING_SEGMENTS; i += 1) {
    const angle = (i / WAVE_RING_SEGMENTS) * Math.PI * 2;
    const radius = WAVE_RING_RADIUS + (i % 2 === 0 ? WAVE_RING_AMPLITUDE : -WAVE_RING_AMPLITUDE);
    points.push(`${(50 + radius * Math.cos(angle)).toFixed(2)} ${(50 + radius * Math.sin(angle)).toFixed(2)}`);
  }

  return `M ${points.join(' L ')} Z`;
}

function spiralCurlPath(cx: number, cy: number, startAngle: number): string {
  const steps = 18;
  const points: string[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = startAngle + Math.PI * 2 * 1.15 * t;
    const radius = 8.5 - 6.8 * t;
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }

  return `M ${points.join(' L ')}`;
}

const WAVE_RING = waveRingPath();
const CLOUD_CURLS = [
  spiralCurlPath(50, 24.5, Math.PI * 0.75),
  spiralCurlPath(75.5, 50, Math.PI * 1.25),
  spiralCurlPath(50, 75.5, Math.PI * 1.75),
  spiralCurlPath(24.5, 50, Math.PI * 0.25),
];

export function PieceFace({ cellState, pieceCamp, pieceLabel }: PieceFaceProps) {
  if (cellState === 'empty' || !pieceLabel) {
    return null;
  }

  const isHidden = cellState === 'hidden';
  const faceClasses = [
    'piece-face',
    isHidden ? 'piece-face-hidden' : 'piece-face-revealed',
    isHidden ? '' : `piece-face-${pieceCamp ?? 'neutral'}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span aria-hidden="true" className={faceClasses}>
      <span className="piece-face-grain" />
      {isHidden ? (
        <svg className="piece-face-clouds" focusable="false" viewBox="0 0 100 100">
          <circle className="piece-face-cloud-ring" cx="50" cy="50" r="40.5" />
          <path className="piece-face-cloud-wave" d={WAVE_RING} />
          {CLOUD_CURLS.map((d, index) => (
            <path className="piece-face-cloud-curl" d={d} key={`curl-${index}`} />
          ))}
          <circle className="piece-face-cloud-medallion" cx="50" cy="50" r="14.5" />
          <circle className="piece-face-cloud-medallion-inner" cx="50" cy="50" r="12" />
        </svg>
      ) : (
        <span className="piece-face-ring" />
      )}
    </span>
  );
}
