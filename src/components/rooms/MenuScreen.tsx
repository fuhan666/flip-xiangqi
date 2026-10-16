interface MenuScreenProps {
  hostAvailable: boolean;
  version: string;
  onCreateRoom: () => void;
  onJoinRoom: () => void;
  onLocalGame: () => void;
  onSettings: () => void;
}

/** 入口主页：牌匾式标题 + 创建房间/加入房间 + 次级入口。 */
export function MenuScreen({ hostAvailable, version, onCreateRoom, onJoinRoom, onLocalGame, onSettings }: MenuScreenProps) {
  return (
    <main className="app-shell room-shell">
      <header className="menu-header">
        <div className="menu-plaque">
          <h1>翻牌象棋</h1>
          <p>翻牌变体中国象棋 · 局域网联机对弈</p>
        </div>
      </header>

      <div className="menu-actions">
        <button className="menu-primary" data-testid="menu-create" onClick={onCreateRoom} type="button">
          创建房间
        </button>
        <button className="menu-outline" data-testid="menu-join" onClick={onJoinRoom} type="button">
          加入房间
        </button>
        <button className="menu-secondary" data-testid="menu-local" onClick={onLocalGame} type="button">
          本地双人
        </button>
        <button className="menu-secondary" data-testid="menu-settings" onClick={onSettings} type="button">
          设置
        </button>
      </div>

      {hostAvailable ? null : (
        <p className="menu-note" data-testid="menu-host-unavailable">
          当前页面没有本机建房服务，可以加入别人分享的房间；创建房间请在房主电脑上启动游戏。
        </p>
      )}

      <p className="menu-version" data-testid="app-version">
        {version}
      </p>
    </main>
  );
}
