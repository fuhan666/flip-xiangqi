import { Canvas } from '@react-three/fiber';
import { useMemo } from 'react';
import { CanvasTexture } from 'three';
import type { BoardSceneModel, BoardScenePieceModel } from './boardSceneMapper';
import { SCENE_BOARD_WORLD_HEIGHT, SCENE_BOARD_WORLD_WIDTH, SCENE_CELL_SIZE } from './boardSceneMapper';

interface BoardSceneCanvasProps {
  model: BoardSceneModel;
}

const CELL_TILE_SIZE = SCENE_CELL_SIZE * 0.84;
const PIECE_RADIUS = SCENE_CELL_SIZE * 0.31;
const PIECE_HEIGHT = 0.24;

function createPieceTexture(piece: BoardScenePieceModel): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;

  const context = canvas.getContext('2d');
  if (!context) {
    return new CanvasTexture(canvas);
  }

  const fillStyle = piece.isHidden ? '#6d4a31' : piece.camp === 'red' ? '#e7c58b' : '#d2dbe3';
  const strokeStyle = piece.isSelected ? '#f6d271' : piece.isHidden ? '#f2d4a0' : '#7a5131';
  const textColor = piece.isHidden ? '#f7ecd5' : piece.camp === 'red' ? '#8f1d14' : '#223246';

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

function PieceToken({ piece }: { piece: BoardScenePieceModel }) {
  const texture = useMemo(
    () => createPieceTexture(piece),
    [piece.camp, piece.isHidden, piece.isSelected, piece.label],
  );

  return (
    <group position={[piece.worldX, 0.26, piece.worldZ]}>
      <mesh castShadow receiveShadow scale={piece.isSelected ? 1.08 : 1}>
        <cylinderGeometry args={[PIECE_RADIUS, PIECE_RADIUS, PIECE_HEIGHT, 48]} />
        <meshStandardMaterial
          color={piece.isHidden ? '#705038' : piece.camp === 'red' ? '#b8814d' : '#92a1af'}
          emissive={piece.isSelected ? '#7c5b1f' : '#000000'}
          emissiveIntensity={piece.isSelected ? 0.45 : 0}
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

function SceneContents({ model }: { model: BoardSceneModel }) {
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

      {model.cells.map((cell) => (
        <mesh castShadow key={cell.key} position={[cell.worldX, 0.04, cell.worldZ]} receiveShadow>
          <boxGeometry args={[CELL_TILE_SIZE, 0.08, CELL_TILE_SIZE]} />
          <meshStandardMaterial
            color={cell.isSelected ? '#f2c86b' : cell.isFaceDown ? '#6e4930' : '#c79255'}
            emissive={cell.isSelected ? '#7f5d23' : '#000000'}
            emissiveIntensity={cell.isSelected ? 0.35 : 0}
            metalness={0.06}
            roughness={0.76}
          />
        </mesh>
      ))}

      {model.pieces.map((piece) => (
        <PieceToken key={piece.id} piece={piece} />
      ))}
    </>
  );
}

export function BoardSceneCanvas({ model }: BoardSceneCanvasProps) {
  return (
    <Canvas
      camera={{ fov: 36, position: [0, 8.7, 8.9] }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true }}
      shadows
    >
      <fog attach="fog" args={['#140d0b', 9, 19]} />
      <SceneContents model={model} />
    </Canvas>
  );
}
