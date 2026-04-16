import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { animated, useSpring } from '@react-spring/three';
import { useMemo, useRef, useState } from 'react';
import { CanvasTexture, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import type { BoardSceneCellModel, BoardSceneCapturedPieceModel, BoardSceneModel, BoardScenePieceModel } from './boardSceneMapper';
import { SCENE_BOARD_WORLD_HEIGHT, SCENE_BOARD_WORLD_WIDTH, SCENE_CELL_SIZE } from './boardSceneMapper';

interface BoardSceneCanvasProps {
  model: BoardSceneModel;
  onCellClick?: (position: { x: number; y: number }) => void;
}

const CELL_TILE_SIZE = SCENE_CELL_SIZE * 0.84;
const PIECE_RADIUS = SCENE_CELL_SIZE * 0.31;
const PIECE_HEIGHT = 0.24;

/* ─── colour helpers (unchanged) ─── */

function pieceTexturePalette(piece: BoardScenePieceModel): { fillStyle: string; strokeStyle: string; textColor: string } {
  if (piece.isHidden) {
    return {
      fillStyle: '#6d4a31',
      strokeStyle: piece.recentAction === 'flip' ? '#f4d287' : '#f2d4a0',
      textColor: '#f7ecd5',
    };
  }

  if (piece.camp === 'red') {
    return {
      fillStyle: piece.turnState === 'active' ? '#f1d2a3' : '#e0c398',
      strokeStyle: piece.isSelected ? '#f6d271' : piece.recentAction !== 'none' ? '#ffd39d' : '#9f5d35',
      textColor: '#8f1d14',
    };
  }

  return {
    fillStyle: piece.turnState === 'active' ? '#dde6ef' : '#c9d5e1',
    strokeStyle: piece.isSelected ? '#f6d271' : piece.recentAction !== 'none' ? '#a9d0ff' : '#44566d',
    textColor: '#223246',
  };
}

function pieceBaseColor(piece: BoardScenePieceModel): string {
  if (piece.isHidden) {
    return '#705038';
  }

  if (piece.camp === 'red') {
    return piece.turnState === 'active' ? '#d39a62' : '#b8814d';
  }

  return piece.turnState === 'active' ? '#9fb5c8' : '#8699aa';
}

function pieceMarkerColor(piece: BoardScenePieceModel): string | null {
  if (piece.recentAction === 'capture') {
    return '#d86a50';
  }

  if (piece.recentAction === 'move-to' || piece.recentAction === 'flip') {
    return '#f0ca79';
  }

  if (piece.turnState === 'active') {
    return '#7392b1';
  }

  return null;
}

function tileColor(cell: BoardSceneCellModel): string {
  if (cell.isSelected) {
    return '#f2c86b';
  }

  if (cell.recentAction === 'capture') {
    return '#9d4e3b';
  }

  if (cell.recentAction === 'move-to' || cell.recentAction === 'flip') {
    return '#c89a58';
  }

  if (cell.recentAction === 'move-from') {
    return '#6e5c43';
  }

  if (cell.cellState === 'hidden') {
    return '#6e4930';
  }

  if (cell.turnState === 'active') {
    return '#c9a36b';
  }

  if (cell.turnState === 'opponent') {
    return '#8d745a';
  }

  return '#b27e49';
}

function tileEmissive(cell: BoardSceneCellModel): { color: string; intensity: number } {
  if (cell.isSelected) {
    return { color: '#7f5d23', intensity: 0.35 };
  }

  if (cell.recentAction === 'capture') {
    return { color: '#6d1f13', intensity: 0.42 };
  }

  if (cell.recentAction === 'move-to' || cell.recentAction === 'flip') {
    return { color: '#7b5a1c', intensity: 0.28 };
  }

  if (cell.recentAction === 'move-from') {
    return { color: '#314257', intensity: 0.2 };
  }

  if (cell.turnState === 'active') {
    return { color: '#65512f', intensity: 0.14 };
  }

  return { color: '#000000', intensity: 0 };
}

/* ─── texture factory ─── */

function createPieceTexture(piece: BoardScenePieceModel): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;

  const context = canvas.getContext('2d');
  if (!context) {
    return new CanvasTexture(canvas);
  }

  const { fillStyle, strokeStyle, textColor } = pieceTexturePalette(piece);

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = fillStyle;
  context.strokeStyle = strokeStyle;
  context.lineWidth = 14;
  context.beginPath();
  context.arc(128, 128, 104, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.lineWidth = 6;
  context.beginPath();
  context.arc(128, 128, 78, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = textColor;
  context.font = '700 128px "STKaiti", "Kaiti SC", "PingFang SC", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(piece.label, 128, 136);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/* ─── selection pulse ring ─── */

function SelectionPulse() {
  const ringRef = useRef<Mesh>(null);
  const matRef = useRef<MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (!ringRef.current || !matRef.current) return;
    const t = clock.getElapsedTime();
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.5);
    const s = 1 + 0.06 * pulse;
    ringRef.current.scale.set(s, 1, s);
    matRef.current.emissiveIntensity = 0.3 + 0.2 * pulse;
  });

  return (
    <mesh ref={ringRef} position={[0, PIECE_HEIGHT / 2 + 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[PIECE_RADIUS * 0.92, PIECE_RADIUS * 1.12, 48]} />
      <meshStandardMaterial
        ref={matRef}
        color="#f6d271"
        emissive="#f6d271"
        emissiveIntensity={0.45}
        transparent
        opacity={0.72}
        side={2}
      />
    </mesh>
  );
}

/* ─── animated piece token ─── */

function PieceToken({ piece, onCellClick, onPointerOver, onPointerOut }: {
  piece: BoardScenePieceModel;
  onCellClick?: (position: { x: number; y: number }) => void;
  onPointerOver: () => void;
  onPointerOut: () => void;
}) {
  const groupRef = useRef<Group>(null);
  const [prevHidden, setPrevHidden] = useState(piece.isHidden);

  const texture = useMemo(
    () => createPieceTexture(piece),
    [piece.camp, piece.isHidden, piece.isSelected, piece.label, piece.recentAction, piece.turnState],
  );
  const markerColor = pieceMarkerColor(piece);

  /* ── flip animation (X-rotation book-flip) ── */
  const flipAngle = piece.isHidden ? 0 : Math.PI;
  const prevFlipAngle = prevHidden ? 0 : Math.PI;

  const { rotX } = useSpring({
    rotX: flipAngle,
    from: { rotX: prevFlipAngle },
    config: { mass: 1.2, tension: 180, friction: 20 },
    onChange: ({ value }) => {
      if (piece.isHidden !== prevHidden) {
        setPrevHidden(piece.isHidden);
      }
    },
  });

  /* ── move animation (spring-interpolated position with vertical arc) ── */
  const startPos = piece.previousWorldX !== null && piece.previousWorldZ !== null
    ? [piece.previousWorldX, 0.26, piece.previousWorldZ] as [number, number, number]
    : [piece.worldX, 0.26, piece.worldZ] as [number, number, number];
  const endPos: [number, number, number] = [piece.worldX, 0.26, piece.worldZ];

  const isMoving = piece.recentAction === 'move-to' || piece.recentAction === 'capture';

  const { pos } = useSpring({
    pos: endPos,
    from: isMoving ? startPos : endPos,
    config: { mass: 1, tension: 240, friction: 26 },
  });

  /* ── selection float + scale ── */
  const { selScale, selY } = useSpring({
    selScale: piece.isSelected ? 1.1 : 1,
    selY: piece.isSelected ? 0.08 : 0,
    config: { mass: 0.6, tension: 320, friction: 22 },
  });

  /* ── capture burst scale (brief pop then settle) ── */
  const { captureScale } = useSpring({
    captureScale: piece.recentAction === 'capture' ? 1.15 : 1,
    from: { captureScale: piece.recentAction === 'capture' ? 0.85 : 1 },
    config: { mass: 0.8, tension: 300, friction: 18 },
  });

  return (
    <animated.group
      ref={groupRef}
      position={pos.to((x, _y, z) => {
        const dx = x - endPos[0];
        const dz = z - endPos[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        const arcH = Math.min(dist * 0.35, 1.2) * Math.sin(Math.min(dist / 3, 1) * Math.PI);
        return [x, 0.26 + arcH, z] as [number, number, number];
      })}
      onClick={(e) => {
        e.stopPropagation();
        onCellClick?.(piece.position);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onPointerOver();
      }}
      onPointerOut={onPointerOut}
    >
      <animated.group scale={captureScale.to((s) => [s, s, s] as [number, number, number])}>
        <animated.group
          scale={selScale.to((s) => [s, s, s] as [number, number, number])}
          position={selY.to((y) => [0, y, 0] as [number, number, number])}
        >
          {markerColor ? (
            <mesh position={[0, -PIECE_HEIGHT / 2 - 0.03, 0]} receiveShadow>
              <cylinderGeometry args={[PIECE_RADIUS * 1.2, PIECE_RADIUS * 1.2, 0.04, 48]} />
              <meshStandardMaterial
                color={markerColor}
                emissive={markerColor}
                emissiveIntensity={piece.recentAction !== 'none' ? 0.34 : 0.12}
                metalness={0.08}
                opacity={piece.recentAction !== 'none' ? 0.88 : 0.52}
                roughness={0.48}
                transparent
              />
            </mesh>
          ) : null}

          {/* flip pivot — rotate around X axis */}
          <animated.group rotation={rotX.to((r) => [r, 0, 0] as [number, number, number])}>
            <mesh castShadow receiveShadow>
              <cylinderGeometry args={[PIECE_RADIUS, PIECE_RADIUS, PIECE_HEIGHT, 48]} />
              <meshStandardMaterial
                color={pieceBaseColor(piece)}
                emissive={piece.isSelected ? '#7c5b1f' : markerColor ?? '#000000'}
                emissiveIntensity={piece.isSelected ? 0.45 : piece.recentAction !== 'none' ? 0.1 : 0}
                metalness={0.22}
                roughness={0.52}
              />
            </mesh>
            <mesh position={[0, PIECE_HEIGHT / 2 + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[PIECE_RADIUS * 2.05, PIECE_RADIUS * 2.05]} />
              <meshBasicMaterial map={texture} toneMapped={false} transparent />
            </mesh>
          </animated.group>

          {piece.isSelected && <SelectionPulse />}
        </animated.group>
      </animated.group>
    </animated.group>
  );
}

/* ─── capture fade-out ghost ─── */

function CapturedGhost({ captured, onPointerOver, onPointerOut }: {
  captured: BoardSceneCapturedPieceModel;
  onPointerOver: () => void;
  onPointerOut: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const texture = useMemo(
    () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      if (!ctx) return new CanvasTexture(canvas);
      const isRed = captured.camp === 'red';
      const fill = isRed ? '#e0c398' : '#c9d5e1';
      const stroke = '#d86a50';
      const text = isRed ? '#8f1d14' : '#223246';
      ctx.clearRect(0, 0, 256, 256);
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.arc(128, 128, 104, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(128, 128, 78, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.font = '700 128px "STKaiti", "Kaiti SC", "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(captured.label, 128, 136);
      const t = new CanvasTexture(canvas);
      t.needsUpdate = true;
      return t;
    },
    [captured.camp, captured.label],
  );

  const { ghostOpacity, ghostScale } = useSpring({
    ghostOpacity: 0,
    ghostScale: 0.3,
    from: { ghostOpacity: 0.9, ghostScale: 1.1 },
    config: { mass: 1, tension: 120, friction: 24 },
    onRest: () => setVisible(false),
  });

  if (!visible) return null;

  return (
    <animated.group
      position={[captured.worldX, 0.26, captured.worldZ]}
      scale={ghostScale.to((s) => [s, s, s] as [number, number, number])}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[PIECE_RADIUS, PIECE_RADIUS, PIECE_HEIGHT, 48]} />
        <animated.meshStandardMaterial
          color={captured.camp === 'red' ? '#b8814d' : '#8699aa'}
          emissive="#6d1f13"
          emissiveIntensity={0.5}
          metalness={0.22}
          roughness={0.52}
          transparent
          opacity={ghostOpacity}
        />
      </mesh>
      <mesh position={[0, PIECE_HEIGHT / 2 + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[PIECE_RADIUS * 2.05, PIECE_RADIUS * 2.05]} />
        <animated.meshBasicMaterial map={texture} toneMapped={false} transparent opacity={ghostOpacity} />
      </mesh>
    </animated.group>
  );
}

/* ─── camera controller ─── */

const CAMERA_RED: [number, number, number] = [0, 8.7, 8.9];
const CAMERA_BLACK: [number, number, number] = [0, 8.7, -8.9];

function CameraController({ currentTurn }: { currentTurn: 'red' | 'black' }) {
  const { camera } = useThree();
  const targetPos = currentTurn === 'red' ? CAMERA_RED : CAMERA_BLACK;

  useFrame(() => {
    camera.position.x += (targetPos[0] - camera.position.x) * 0.04;
    camera.position.y += (targetPos[1] - camera.position.y) * 0.04;
    camera.position.z += (targetPos[2] - camera.position.z) * 0.04;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

/* ─── scene ─── */

function SceneContents({ model, onCellClick }: { model: BoardSceneModel; onCellClick?: (position: { x: number; y: number }) => void }) {
  const onPointerOver = () => {
    document.body.style.cursor = 'pointer';
  };
  const onPointerOut = () => {
    document.body.style.cursor = 'auto';
  };

  return (
    <>
      <ambientLight intensity={1.15} />
      <hemisphereLight color="#fff1d6" groundColor="#2a1710" intensity={0.65} />
      <directionalLight castShadow intensity={1.5} position={[4.5, 8, 5.5]} shadow-mapSize-height={1024} shadow-mapSize-width={1024} />

      <CameraController currentTurn={model.currentTurn} />

      <mesh position={[0, -0.22, 0]} receiveShadow>
        <boxGeometry args={[SCENE_BOARD_WORLD_WIDTH + 1.4, 0.3, SCENE_BOARD_WORLD_HEIGHT + 1.4]} />
        <meshStandardMaterial color="#422219" metalness={0.14} roughness={0.88} />
      </mesh>

      <mesh position={[0, -0.03, 0]} receiveShadow>
        <boxGeometry args={[SCENE_BOARD_WORLD_WIDTH + 0.6, 0.08, SCENE_BOARD_WORLD_HEIGHT + 0.6]} />
        <meshStandardMaterial color="#9a6737" metalness={0.08} roughness={0.78} />
      </mesh>

      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[SCENE_BOARD_WORLD_WIDTH + 0.1, SCENE_CELL_SIZE * 1.45]} />
        <meshStandardMaterial color="#2d4768" opacity={0.68} roughness={0.72} transparent />
      </mesh>

      {model.cells.map((cell) => {
        const emissive = tileEmissive(cell);

        return (
          <mesh
            castShadow
            key={cell.key}
            position={[cell.worldX, 0.04, cell.worldZ]}
            receiveShadow
            onClick={(e) => {
              e.stopPropagation();
              onCellClick?.(cell.position);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              onPointerOver();
            }}
            onPointerOut={onPointerOut}
          >
            <boxGeometry args={[CELL_TILE_SIZE, 0.08, CELL_TILE_SIZE]} />
            <meshStandardMaterial
              color={tileColor(cell)}
              emissive={emissive.color}
              emissiveIntensity={emissive.intensity}
              metalness={0.06}
              roughness={0.76}
            />
          </mesh>
        );
      })}

      {model.capturedPieces.map((captured) => (
        <CapturedGhost
          key={`ghost-${captured.id}`}
          captured={captured}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        />
      ))}

      {model.pieces.map((piece) => (
        <PieceToken
          key={piece.id}
          piece={piece}
          onCellClick={onCellClick}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        />
      ))}
    </>
  );
}

export function BoardSceneCanvas({ model, onCellClick }: BoardSceneCanvasProps) {
  return (
    <Canvas
      camera={{ fov: 36, position: [0, 8.7, 8.9] }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true }}
      shadows
    >
      <fog attach="fog" args={['#140d0b', 9, 19]} />
      <SceneContents model={model} onCellClick={onCellClick} />
    </Canvas>
  );
}
