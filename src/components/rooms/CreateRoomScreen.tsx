import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomControlApi, RoomCreateResult } from '../../network/control-api';
import type { RoomConnection, ConnectionState } from '../../network/client';
import type { MemberSnapshot } from '../../network/protocol';
import { IDLE_CONNECTION_STATE } from './connection-state';
import { copyText } from './clipboard';
import { ConfirmDialog } from './ConfirmDialog';
import { ConnectionStatus } from './ConnectionStatus';
import { RoomLobby } from './RoomLobby';
import { OnlineGame } from '../OnlineGame';

interface CreateRoomScreenProps {
  api: RoomControlApi;
  createClient: () => RoomConnection;
  preferredPort: number;
  onExit: (notice?: string | null) => void;
}

interface HostSession {
  room: RoomCreateResult;
  client: RoomConnection;
}

function describeHostConnection(state: ConnectionState): string {
  switch (state.status) {
    case 'connecting':
      return '正在接入房间…';
    case 'connected':
      return '房间已就绪，等待对手加入';
    case 'disconnected':
      return '与房间的连接已断开 —— 请关闭房间后重新创建';
    case 'error':
      return state.message ?? '房间连接失败 —— 请关闭房间后重新创建';
    default:
      return '正在启动建房服务…';
  }
}

/** 欢迎消息到达前，房主卡片先按本地身份显示。 */
function hostFallbackMembers(state: ConnectionState): MemberSnapshot[] {
  if (state.members.length > 0) {
    return state.members;
  }
  return [{ id: 'host-pending', role: 'host', name: '房主', connected: state.status === 'connected' }];
}

