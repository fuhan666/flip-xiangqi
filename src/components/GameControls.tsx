interface GameControlsProps {
  canUndo: boolean;
  onRestart: () => void;
  onUndo: () => void;
}

export function GameControls({ canUndo, onRestart, onUndo }: GameControlsProps) {
  return (
    <section className="panel">
      <h2>操作</h2>
      <div className="panel-actions">
        <button disabled={!canUndo} onClick={onUndo} type="button">
          悔棋
        </button>
        <button onClick={onRestart} type="button">
          重新开局
        </button>
      </div>
    </section>
  );
}
