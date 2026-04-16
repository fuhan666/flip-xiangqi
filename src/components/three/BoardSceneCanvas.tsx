import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CanvasTexture,
  MathUtils,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
} from 'three';
import type {
  BoardSceneCellModel,
  BoardSceneCapturedPieceModel,
  BoardSceneModel,
  BoardScenePieceModel,
} from './boardSceneMapper';
import { SCENE_BOARD_WORLD_HEIGHT, SCENE_BOARD_WORLD_WIDTH, SCENE_CELL_SIZE } from './boardSceneMapper';

interface BoardSceneCanvasProps {
  model: BoardSceneModel;
  onCellClick?: (position: { x: number; y: number }) => void;
}

const CELL_TILE_SIZE = SCENE_CELL_SIZE * 0.84;
const PIECE_RADIUS = SCENE_CELL_SIZE * 0.31;
const PIECE_HEIGHT = 0.24;
const PIECE_BASE_Y = 0.26;
const MOVE_DURATION = 0.34;
const CAPTURE_BURST_DURATION = 0.28;
const CAPTURE_GHOST_DURATION = 0.38;

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3;
}

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

function createTokenTexture(label: string, fillStyle: string, strokeStyle: string, textColor: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;

  const context = canvas.getContext('2d');
  if (!context) {
    return new CanvasTexture(canvas);
  }

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
  context.fillText(label, 128, 136);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function createPieceTexture(piece: BoardScenePieceModel): CanvasTexture {
  const { fillStyle, strokeStyle, textColor } = pieceTexturePalette(piece);
  return createTokenTexture(piece.label, fillStyle, strokeStyle, textColor);
}

function createCapturedPieceTexture(captured: BoardSceneCapturedPieceModel): CanvasTexture {
  return createTokenTexture(
    captured.label,
    captured.camp === 'red' ? '#e0c398' : '#c9d5e1',
    '#d86a50',
    captured.camp === 'red' ? '#8f1d14' : '#223246',
  );
}

function SelectionPulse() {
  const ringRef = useRef<Mesh>(null);
  const materialRef = useRef<MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (!ringRef.current || !materialRef.current) {
      return;
    }

    const pulse = 0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 3.5);
    const scale = 1 + 0.06 * pulse;
    ringRef.current.scale.set(scale, 1, scale);
    materialRef.current.emissiveIntensity = 0.3 + 0.2 * pulse;
  });

  return (
    <mesh ref={ringRef} position={[0, PIECE_HEIGHT / 2 + 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[PIECE_RADIUS * 0.92, PIECE_RADIUS * 1.12, 48]} />
      <meshStandardMaterial
        ref={materialRef}
        color="#f6d271"
        emissive="#f6d271"
        emissiveIntensity={0.45}
        opacity={0.72}
        side={2}
        transparent
      />
    </mesh>
  );
}

