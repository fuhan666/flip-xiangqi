interface GameControlsProps {
  canUndo: boolean;
  isGameOver: boolean;
  onRematch: () => void;
  onRestart: () => void;
  onUndo: () => void;
}

export function GameControls({ canUndo, isGameOver, onRematch, onRestart, onUndo }: GameControlsProps) {
  return (
    <section className="panel">
      <h2>操作</h2>
      <div className="panel-actions">
        {isGameOver ? (
          <button className="panel-action-primary" onClick={onRematch} type="button">
            再来一局
          </button>
        ) : null}
        <button className="panel-action-secondary" disabled={!canUndo} onClick={onUndo} type="button">
          悔棋
        </button>
        <button className={isGameOver ? 'panel-action-secondary' : 'panel-action-primary'} onClick={onRestart} type="button">
          重新随机开局
        </button>
      </div>
    </section>
  );
}
