import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RoomApp from '../../RoomApp';
import { JoinRoomScreen } from '../rooms/JoinRoomScreen';
import type { RoomControlApi, RoomCreateResult } from '../../network/control-api';
import type { ConnectionState, JoinOptions, RoomConnection } from '../../network/client';
import type { ParsedAddress } from '../../network/address';
import type { MemberSnapshot, MatchAction, SidePreference, TimeControlId } from '../../network/protocol';
import type { StorageLike } from '../../network/recent-rooms';
import { IDLE_CONNECTION_STATE } from '../rooms/connection-state';
import { applyLobbyCommand, createLobbyState, type LobbyState } from '../../network/lobby';

const HOST_MEMBER: MemberSnapshot = { id: 'host-1', role: 'host', name: '房主', connected: true };
const GUEST_MEMBER: MemberSnapshot = { id: 'guest-1', role: 'guest', name: '客人', connected: true };

type LobbyCall =
  | { type: 'settings'; sidePreference: SidePreference; timeControlId: TimeControlId }
  | { type: 'lock'; locked: boolean }
  | { type: 'ready'; ready: boolean }
  | { type: 'start' };

function fakeRoom(overrides: Partial<RoomCreateResult> = {}): RoomCreateResult {
  return {
    roomId: 'room1234',
    hostToken: 'token-abc',
    port: 8080,
    addresses: [
      { address: '192.168.1.5', interfaceName: 'en0', private: true },
      { address: '10.0.0.9', interfaceName: 'utun0', private: true },
    ],
    loopbackOnly: false,
    ...overrides,
  };
}

function fakeApi(overrides: Partial<RoomControlApi> = {}): RoomControlApi & { createCalls: number[]; closeCalls: string[] } {
  const createCalls: number[] = [];
  const closeCalls: string[] = [];
  const api = {
    createCalls,
    closeCalls,
    status: async () => ({ hostAvailable: true, defaultRoomPort: 8080, active: false, room: null }),
    createRoom: async (port?: number) => {
      createCalls.push(port ?? -1);
      return { ok: true as const, value: fakeRoom() };
    },
    closeRoom: async (hostToken: string) => {
      closeCalls.push(hostToken);
      return { ok: true as const, value: true as const };
    },
    isGuestPage: async () => false,
    ...overrides,
  };
  return api;
}

class FakeConnection implements RoomConnection {
  state: ConnectionState = { ...IDLE_CONNECTION_STATE };
  listeners = new Set<(state: ConnectionState) => void>();
  connectCalls: Array<{ address: ParsedAddress; options: JoinOptions }> = [];
  disconnectCalls = 0;
  reconnectCalls = 0;
  lobbyCalls: LobbyCall[] = [];
  private savedAddress: string | null = null;

  connect(address: ParsedAddress, options: JoinOptions): void {
    this.connectCalls.push({ address, options });
    this.savedAddress = `${address.host}:${address.port}`;
    this.setState({ ...this.state, status: 'connecting', role: options.role, errorCode: null, message: null });
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.setState({ ...IDLE_CONNECTION_STATE, status: 'disconnected' });
  }

  reconnect(): void {
    this.reconnectCalls += 1;
  }

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): ConnectionState {
    return this.state;
  }

  getAddress(): string | null {
    return this.savedAddress;
  }

  sendLobbySettings(sidePreference: SidePreference, timeControlId: TimeControlId): void {
    this.lobbyCalls.push({ type: 'settings', sidePreference, timeControlId });
    this.setState({ ...this.state, pendingCommand: 'settings', lastRejection: null });
  }

  sendLobbyLock(locked: boolean): void {
    this.lobbyCalls.push({ type: 'lock', locked });
    this.setState({ ...this.state, pendingCommand: 'lock', lastRejection: null });
  }

  sendLobbyReady(ready: boolean): void {
    this.lobbyCalls.push({ type: 'ready', ready });
    this.setState({ ...this.state, pendingCommand: 'ready', lastRejection: null });
  }

  sendLobbyStart(): void {
    this.lobbyCalls.push({ type: 'start' });
    this.setState({ ...this.state, pendingCommand: 'start', lastRejection: null });
  }

  sendLobbyReturn(_intent: 'return-lobby' | 'rematch'): void {}

  sendGameAction(_action: MatchAction): { ok: boolean; reason?: string } {
    return { ok: true };
  }

  requestGameSync(): void {}

  emit(state: Partial<ConnectionState>): void {
    this.setState({ ...this.state, ...state });
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) {
      listener(state);
    }
  }
}