function PieceToken({
  piece,
  onCellClick,
  onPointerOut,
  onPointerOver,
}: {
  piece: BoardScenePieceModel;
  onCellClick?: (position: { x: number; y: number }) => void;
  onPointerOver: () => void;
  onPointerOut: () => void;
}) {
  const rootRef = useRef<Group>(null);
  const selectionRef = useRef<Group>(null);
  const flipRef = useRef<Group>(null);

  const texture = useMemo(
    () => createPieceTexture(piece),
    [piece.camp, piece.isHidden, piece.isSelected, piece.label, piece.recentAction, piece.turnState],
  );
  const markerColor = pieceMarkerColor(piece);

  const moveState = useRef({
    progress: 1,
    startX: piece.worldX,
    startZ: piece.worldZ,
    endX: piece.worldX,
    endZ: piece.worldZ,
    arcHeight: 0,
  });
  const flipState = useRef(piece.isHidden ? 0 : Math.PI);
  const selectionScale = useRef(piece.isSelected ? 1.1 : 1);
  const selectionLift = useRef(piece.isSelected ? 0.08 : 0);
  const captureScale = useRef(1);
  const captureBurstRemaining = useRef(0);
  const lastMoveKey = useRef(`${piece.id}:${piece.worldX}:${piece.worldZ}:${piece.recentAction}`);
  const lastFlipHidden = useRef(piece.isHidden);
  const lastCaptureKey = useRef(`${piece.id}:idle`);

  useEffect(() => {
    const nextMoveKey = `${piece.id}:${piece.worldX}:${piece.worldZ}:${piece.recentAction}`;
    const isMoveAction = piece.recentAction === 'move-to' || piece.recentAction === 'capture';
    const startX = piece.previousWorldX;
    const startZ = piece.previousWorldZ;
    const canAnimateMove = isMoveAction && startX !== null && startZ !== null;

    if (canAnimateMove && nextMoveKey !== lastMoveKey.current) {
      const distance = Math.hypot(piece.worldX - startX, piece.worldZ - startZ);
      moveState.current = {
        progress: 0,
        startX,
        startZ,
        endX: piece.worldX,
        endZ: piece.worldZ,
        arcHeight: Math.min(0.16 + distance * 0.2, 0.72),
      };
    } else {
      moveState.current = {
        progress: 1,
        startX: piece.worldX,
        startZ: piece.worldZ,
        endX: piece.worldX,
        endZ: piece.worldZ,
        arcHeight: 0,
      };
    }

    lastMoveKey.current = nextMoveKey;
  }, [piece.id, piece.previousWorldX, piece.previousWorldZ, piece.recentAction, piece.worldX, piece.worldZ]);

  useEffect(() => {
    if (piece.isHidden !== lastFlipHidden.current) {
      lastFlipHidden.current = piece.isHidden;
    }
  }, [piece.isHidden]);

  useEffect(() => {
    const nextCaptureKey = `${piece.id}:${piece.recentAction}:${piece.worldX}:${piece.worldZ}`;
    if (piece.recentAction === 'capture' && nextCaptureKey !== lastCaptureKey.current) {
      captureBurstRemaining.current = CAPTURE_BURST_DURATION;
    }
    lastCaptureKey.current = nextCaptureKey;
  }, [piece.id, piece.recentAction, piece.worldX, piece.worldZ]);

  useFrame((_, delta) => {
    const move = moveState.current;
    if (move.progress < 1) {
      move.progress = Math.min(1, move.progress + delta / MOVE_DURATION);
    }

    const moveProgress = easeOutCubic(move.progress);
    const worldX = MathUtils.lerp(move.startX, move.endX, moveProgress);
    const worldZ = MathUtils.lerp(move.startZ, move.endZ, moveProgress);
    const arcOffset = move.arcHeight * 4 * moveProgress * (1 - moveProgress);
    rootRef.current?.position.set(worldX, PIECE_BASE_Y + arcOffset, worldZ);

    const targetFlip = piece.isHidden ? 0 : Math.PI;
    flipState.current = MathUtils.damp(flipState.current, targetFlip, 10, delta);
    if (flipRef.current) {
      flipRef.current.rotation.x = flipState.current;
    }

    const targetSelectionScale = piece.isSelected ? 1.1 : 1;
    const targetSelectionLift = piece.isSelected ? 0.08 : 0;
    selectionScale.current = MathUtils.damp(selectionScale.current, targetSelectionScale, 9, delta);
    selectionLift.current = MathUtils.damp(selectionLift.current, targetSelectionLift, 9, delta);
    if (selectionRef.current) {
      selectionRef.current.scale.setScalar(selectionScale.current);
      selectionRef.current.position.set(0, selectionLift.current, 0);
    }

    if (captureBurstRemaining.current > 0) {
      captureBurstRemaining.current = Math.max(0, captureBurstRemaining.current - delta);
      const burstProgress = 1 - captureBurstRemaining.current / CAPTURE_BURST_DURATION;
      const burstWave = Math.sin(burstProgress * Math.PI);
      captureScale.current = 1 + burstWave * 0.15 - (1 - burstWave) * 0.05;
    } else {
      captureScale.current = MathUtils.damp(captureScale.current, 1, 12, delta);
    }

    rootRef.current?.scale.setScalar(captureScale.current);
  });

  return (
    <group
      ref={rootRef}
      onClick={(event) => {
        event.stopPropagation();
        onCellClick?.(piece.position);
      }}
      onPointerOut={onPointerOut}
      onPointerOver={(event) => {
        event.stopPropagation();
        onPointerOver();
      }}
      position={[piece.worldX, PIECE_BASE_Y, piece.worldZ]}
    >
      <group ref={selectionRef}>
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

        <group ref={flipRef}>
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
        </group>

        {piece.isSelected ? <SelectionPulse /> : null}
      </group>
    </group>
  );
}

