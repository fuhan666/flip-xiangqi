import { useCallback, useEffect, useRef, useState } from 'react';
import { parseServerAddress, formatAddress } from '../../network/address';
import type { RoomConnection, ConnectionState } from '../../network/client';
import type { StorageLike } from '../../network/recent-rooms';
import { loadRecentRooms, rememberRoom } from '../../network/recent-rooms';
import type { RecentRoom } from '../../network/recent-rooms';
import { IDLE_CONNECTION_STATE } from './connection-state';
import { ConfirmDialog } from './ConfirmDialog';
import { MemberList } from './MemberList';

interface JoinRoomScreenProps {
  createClient: () => RoomConnection;
  storage: StorageLike;
  /** 打开房主分享地址时的默认地址。 */
  initialAddress: string;
  guestPage: boolean;
  onExit: (notice?: string | null) => void;
}

function formatSavedAt(savedAt: number): string {
  if (!savedAt) {
    return '';
  }
  const date = new Date(savedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 客人加入：地址输入 + 最近房间 → 连接 → 房间成员。 */
export function JoinRoomScreen({ createClient, storage, initialAddress, guestPage, onExit }: JoinRoomScreenProps) {
  const clientRef = useRef<RoomConnection | null>(null);
  if (!clientRef.current) {
    clientRef.current = createClient();
  }

  const [address, setAddress] = useState(initialAddress);
  const [connection, setConnection] = useState<ConnectionState>(IDLE_CONNECTION_STATE);
  const [formError, setFormError] = useState<string | null>(null);
  const [slowNotice, setSlowNotice] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [closedNotice, setClosedNotice] = useState<string | null>(null);
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>(() => loadRecentRooms(storage));
  const rememberedRef = useRef(false);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    return client.subscribe((state) => {
      setConnection(state);
      if (state.status === 'connected' && !rememberedRef.current) {
        rememberedRef.current = true;
        const savedAddress = client.getAddress();
        if (savedAddress) {
          setRecentRooms(rememberRoom(savedAddress, Date.now(), storage));
        }
      }
      if (state.closedReason) {
        setClosedNotice(state.message ?? '房主已关闭房间');
        rememberedRef.current = false;
      }
      if (state.status === 'error' || state.status === 'disconnected') {
        rememberedRef.current = false;
      }
    });
  }, [storage]);

  useEffect(() => {
    if (connection.status !== 'connecting') {
      setSlowNotice(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowNotice(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [connection.status]);

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  const handleJoin = useCallback(() => {
    const parsed = parseServerAddress(address);
    if (!parsed.ok) {
      setFormError(parsed.message);
      return;
    }
    setFormError(null);
    setClosedNotice(null);
    rememberedRef.current = false;
    setAddress(formatAddress(parsed.value));
    clientRef.current?.connect(parsed.value, { role: 'guest', name: '客人' });
  }, [address]);

  const handleLeave = useCallback(() => {
    setConfirmLeave(false);
    clientRef.current?.disconnect();
    setConnection(IDLE_CONNECTION_STATE);
  }, []);

  const connected = connection.status === 'connected';
  const connecting = connection.status === 'connecting';

  return (
    <main className="app-shell room-shell">
      <header className="room-header">
        <h1>加入房间</h1>
        <p>{guestPage ? '你正在打开房主分享的地址，确认后即可加入。' : '输入房主分享的地址，加入同一局域网的对局房间。'}</p>
      </header>

      {connected ? (
        <>
          <section className="room-panel">
            <h2>房间成员</h2>
            <MemberList members={connection.members} selfId={connection.memberId} />
            <p className="room-hint" data-testid="join-connection-state">
              已连接 · 房间号 {connection.roomId}
            </p>
          </section>
          <div className="panel-actions">
            <button className="panel-action-secondary" data-testid="leave-room" onClick={() => setConfirmLeave(true)} type="button">
              离开房间
            </button>
          </div>
        </>
      ) : (
        <>
          <section className="room-panel">
            <h2>房间地址</h2>
            <label className="room-field">
              <span>IP:端口</span>
              <input
                aria-label="房间地址"
                data-testid="join-address-input"
                onChange={(event) => setAddress(event.target.value)}
                placeholder="如 192.168.1.5:8080"
                value={address}
              />
            </label>
            <div className="panel-actions">
              <button className="panel-action-primary" data-testid="join-submit" disabled={connecting} onClick={handleJoin} type="button">
                {connecting ? '连接中…' : '加入'}
              </button>
              <button className="panel-action-secondary" data-testid="join-back" onClick={() => onExit(null)} type="button">
                返回菜单
              </button>
            </div>
            {connecting ? (
              <p className="room-hint" data-testid="join-progress">
                {slowNotice ? '仍在尝试连接，请稍候…' : '正在连接房间…'}
              </p>
            ) : null}
            {formError ? (
              <p className="room-error" data-testid="join-error">
                {formError}
              </p>
            ) : null}
            {!formError && connection.status === 'error' && connection.message ? (
              <p className="room-error" data-testid="join-connection-error">
                {connection.message}
              </p>
            ) : null}
            {!formError && connection.status === 'disconnected' && connection.message && !closedNotice ? (
              <p className="room-error" data-testid="join-connection-error">
                {connection.message}
              </p>
            ) : null}
            {closedNotice ? (
              <p className="room-warning" data-testid="room-closed-notice">
                {closedNotice} —— 可以重新输入地址加入，或向房主索取新的地址
              </p>
            ) : null}
          </section>

          <section className="room-panel">
            <h2>最近房间</h2>
            {recentRooms.length === 0 ? (
              <p className="room-hint" data-testid="recent-empty">
                还没有加入过的房间 —— 连接成功后会自动保存最近 5 条地址，点击即可填入。
              </p>
            ) : (
              <ul className="recent-list" data-testid="recent-rooms">
                {recentRooms.map((room) => (
                  <li className="recent-item" key={room.address}>
                    <button
                      className="recent-entry"
                      data-testid="recent-room-item"
                      onClick={() => setAddress(room.address)}
                      type="button"
                    >
                      <code>{room.address}</code>
                      <span className="recent-meta">{formatSavedAt(room.savedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        confirmLabel="离开房间"
        message="确定离开？对局将不会保留。"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={handleLeave}
        open={confirmLeave}
        title="确定离开房间？"
      />
    </main>
  );
}
