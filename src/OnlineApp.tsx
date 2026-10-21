/**
 * 在线入口页面：匿名会话 + 建房/凭房间号加入 + 大厅/对局。
 *
 * - 只访问同源 `/api/online/*` 与 `wss://<当前来源>/ws/rooms/:roomId`，
 *   不探测也不调用 LAN 本机控制 API；
 * - 身份完全来自浏览器匿名 cookie，页面不保存房主令牌或重连密钥；
 * - 刷新/重新打开房间 URL 会以同一匿名身份恢复原成员席位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomClient, type ConnectionState } from './network/client';
import { createHttpOnlineApi, type OnlineApi, type OnlineRoomCreated } from './network/online-api';
import { IDLE_CONNECTION_STATE } from './components/rooms/connection-state';
import { ConnectionStatus } from './components/rooms/ConnectionStatus';
import { ConfirmDialog } from './components/rooms/ConfirmDialog';
import { RoomLobby } from './components/rooms/RoomLobby';
import { copyText } from './components/rooms/clipboard';
import { OnlineGame } from './components/OnlineGame';
import './rooms.css';

const ROOM_PATH = /^\/online\/rooms\/([A-Za-z0-9_-]{8,64})\/?$/;
const ROOM_CODE_PATTERN = /[A-Za-z0-9_-]{8,64}/;

type SessionStatus = 'booting' | 'ready' | 'invalid' | 'unavailable';

function roomIdFromPath(pathname: string): string | null {
  const match = ROOM_PATH.exec(pathname);
  return match ? match[1]! : null;
}

/** 接受完整邀请链接或纯房间号，只提取公开房间标识。 */
function parseRoomInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const fromPath = roomIdFromPath(new URL(trimmed, 'https://placeholder.local').pathname);
  if (fromPath) {
    return fromPath;
  }
  return ROOM_CODE_PATTERN.test(trimmed) && trimmed.length <= 64 ? trimmed : null;
}

function newRequestId(): string {
  return Math.random().toString(36).slice(2, 12);
}

interface OnlineAppProps {
  api?: OnlineApi;
  createClient?: () => RoomClient;
}

