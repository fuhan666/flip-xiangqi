import { Canvas } from '@react-three/fiber';
import { useMemo } from 'react';
import { CanvasTexture } from 'three';
import type { BoardSceneCellModel, BoardSceneModel, BoardScenePieceModel } from './boardSceneMapper';
import { SCENE_BOARD_WORLD_HEIGHT, SCENE_BOARD_WORLD_WIDTH, SCENE_CELL_SIZE } from './boardSceneMapper';

interface BoardSceneCanvasProps {
  model: BoardSceneModel;
  onCellClick?: (position: { x: number; y: number }) => void;
}

const CELL_TILE_SIZE = SCENE_CELL_SIZE * 0.84;
const PIECE_RADIUS = SCENE_CELL_SIZE * 0.31;
const PIECE_HEIGHT = 0.24;

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

function PieceToken({ piece, onCellClick, onPointerOver, onPointerOut }: { piece: BoardScenePieceModel; onCellClick?: (position: { x: number; y: number }) => void; onPointerOver: () => void; onPointerOut: () => void; }) {
  const texture = useMemo(
    () => createPieceTexture(piece),
    [piece.camp, piece.isHidden, piece.isSelected, piece.label, piece.recentAction, piece.turnState],
  );
  const markerColor = pieceMarkerColor(piece);

  return (
    <group 
      position={[piece.worldX, 0.26, piece.worldZ]}
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
      <mesh castShadow receiveShadow scale={piece.isSelected ? 1.12 : 1}>
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
  );
}

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
