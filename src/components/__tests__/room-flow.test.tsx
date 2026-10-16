import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RoomApp from '../../RoomApp';
import { JoinRoomScreen } from '../rooms/JoinRoomScreen';
import type { RoomControlApi, RoomCreateResult } from '../../network/control-api';
import type { ConnectionState, JoinOptions, RoomConnection } from '../../network/client';
import type { ParsedAddress } from '../../network/address';
import type { MemberSnapshot } from '../../network/protocol';
import type { StorageLike } from '../../network/recent-rooms';
import { IDLE_CONNECTION_STATE } from '../rooms/connection-state';

const HOST_MEMBER: MemberSnapshot = { id: 'host-1', role: 'host', name: '房主', connected: true };
const GUEST_MEMBER: MemberSnapshot = { id: 'guest-1', role: 'guest', name: '客人', connected: true };

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
    expect(screen.getByTestId('app-version')).toHaveTextContent('v0.7.0-dev');

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
});