/** 房主建房：启动内置服务 → 展示可分享地址 → 等待客人加入。 */
export function CreateRoomScreen({ api, createClient, preferredPort, onExit }: CreateRoomScreenProps) {
  const sessionRef = useRef<HostSession | null>(null);
  const propsRef = useRef({ api, createClient, preferredPort });
  propsRef.current = { api, createClient, preferredPort };
  const [room, setRoom] = useState<RoomCreateResult | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>(IDLE_CONNECTION_STATE);
  const [confirmClose, setConfirmClose] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const [showCandidates, setShowCandidates] = useState(false);

  useEffect(() => {
    if (sessionRef.current) {
      // StrictMode 等重复挂载：复用已有房间与连接，不重复建房。
      return;
    }

    const { api: controlApi, createClient: factory, preferredPort: port } = propsRef.current;
    setCreating(true);

    void controlApi.createRoom(port).then((result) => {
      setCreating(false);
      if (!result.ok) {
        setCreateError(result.message);
        return;
      }
      if (sessionRef.current) {
        return;
      }

      const client = factory();
      sessionRef.current = { room: result.value, client };
      setRoom(result.value);
      setConnection(client.getState());
      client.subscribe(setConnection);
      client.connect({ host: '127.0.0.1', port: result.value.port }, { role: 'host', name: '房主', token: result.value.hostToken });
    });
  }, []);

  const handleCopy = useCallback(async (key: string, text: string) => {
    const succeeded = await copyText(text);
    if (succeeded) {
      setCopiedKey(key);
      setCopyFailed(null);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 3_000);
    } else {
      setCopyFailed('复制失败 —— 浏览器限制了剪贴板访问 —— 请手动选中地址复制');
    }
  }, []);

  const handleConfirmClose = useCallback(async () => {
    setConfirmClose(false);
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      await api.closeRoom(session.room.hostToken);
      session.client.disconnect();
    }
    onExit('房间已关闭');
  }, [api, onExit]);

  const handleRetry = useCallback(() => {
    setCreateError(null);
    setCreating(true);
    void api.createRoom(preferredPort).then((result) => {
      setCreating(false);
      if (!result.ok) {
        setCreateError(result.message);
        return;
      }
      const client = createClient();
      sessionRef.current = { room: result.value, client };
      setRoom(result.value);
      client.subscribe(setConnection);
      client.connect({ host: '127.0.0.1', port: result.value.port }, { role: 'host', name: '房主', token: result.value.hostToken });
    });
  }, [api, createClient, preferredPort]);

  if (createError) {
    return (
      <main className="app-shell room-shell">
        <header className="room-header">
          <h1>创建房间</h1>
          <p>房间由你的电脑承载，仅限同一局域网。</p>
        </header>
        <section className="room-panel">
          <p className="room-error" data-testid="create-error">
            {createError}
          </p>
          <div className="panel-actions">
            <button className="panel-action-primary" data-testid="create-retry" onClick={handleRetry} type="button">
              重试
            </button>
            <button className="panel-action-secondary" data-testid="create-back" onClick={() => onExit(null)} type="button">
              返回菜单
            </button>
          </div>
        </section>
      </main>
    );
  }

  const primaryAddress = room && room.addresses.length > 0 ? room.addresses[0] : null;
  const primaryText = room ? (primaryAddress ? primaryAddress.address : '127.0.0.1') + `:${room.port}` : '';

  return (
    <main className={`app-shell room-shell${connection.game ? ' room-shell-ingame' : ''}`}>
      {connection.game && sessionRef.current ? (
        <OnlineGame
          client={sessionRef.current.client}
          connection={connection}
          onExit={() => setConfirmClose(true)}
        />
      ) : (
        <>
          <header className="room-header room-header-row">
            <div>
              <h1>等待对手加入</h1>
              <p>请让对手与你连接同一 Wi-Fi/局域网，再输入上面的地址加入。</p>
            </div>
            <ConnectionStatus rtt={connection.rtt} status={connection.status} />
          </header>

          <section className="room-panel">
            <h2>分享这个地址</h2>
            {creating || !room ? (
              <p className="room-hint" data-testid="create-progress">
                正在启动建房服务…
              </p>
            ) : (
              <>
                <div className="address-card">
                  <code className="address-text" data-testid="room-address-main">
                    {primaryText}
                  </code>
                  <button
                    className="panel-action-primary address-copy"
                    data-testid="copy-address"
                    onClick={() => void handleCopy('main', primaryText)}
                    type="button"
                  >
                    {copiedKey === 'main' ? '已复制 ✓' : '复制'}
                  </button>
                </div>

                {room.loopbackOnly ? (
                  <p className="room-warning" data-testid="room-loopback-note">
                    未检测到局域网地址 —— 对手将无法从其他设备加入，仅供本机测试 —— 请检查网络连接后重新建房。
                  </p>
                ) : null}

                {room.addresses.length > 1 ? (
                  <div className="address-candidates">
                    <button
                      className="panel-action-secondary"
                      data-testid="toggle-candidates"
                      onClick={() => setShowCandidates((current) => !current)}
                      type="button"
                    >
                      {showCandidates ? '收起候选地址' : `切换候选地址（共 ${room.addresses.length} 个）`}
                    </button>
                    {showCandidates ? (
                      <ul className="candidate-list" data-testid="candidate-list">
                        {room.addresses.map((candidate) => {
                          const text = `${candidate.address}:${room.port}`;
                          return (
                            <li className="candidate-item" key={text}>
                              <code>{text}</code>
                              <span className="candidate-meta">{candidate.interfaceName}</span>
                              <button
                                className="panel-action-secondary"
                                data-testid={`copy-candidate-${candidate.interfaceName}`}
                                onClick={() => void handleCopy(text, text)}
                                type="button"
                              >
                                {copiedKey === text ? '已复制 ✓' : '复制'}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {room.port !== preferredPort ? (
                  <p className="room-hint" data-testid="room-port-fallback">
                    端口 {preferredPort} 已被占用，已自动改用 {room.port}。
                  </p>
                ) : null}

                <p className="room-hint">实际端口：{room.port} · 房间号：{room.roomId}</p>
                {copyFailed ? (
                  <p className="room-error" data-testid="copy-error">
                    {copyFailed}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <RoomLobby
            connectionHint={
              <p className="room-hint" data-testid="host-connection-state">
                {describeHostConnection(connection)}
              </p>
            }
            lastRejection={connection.lastRejection}
            lobby={connection.lobby}
            members={hostFallbackMembers(connection)}
            onLockChange={(locked) => sessionRef.current?.client.sendLobbyLock(locked)}
            onReadyToggle={(ready) => sessionRef.current?.client.sendLobbyReady(ready)}
            onSettingsChange={(sidePreference, timeControlId) => sessionRef.current?.client.sendLobbySettings(sidePreference, timeControlId)}
            onStart={() => sessionRef.current?.client.sendLobbyStart()}
            pendingCommand={connection.pendingCommand}
            reconnecting={connection.reconnecting}
            selfId={connection.memberId}
            viewerRole={connection.role ?? 'host'}
          />

          <div className="panel-actions">
            <button className="panel-action-secondary" data-testid="close-room" onClick={() => setConfirmClose(true)} type="button">
              关闭房间
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        confirmLabel="关闭房间"
        message="关闭后房间内的所有人都会断开连接，且不会保留对局。"
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => void handleConfirmClose()}
        open={confirmClose}
        title="确定关闭房间？"
      />
    </main>
  );
}