function CapturedGhost({
  captured,
  onPointerOut,
  onPointerOver,
}: {
  captured: BoardSceneCapturedPieceModel;
  onPointerOver: () => void;
  onPointerOut: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const texture = useMemo(() => createCapturedPieceTexture(captured), [captured.camp, captured.label]);
  const groupRef = useRef<Group>(null);
  const bodyMaterialRef = useRef<MeshStandardMaterial>(null);
  const faceMaterialRef = useRef<MeshBasicMaterial>(null);
  const lifeProgress = useRef(0);

  useFrame((_, delta) => {
    if (!visible) {
      return;
    }

    lifeProgress.current = Math.min(1, lifeProgress.current + delta / CAPTURE_GHOST_DURATION);
    const eased = easeOutCubic(lifeProgress.current);
    const opacity = 0.9 * (1 - eased);
    const scale = MathUtils.lerp(1.08, 0.32, eased);
    const lift = MathUtils.lerp(0, 0.18, eased);

    if (groupRef.current) {
      groupRef.current.position.set(captured.worldX, PIECE_BASE_Y + lift, captured.worldZ);
      groupRef.current.scale.setScalar(scale);
    }

    if (bodyMaterialRef.current) {
      bodyMaterialRef.current.opacity = opacity;
    }

    if (faceMaterialRef.current) {
      faceMaterialRef.current.opacity = opacity;
    }

    if (lifeProgress.current >= 1) {
      setVisible(false);
    }
  });

  if (!visible) {
    return null;
  }

  return (
    <group
      ref={groupRef}
      onPointerOut={onPointerOut}
      onPointerOver={onPointerOver}
      position={[captured.worldX, PIECE_BASE_Y, captured.worldZ]}
    >
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[PIECE_RADIUS, PIECE_RADIUS, PIECE_HEIGHT, 48]} />
        <meshStandardMaterial
          ref={bodyMaterialRef}
          color={captured.camp === 'red' ? '#b8814d' : '#8699aa'}
          emissive="#6d1f13"
          emissiveIntensity={0.5}
          metalness={0.22}
          opacity={0.9}
          roughness={0.52}
          transparent
        />
      </mesh>
      <mesh position={[0, PIECE_HEIGHT / 2 + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[PIECE_RADIUS * 2.05, PIECE_RADIUS * 2.05]} />
        <meshBasicMaterial ref={faceMaterialRef} map={texture} opacity={0.9} toneMapped={false} transparent />
      </mesh>
    </group>
  );
}

const CAMERA_RED: [number, number, number] = [0, 8.7, 8.9];
const CAMERA_BLACK: [number, number, number] = [0, 8.7, -8.9];

function CameraController({ currentTurn }: { currentTurn: 'red' | 'black' }) {
  const { camera } = useThree();
  const targetPosition = currentTurn === 'red' ? CAMERA_RED : CAMERA_BLACK;

  useFrame((_, delta) => {
    camera.position.x = MathUtils.damp(camera.position.x, targetPosition[0], 4.2, delta);
    camera.position.y = MathUtils.damp(camera.position.y, targetPosition[1], 4.2, delta);
    camera.position.z = MathUtils.damp(camera.position.z, targetPosition[2], 4.2, delta);
    camera.lookAt(0, 0, 0);
  });

  return null;
}

function SceneContents({
  model,
  onCellClick,
}: {
  model: BoardSceneModel;
  onCellClick?: (position: { x: number; y: number }) => void;
}) {
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
            onClick={(event) => {
              event.stopPropagation();
              onCellClick?.(cell.position);
            }}
            onPointerOut={onPointerOut}
            onPointerOver={(event) => {
              event.stopPropagation();
              onPointerOver();
            }}
            position={[cell.worldX, 0.04, cell.worldZ]}
            receiveShadow
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
          onPointerOut={onPointerOut}
          onPointerOver={onPointerOver}
        />
      ))}

      {model.pieces.map((piece) => (
        <PieceToken
          key={piece.id}
          piece={piece}
          onCellClick={onCellClick}
          onPointerOut={onPointerOut}
          onPointerOver={onPointerOver}
        />
      ))}
    </>
  );
}

export function BoardSceneCanvas({ model, onCellClick }: BoardSceneCanvasProps) {
  return (
    <Canvas camera={{ fov: 36, position: [0, 8.7, 8.9] }} dpr={[1, 1.5]} gl={{ alpha: true, antialias: true }} shadows>
      <fog attach="fog" args={['#140d0b', 9, 19]} />
      <SceneContents model={model} onCellClick={onCellClick} />
    </Canvas>
  );
}