/** 大厅快照夹具：用真实状态机生成，避免与领域逻辑脱节。 */
function withLobby(state: LobbyState, commands: Parameters<typeof applyLobbyCommand>[1][]): LobbyState {
  let current = state;
  for (const command of commands) {
    const result = applyLobbyCommand(current, command);
    if (!result.ok) {
      throw new Error(`lobby fixture rejected: ${result.code}`);
    }
    current = result.state;
  }
  return current;
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
}

function connectionFactory(): { connections: FakeConnection[]; createClient: () => RoomConnection } {
  const connections: FakeConnection[] = [];
  return {
    connections,
    createClient: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('main menu', () => {
  it('renders the entries, version and navigates to the local game', async () => {
    const api = fakeApi();
    const { createClient } = connectionFactory();

    render(<RoomApp api={api} createClient={createClient} storage={memoryStorage()} />);

    expect(screen.getByTestId('menu-create')).toBeInTheDocument();
    expect(screen.getByTestId('menu-join')).toBeInTheDocument();
    expect(screen.getByTestId('menu-local')).toBeInTheDocument();
    expect(screen.getByTestId('menu-settings')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.7.0');

    fireEvent.click(screen.getByTestId('menu-local'));
    await waitFor(() => expect(window.location.hash).toBe('#/local'));
    window.location.hash = '';
  });
});

describe('create room flow', () => {
  it('creates a room, shows the shareable address and copies it', async () => {
    const api = fakeApi();
    const { connections, createClient } = connectionFactory();

    render(<RoomApp api={api} createClient={createClient} storage={memoryStorage()} />);
    fireEvent.click(screen.getByTestId('menu-create'));

    await waitFor(() => expect(screen.getByTestId('room-address-main')).toHaveTextContent('192.168.1.5:8080'));
    expect(api.createCalls).toEqual([8080]);
    expect(screen.getByText(/请让对手与你连接同一 Wi-Fi\/局域网/)).toBeInTheDocument();
    expect(connections[0].connectCalls[0]).toMatchObject({
      address: { host: '127.0.0.1', port: 8080 },
      options: { role: 'host', token: 'token-abc' },
    });

    fireEvent.click(screen.getByTestId('copy-address'));
    await waitFor(() => expect(screen.getByTestId('copy-address')).toHaveTextContent('已复制 ✓'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('192.168.1.5:8080');

    // 多网卡时可展开候选地址列表。
    fireEvent.click(screen.getByTestId('toggle-candidates'));
    expect(screen.getByTestId('candidate-list')).toHaveTextContent('10.0.0.9:8080');
  });

  it('shows members while waiting and closes the room behind a confirmation dialog', async () => {
    const api = fakeApi();
    const { connections, createClient } = connectionFactory();

    render(<RoomApp api={api} createClient={createClient} storage={memoryStorage()} />);
    fireEvent.click(screen.getByTestId('menu-create'));
    await waitFor(() => expect(screen.getByTestId('member-host')).toBeInTheDocument());

    expect(screen.getByTestId('member-guest-pending')).toHaveTextContent('等待加入');

    // 房主连接后成员列表带连接状态。
    act(() => {
      connections[0].emit({
        status: 'connected',
        memberId: 'host-1',
        roomId: 'room1234',
        members: [HOST_MEMBER],
      });
    });
    expect(screen.getByTestId('member-host')).toHaveTextContent('在线');

    fireEvent.click(screen.getByTestId('close-room'));
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-no'));
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(api.closeCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId('close-room'));
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(api.closeCalls).toEqual(['token-abc']));
    await waitFor(() => expect(screen.getByTestId('menu-toast')).toHaveTextContent('房间已关闭'));
  });

  it('surfaces create failures with an actionable message and a retry', async () => {
    const api = fakeApi({
      createRoom: async () => ({
        ok: false,
        code: 'HOST_UNAVAILABLE',
        message: '本机未运行建房服务 —— 请在房主电脑上运行 npm run dev',
      }),
    });
    const { createClient } = connectionFactory();

    render(<RoomApp api={api} createClient={createClient} storage={memoryStorage()} />);
    fireEvent.click(screen.getByTestId('menu-create'));

    await waitFor(() => expect(screen.getByTestId('create-error')).toHaveTextContent('本机未运行建房服务'));
    expect(screen.getByTestId('create-retry')).toBeInTheDocument();
  });

  it('reports the real port when the preferred one was busy', async () => {
    const api = fakeApi({
      createRoom: async () => ({ ok: true, value: fakeRoom({ port: 8081 }) }),
    });
    const { createClient } = connectionFactory();

    render(<RoomApp api={api} createClient={createClient} storage={memoryStorage()} />);
    fireEvent.click(screen.getByTestId('menu-create'));

    await waitFor(() => expect(screen.getByTestId('room-port-fallback')).toHaveTextContent('8081'));
  });
});

describe('join room flow', () => {
  it('validates the address before connecting and shows specific failure copy', async () => {
    const { connections, createClient } = connectionFactory();
    const storage = memoryStorage();

    render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage={false}
        initialAddress=""
        onExit={() => undefined}
        storage={storage}
      />,
    );

    fireEvent.change(screen.getByTestId('join-address-input'), { target: { value: '192.168.1.5' } });
    fireEvent.click(screen.getByTestId('join-submit'));
    expect(screen.getByTestId('join-error')).toHaveTextContent('缺少端口');
    expect(connections).toHaveLength(1);
    expect(connections[0].connectCalls).toHaveLength(0);

    fireEvent.change(screen.getByTestId('join-address-input'), { target: { value: ' 192.168.1.5:8080 ' } });
    fireEvent.click(screen.getByTestId('join-submit'));
    expect(connections[0].connectCalls[0]).toMatchObject({ address: { host: '192.168.1.5', port: 8080 }, options: { role: 'guest' } });

    act(() => {
      connections[0].emit({
        status: 'error',
        errorCode: 'ROOM_FULL',
        message: '房间已关闭或人数已满 —— 一个房间当前只支持一位客人 —— 请让房主先移出离线成员，或稍后再试',
      });
    });
    expect(screen.getByTestId('join-connection-error')).toHaveTextContent('房间已关闭或人数已满');
  });

  it('shows the waiting copy after three seconds while connecting', async () => {
    vi.useFakeTimers();
    const { connections, createClient } = connectionFactory();

    render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage={false}
        initialAddress="192.168.1.5:8080"
        onExit={() => undefined}
        storage={memoryStorage()}
      />,
    );

    fireEvent.click(screen.getByTestId('join-submit'));
    expect(screen.getByTestId('join-progress')).toHaveTextContent('正在连接房间');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('join-progress')).toHaveTextContent('仍在尝试连接');
    expect(connections[0].connectCalls).toHaveLength(1);
  });

  it('enters the member view after joining and returns to the form after leaving', async () => {
    const { connections, createClient } = connectionFactory();

    render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage={false}
        initialAddress="192.168.1.5:8080"
        onExit={() => undefined}
        storage={memoryStorage()}
      />,
    );

    fireEvent.click(screen.getByTestId('join-submit'));
    act(() => {
      connections[0].emit({
        status: 'connected',
        memberId: 'guest-1',
        roomId: 'room1234',
        members: [HOST_MEMBER, GUEST_MEMBER],
      });
    });

    expect(screen.getByTestId('member-host')).toHaveTextContent('房主');
    expect(screen.getByTestId('member-guest')).toHaveTextContent('客人');

    fireEvent.click(screen.getByTestId('leave-room'));
    fireEvent.click(screen.getByTestId('confirm-yes'));
    await waitFor(() => expect(connections[0].disconnectCalls).toBe(1));
    expect(screen.getByTestId('join-submit')).toBeInTheDocument();
  });

  it('keeps the address and explains the closure when the host closes the room', async () => {
    const { connections, createClient } = connectionFactory();

    render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage={false}
        initialAddress="192.168.1.5:8080"
        onExit={() => undefined}
        storage={memoryStorage()}
      />,
    );

    fireEvent.click(screen.getByTestId('join-submit'));
    act(() => {
      connections[0].emit({ status: 'connected', memberId: 'guest-1', roomId: 'room1234', members: [HOST_MEMBER, GUEST_MEMBER] });
    });
    act(() => {
      connections[0].emit({ status: 'disconnected', closedReason: 'host-closed', message: '房主已关闭房间' });
    });

    expect(screen.getByTestId('room-closed-notice')).toHaveTextContent('房主已关闭房间');
    expect(screen.getByTestId('join-address-input')).toHaveValue('192.168.1.5:8080');
  });

  it('saves recent rooms after a successful handshake and fills the address on click', async () => {
    const storage = memoryStorage();
    const { connections, createClient } = connectionFactory();

    const { unmount } = render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage={false}
        initialAddress="192.168.1.5:8080"
        onExit={() => undefined}
        storage={storage}
      />,
    );

    fireEvent.click(screen.getByTestId('join-submit'));
    act(() => {
      connections[0].emit({ status: 'connected', memberId: 'guest-1', roomId: 'room1234', members: [HOST_MEMBER, GUEST_MEMBER] });
    });
    await waitFor(() => expect(storage.data.get('flip-xiangqi.recent-rooms')).toContain('192.168.1.5:8080'));
    unmount();

    const next = connectionFactory();
    render(
      <JoinRoomScreen
        createClient={next.createClient}
        guestPage={false}
        initialAddress=""
        onExit={() => undefined}
        storage={storage}
      />,
    );

    expect(screen.getByTestId('recent-rooms')).toHaveTextContent('192.168.1.5:8080');
    fireEvent.click(screen.getByTestId('recent-room-item'));
    expect(screen.getByTestId('join-address-input')).toHaveValue('192.168.1.5:8080');
  });

  it('shows the empty state and prefills the shared address on a room page', () => {
    const { createClient } = connectionFactory();

    render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage
        initialAddress="192.168.1.5:8080"
        onExit={() => undefined}
        storage={memoryStorage()}
      />,
    );

    expect(screen.getByTestId('recent-empty')).toBeInTheDocument();
    expect(screen.getByTestId('join-address-input')).toHaveValue('192.168.1.5:8080');
    expect(screen.getByText(/你正在打开房主分享的地址/)).toBeInTheDocument();
  });

  it('displays connection banner and disables lobby controls during reconnection while keeping exit available', async () => {
    const { connections, createClient } = connectionFactory();

    render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage={false}
        initialAddress="192.168.1.5:8080"
        onExit={() => undefined}
        storage={memoryStorage()}
      />,
    );

    fireEvent.click(screen.getByTestId('join-submit'));
    act(() => {
      connections[0].emit({
        status: 'connected',
        memberId: 'guest-1',
        roomId: 'room1234',
        role: 'guest',
        members: [HOST_MEMBER, GUEST_MEMBER],
        lobby: createLobbyState(),
      });
    });

    expect(screen.queryByTestId('connection-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('lobby-ready-toggle')).not.toBeDisabled();

    // 触发重连中状态
    act(() => {
      connections[0].emit({
        status: 'reconnecting',
        reconnecting: true,
      });
    });

    // 横幅展示
    expect(screen.getByTestId('connection-banner')).toBeInTheDocument();
    expect(screen.getByTestId('connection-banner')).toHaveTextContent('与房间的连接已断开，正在重连…');

    // 指示灯显示断线红灯
    expect(screen.getByTestId('connection-lamp')).toHaveClass('connection-lamp-red');

    // 大厅准备等操作控件被禁用
    expect(screen.getByTestId('lobby-ready-toggle')).toBeDisabled();

    // 点击手动重连按钮调用 reconnect
    fireEvent.click(screen.getByTestId('reconnect-button'));
    expect(connections[0].reconnectCalls).toBe(1);

    // 退出房间入口依然可用
    expect(screen.getByTestId('leave-room')).not.toBeDisabled();

    // 重连成功后横幅消失，出现已重新连接 toast 与绿灯
    act(() => {
      connections[0].emit({
        status: 'connected',
        reconnecting: false,
        justReconnected: true,
        rtt: 45,
      });
    });

    expect(screen.queryByTestId('connection-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('reconnected-toast')).toHaveTextContent('已重新连接 ✓');
    expect(screen.getByTestId('connection-rtt')).toHaveTextContent('45ms');
    expect(screen.getByTestId('connection-lamp')).toHaveClass('connection-lamp-green');
  });
});

describe('room lobby', () => {
  async function connectHost(lobby: LobbyState = createLobbyState()): Promise<FakeConnection> {
    const api = fakeApi();
    const { connections, createClient } = connectionFactory();
    render(<RoomApp api={api} createClient={createClient} storage={memoryStorage()} />);
    fireEvent.click(screen.getByTestId('menu-create'));
    await waitFor(() => expect(screen.getByTestId('member-host')).toBeInTheDocument());
    act(() => {
      connections[0].emit({
        status: 'connected',
        memberId: 'host-1',
        roomId: 'room1234',
        role: 'host',
        members: [HOST_MEMBER, GUEST_MEMBER],
        lobby,
      });
    });
    return connections[0];
  }

  async function connectGuest(lobby: LobbyState = createLobbyState()): Promise<FakeConnection> {
    const { connections, createClient } = connectionFactory();
    render(
      <JoinRoomScreen
        createClient={createClient}
        guestPage={false}
        initialAddress="192.168.1.5:8080"
        onExit={() => undefined}
        storage={memoryStorage()}
      />,
    );
    fireEvent.click(screen.getByTestId('join-submit'));
    act(() => {
      connections[0].emit({
        status: 'connected',
        memberId: 'guest-1',
        roomId: 'room1234',
        role: 'guest',
        members: [HOST_MEMBER, GUEST_MEMBER],
        lobby,
      });
    });
    return connections[0];
  }

  function readyLobbyFixture(sidePreference: 'host-red' | 'random' = 'random'): LobbyState {
    return withLobby(createLobbyState(), [
      { type: 'member-joined', role: 'host' },
      { type: 'member-joined', role: 'guest' },
      { type: 'update-settings', actor: 'host', sidePreference, timeControlId: 'standard' },
      { type: 'set-ready', actor: 'host', ready: true, settingsVersion: 2 },
      { type: 'set-ready', actor: 'guest', ready: true, settingsVersion: 2 },
    ]);
  }

  it('lets the host change sides and time control and reflects synced state on both ends', async () => {
    const connection = await connectHost();

    // 随机分先在开局前显示「待开局确定」。
    expect(screen.getByTestId('side-summary')).toHaveTextContent('待开局确定');

    fireEvent.click(screen.getByTestId('setting-side-host-red'));
    expect(connection.lobbyCalls).toEqual([{ type: 'settings', sidePreference: 'host-red', timeControlId: 'none' }]);

    // 服务端权威状态回到两端：分配立即呈现。
    const afterSide = withLobby(createLobbyState(), [
      { type: 'member-joined', role: 'host' },
      { type: 'member-joined', role: 'guest' },
      { type: 'update-settings', actor: 'host', sidePreference: 'host-red', timeControlId: 'none' },
    ]);
    act(() => {
      connection.emit({ lobby: afterSide, pendingCommand: null });
    });
    expect(screen.getByTestId('setting-side-host-red')).toBeChecked();
    expect(screen.getByTestId('side-summary')).toHaveTextContent('房主：红方 · 客人：黑方');
    expect(screen.getByTestId('member-side-host')).toHaveTextContent('红方');
    expect(screen.getByTestId('member-side-guest')).toHaveTextContent('黑方');

    fireEvent.click(screen.getByTestId('setting-time-standard'));
    expect(connection.lobbyCalls[1]).toEqual({ type: 'settings', sidePreference: 'host-red', timeControlId: 'standard' });

    // 在途请求未回执前锁定按钮防连点；回执后恢复可点。
    expect(screen.getByTestId('settings-lock')).toBeDisabled();
    act(() => {
      connection.emit({ pendingCommand: null });
    });
    fireEvent.click(screen.getByTestId('settings-lock'));
    expect(connection.lobbyCalls[2]).toEqual({ type: 'lock', locked: true });
    act(() => {
      connection.emit({ lobby: withLobby(afterSide, [{ type: 'set-locked', actor: 'host', locked: true }]), pendingCommand: null });
    });
    expect(screen.getByTestId('settings-locked-note')).toHaveTextContent('设置已锁定');
  });

  it('shows the guest a read-only synchronized view', async () => {
    const connection = await connectGuest();

    expect(screen.getByTestId('settings-readonly-note')).toBeInTheDocument();
    expect(screen.getByTestId('setting-side-host-red')).toBeDisabled();
    expect(screen.getByTestId('setting-time-none')).toBeDisabled();
    expect(screen.queryByTestId('settings-lock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lobby-start')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('setting-side-host-red'));
    expect(connection.lobbyCalls).toEqual([]);

    // 房主的改动同步到客人端，只读视图随之更新。
    const synced = withLobby(createLobbyState(), [
      { type: 'member-joined', role: 'host' },
      { type: 'member-joined', role: 'guest' },
      { type: 'update-settings', actor: 'host', sidePreference: 'host-black', timeControlId: 'blitz' },
    ]);
    act(() => {
      connection.emit({ lobby: synced });
    });
    expect(screen.getByTestId('setting-side-host-black')).toBeChecked();
    expect(screen.getByTestId('setting-time-blitz')).toBeChecked();
    // 客人文案按自身身份换算：房主执黑 = 你执红。
    expect(screen.getByTestId('setting-side-host-black')).toHaveAccessibleName('执红先行');
    expect(screen.getByTestId('side-summary')).toHaveTextContent('房主：黑方 · 客人：红方');
  });

  it('blocks the start until both players are ready and explains every rejection', async () => {
    const connection = await connectHost();

    expect(screen.getByTestId('lobby-start-hint')).toHaveTextContent('等待双方准备');

    fireEvent.click(screen.getByTestId('lobby-ready-toggle'));
    expect(connection.lobbyCalls).toEqual([{ type: 'ready', ready: true }]);

    const hostReady = withLobby(createLobbyState(), [
      { type: 'member-joined', role: 'host' },
      { type: 'member-joined', role: 'guest' },
      { type: 'update-settings', actor: 'host', sidePreference: 'random', timeControlId: 'standard' },
      { type: 'set-ready', actor: 'host', ready: true, settingsVersion: 2 },
    ]);
    act(() => {
      connection.emit({ lobby: hostReady, pendingCommand: null });
    });
    expect(screen.getByTestId('lobby-ready-toggle')).toHaveTextContent('取消准备');
    expect(screen.getByTestId('member-ready-host')).toHaveTextContent('已准备');
    expect(screen.getByTestId('lobby-start-hint')).toHaveTextContent('等待双方准备');

    // 开始请求照常发出，由服务端门禁裁决；拒绝以可行动文案呈现。
    fireEvent.click(screen.getByTestId('lobby-start'));
    expect(connection.lobbyCalls[1]).toEqual({ type: 'start' });
    act(() => {
      connection.emit({
        pendingCommand: null,
        lastRejection: { code: 'NOT_READY', message: '还不能开始对局 —— 需要双方都已准备 —— 等待双方准备' },
      });
    });
    expect(screen.getByTestId('lobby-notice')).toHaveTextContent('等待双方准备');

    act(() => {
      connection.emit({ lobby: readyLobbyFixture('random'), pendingCommand: null, lastRejection: null });
    });
    expect(screen.getByTestId('lobby-start-hint')).toHaveTextContent('双方已就绪，可以开始对局');
    expect(screen.getByTestId('lobby-start')).toHaveClass('panel-action-gold');
  });

  it('prevents double submits while a request is in flight', async () => {
    const connection = await connectHost();

    fireEvent.click(screen.getByTestId('lobby-ready-toggle'));
    expect(screen.getByTestId('lobby-ready-toggle')).toBeDisabled();
    expect(screen.getByTestId('lobby-start')).toBeDisabled();

    act(() => {
      connection.emit({ pendingCommand: null });
    });
    expect(screen.getByTestId('lobby-ready-toggle')).not.toBeDisabled();
  });

  it('shows the frozen start parameters once the game begins', async () => {
    const started = withLobby(createLobbyState(), [
      { type: 'member-joined', role: 'host' },
      { type: 'member-joined', role: 'guest' },
      { type: 'update-settings', actor: 'host', sidePreference: 'host-red', timeControlId: 'standard' },
      { type: 'set-ready', actor: 'host', ready: true, settingsVersion: 2 },
      { type: 'set-ready', actor: 'guest', ready: true, settingsVersion: 2 },
      {
        type: 'start',
        actor: 'host',
        roomId: 'room1234',
        host: { memberId: 'host-1', name: '房主' },
        guest: { memberId: 'guest-1', name: '客人' },
        hostRedWhenRandom: null,
      },
    ]);
    await connectHost(started);

    expect(screen.getByTestId('lobby-started')).toHaveTextContent('你执红，对手执黑 · 局时 20 分 + 60 秒（标准局）');
    expect(screen.getByTestId('start-snapshot')).toHaveTextContent('房主执红 · 客人执黑');
    expect(screen.getByTestId('start-snapshot')).toHaveTextContent('设置版本 v2');
    expect(screen.queryByTestId('lobby-ready-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lobby-start')).not.toBeInTheDocument();
    expect(screen.getByTestId('member-side-host')).toHaveTextContent('红方');
    expect(screen.getByTestId('setting-side-host-red')).toBeDisabled();
  });

  it('renders ready lamps and leave reasons on the member cards', async () => {
    const connection = await connectHost();
    expect(screen.getByTestId('member-ready-host')).toHaveTextContent('未准备');

    act(() => {
      connection.emit({
        lobby: readyLobbyFixture('random'),
        members: [HOST_MEMBER, { ...GUEST_MEMBER, connected: false, leaveReason: 'dropped' }],
      });
    });
    expect(screen.getByTestId('member-ready-host')).toHaveTextContent('已准备');
    expect(screen.getByTestId('member-ready-guest')).toHaveTextContent('已准备');
    expect(screen.getByTestId('member-guest')).toHaveTextContent('已掉线');
    expect(screen.getByTestId('member-side-guest')).toHaveTextContent('待开局确定');
  });
});