export default function OnlineApp({ api, createClient }: OnlineAppProps) {
  const onlineApi = useMemo(() => api ?? createHttpOnlineApi(), [api]);
  const clientRef = useRef<RoomClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = createClient ? createClient() : new RoomClient();
  }

  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('booting');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(() => roomIdFromPath(window.location.pathname));
  const [room, setRoom] = useState<OnlineRoomCreated | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(IDLE_CONNECTION_STATE);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [roomInput, setRoomInput] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [copied, setCopied] = useState(false);
  // 凭据重置后强制重连一次。
  const [connectNonce, setConnectNonce] = useState(0);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void onlineApi.ensureSession().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setSessionStatus('ready');
        return;
      }
      if (result.code === 'SESSION_INVALID') {
        setSessionStatus('invalid');
        return;
      }
      setSessionStatus('unavailable');
      setSessionError(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [onlineApi]);

  // 订阅连接状态；卸载或切换房间时只释放传输，不向服务器发送主动离开。
  useEffect(() => {
    const client = clientRef.current;
    if (!client) {
      return;
    }
    const unsubscribe = client.subscribe(setConnection);
    return () => {
      unsubscribe();
      client.disconnect(false);
    };
  }, []);

  useEffect(() => {
    if (sessionStatus !== 'ready' || !roomId) {
      return;
    }
    const client = clientRef.current;
    if (!client) {
      return;
    }
    client.connectOnline(roomId);
    return () => {
      client.disconnect(false);
    };
  }, [sessionStatus, roomId, connectNonce]);

  const navigateToRoom = useCallback((nextRoomId: string) => {
    window.history.replaceState(null, '', `/online/rooms/${nextRoomId}`);
    setRoomId(nextRoomId);
  }, []);

  const handleCreate = useCallback(async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    setError(null);
    // 一次明确的建房意图及其重试复用同一个 requestId；相同请求不会产生第二个房间。
    if (!requestIdRef.current) {
      requestIdRef.current = newRequestId();
    }
    const result = await onlineApi.createRoom(requestIdRef.current);
    setCreating(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.value.closed) {
      requestIdRef.current = null;
      setError('该建房请求对应的房间已关闭 —— 请重新创建');
      return;
    }
    requestIdRef.current = null;
    setRoom(result.value);
    navigateToRoom(result.value.roomId);
  }, [creating, navigateToRoom, onlineApi]);

  const handleJoin = useCallback(() => {
    const parsed = parseRoomInput(roomInput);
    if (!parsed) {
      setError('请输入有效的房间号或邀请链接');
      return;
    }
    setError(null);
    navigateToRoom(parsed);
  }, [navigateToRoom, roomInput]);

  const handleResetSession = useCallback(async () => {
    const result = await onlineApi.resetSession();
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSessionStatus('ready');
    setSessionError(null);
    setConnectNonce((current) => current + 1);
  }, [onlineApi]);

  const inviteUrl = roomId ? `${window.location.origin}/online/rooms/${roomId}` : '';

  const handleCopy = useCallback(async () => {
    if (!inviteUrl) {
      return;
    }
    const ok = await copyText(inviteUrl);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    }
  }, [inviteUrl]);

  const handleLeave = useCallback(async () => {
    setConfirmLeave(false);
    const client = clientRef.current;
    if (client) {
      client.disconnect(true);
    }
    if (roomId && connection.role === 'host') {
      await onlineApi.closeRoom(roomId);
    }
    window.history.replaceState(null, '', '/online');
    setRoomId(null);
    setRoom(null);
    setError(null);
  }, [connection.role, onlineApi, roomId]);

  const inGame = Boolean(connection.game && connection.lobby?.phase === 'started');
  const client = clientRef.current;

  if (sessionStatus === 'booting') {
    return (
      <main className="app-shell room-shell">
        <header className="room-header">
          <h1>在线对战</h1>
          <p>正在建立匿名会话…</p>
        </header>
      </main>
    );
  }

  if (sessionStatus === 'invalid' || sessionStatus === 'unavailable') {
    return (
      <main className="app-shell room-shell">
        <header className="room-header">
          <h1>在线对战</h1>
          <p>{sessionStatus === 'invalid' ? '匿名会话已失效' : '在线入口暂不可用'}</p>
        </header>
        <section className="room-panel">
          <p className="room-error" data-testid="online-session-error">
            {sessionStatus === 'invalid'
              ? '浏览器中的匿名凭据已失效（可能因服务重启）—— 原席位无法恢复，请开始新的匿名会话。'
              : sessionError}
          </p>
          <div className="panel-actions">
            {sessionStatus === 'invalid' ? (
              <button
                className="panel-action-primary"
                data-testid="online-session-reset"
                onClick={() => void handleResetSession()}
                type="button"
              >
                开始新的匿名会话
              </button>
            ) : (
              <button
                className="panel-action-secondary"
                data-testid="online-session-retry"
                onClick={() => window.location.reload()}
                type="button"
              >
                重新加载
              </button>
            )}
          </div>
        </section>
      </main>
    );
  }

  if (!roomId) {
    return (
      <main className="app-shell room-shell">
        <header className="room-header">
          <h1>在线对战 · 匿名房间</h1>
          <p>创建房间后把邀请链接发给对手；同一浏览器再次打开该链接即恢复你的席位。</p>
        </header>

        <section className="room-panel">
          <h2>创建房间</h2>
          <div className="panel-actions">
            <button
              className="panel-action-primary"
              data-testid="online-create-room"
              disabled={creating}
              onClick={() => void handleCreate()}
              type="button"
            >
              {creating ? '正在创建…' : '创建房间'}
            </button>
          </div>
        </section>

        <section className="room-panel">
          <h2>加入房间</h2>
          <label className="room-field">
            <span>房间号或邀请链接</span>
            <input
              className="room-input"
              data-testid="online-room-input"
              onChange={(event) => setRoomInput(event.target.value)}
              placeholder="例如 7f3k9q2m"
              type="text"
              value={roomInput}
            />
          </label>
          <div className="panel-actions">
            <button
              className="panel-action-secondary"
              data-testid="online-join-room"
              onClick={handleJoin}
              type="button"
            >
              加入房间
            </button>
          </div>
        </section>

        {error ? (
          <p className="room-error" data-testid="online-error">
            {error}
          </p>
        ) : null}
      </main>
    );
  }

  if (inGame && client) {
    return (
      <main className="app-shell room-shell room-shell-ingame">
        <OnlineGame client={client} connection={connection} onExit={() => setConfirmLeave(true)} />
        <ConfirmDialog
          confirmLabel="离开对局"
          message="离开会立即按断线规则裁决，且无法返回这盘棋。"
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => void handleLeave()}
          open={confirmLeave}
          title="确定离开房间？"
        />
      </main>
    );
  }

  return (
    <main className="app-shell room-shell">
      <header className="room-header room-header-row">
        <div>
          <h1>在线房间</h1>
          <p>房间号：{roomId}</p>
        </div>
        <ConnectionStatus rtt={connection.rtt} status={connection.status} />
      </header>

      <section className="room-panel">
        <h2>邀请对手</h2>
        <div className="address-card">
          <code className="address-text" data-testid="online-invite-url">
            {inviteUrl}
          </code>
          <button className="panel-action-primary address-copy" onClick={() => void handleCopy()} type="button">
            {copied ? '已复制 ✓' : '复制'}
          </button>
        </div>
        <p className="room-hint">邀请链接只包含公开房间号，不包含房主控制或重连凭据。</p>
      </section>

      {room ? (
        <p className="room-hint" data-testid="online-room-created">
          房间已创建
        </p>
      ) : null}

      {error ? (
        <p className="room-error" data-testid="online-error">
          {error}
        </p>
      ) : null}

      <RoomLobby
        connectionHint={
          <p className="room-hint" data-testid="online-connection-state">
            {connection.status === 'connected'
              ? '已连接'
              : connection.status === 'reconnecting'
                ? '连接中断，正在尝试恢复…'
                : '正在接入房间…'}
          </p>
        }
        lastRejection={connection.lastRejection}
        lobby={connection.lobby}
        members={connection.members}
        onLockChange={(locked) => client?.sendLobbyLock(locked)}
        onReadyToggle={(ready) => client?.sendLobbyReady(ready)}
        onSettingsChange={(sidePreference, timeControlId) =>
          client?.sendLobbySettings(sidePreference, timeControlId)
        }
        onStart={() => client?.sendLobbyStart()}
        pendingCommand={connection.pendingCommand}
        reconnecting={connection.reconnecting}
        selfId={connection.memberId}
        viewerRole={connection.role ?? 'guest'}
      />

      <div className="panel-actions">
        <button
          className="panel-action-secondary"
          data-testid="online-leave-room"
          onClick={() => setConfirmLeave(true)}
          type="button"
        >
          退出房间
        </button>
      </div>

      <ConfirmDialog
        confirmLabel="退出房间"
        message={
          connection.role === 'host'
            ? '房主退出会关闭房间，房间内所有人都会断开。'
            : '退出后你的席位会被释放，再次进入将作为新的成员。'
        }
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => void handleLeave()}
        open={confirmLeave}
        title="确定退出房间？"
      />
    </main>
  );
}
