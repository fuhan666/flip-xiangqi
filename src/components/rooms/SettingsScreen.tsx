import { useState } from 'react';
import { AudioControls } from '../AudioControls';

interface SettingsScreenProps {
  defaultRoomPort: number;
  savedRoomPort: number | null;
  onSaveRoomPort: (port: number | null) => void;
  onBack: () => void;
}

/** 设置：联机端口配置与本机音效（音量 / 静音）。 */
export function SettingsScreen({ defaultRoomPort, savedRoomPort, onSaveRoomPort, onBack }: SettingsScreenProps) {
  const [value, setValue] = useState(savedRoomPort === null ? '' : String(savedRoomPort));
  const [message, setMessage] = useState<string | null>(null);

  const handleSave = () => {
    const trimmed = value.trim();
    if (trimmed === '') {
      onSaveRoomPort(null);
      setMessage(`已恢复默认端口 ${defaultRoomPort}`);
      return;
    }
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setMessage('端口无效 —— 请填写 1-65535 之间的整数 —— 也可以留空恢复默认');
      return;
    }
    onSaveRoomPort(port);
    setMessage(`已保存：下次建房将优先使用端口 ${port}（被占用时自动顺延）`);
  };

  return (
    <main className="app-shell room-shell">
      <header className="room-header">
        <h1>设置</h1>
        <p>联机端口说明与配置，以及本机音效。</p>
      </header>

      <section className="room-panel">
        <h2>建房端口</h2>
        <p className="room-hint">
          房主建房时在局域网监听该端口（默认 {defaultRoomPort}，被占用时自动顺延并如实展示实际端口）。
          也可以在启动服务时通过环境变量 ROOM_PORT 或命令行 --room-port 指定。
        </p>
        <label className="room-field">
          <span>优先端口</span>
          <input
            aria-label="优先端口"
            data-testid="settings-port-input"
            inputMode="numeric"
            onChange={(event) => setValue(event.target.value)}
            placeholder={String(defaultRoomPort)}
            value={value}
          />
        </label>
        <div className="panel-actions">
          <button className="panel-action-primary" data-testid="settings-save" onClick={handleSave} type="button">
            保存
          </button>
          <button className="panel-action-secondary" data-testid="settings-back" onClick={onBack} type="button">
            返回菜单
          </button>
        </div>
        {message ? (
          <p className="room-hint" data-testid="settings-message">
            {message}
          </p>
        ) : null}
      </section>

      <AudioControls className="room-panel audio-controls" />
    </main>
  );
}
