import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OnlineApp from '../../OnlineApp';
import type { ConnectionState, RoomClient } from '../../network/client';
import type { OnlineApi, OnlineApiResult, OnlineRoomCreated } from '../../network/online-api';
import { createLobbyState } from '../../network/lobby';
import { IDLE_CONNECTION_STATE } from '../rooms/connection-state';

class FakeOnlineClient {
  state: ConnectionState = { ...IDLE_CONNECTION_STATE };
  readonly listeners = new Set<(state: ConnectionState) => void>();
  readonly connectOnline = vi.fn((_roomId: string) => {
    this.emit({ ...this.state, status: 'connecting' });
  });
  readonly disconnect = vi.fn((_notify?: boolean) => {
    this.emit({ ...IDLE_CONNECTION_STATE, status: 'disconnected' });
  });
  readonly sendLobbyReady = vi.fn();
  readonly sendLobbyStart = vi.fn();
  readonly sendLobbySettings = vi.fn();
  readonly sendLobbyLock = vi.fn();
  readonly sendLobbyReturn = vi.fn();
  readonly sendGameAction = vi.fn();
  readonly sendGameNegotiate = vi.fn();
  readonly sendGameNegotiateReply = vi.fn();
  readonly sendGameResign = vi.fn();
  readonly requestGameSync = vi.fn();
  readonly sendChatPhrase = vi.fn();
  readonly reconnect = vi.fn();
  readonly getAddress = vi.fn(() => null);

  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  emit(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) {
      listener(state);
    }
  }
}

function fakeApi(overrides: Partial<OnlineApi> = {}): OnlineApi {
  return {
    ensureSession: vi.fn(async (): Promise<OnlineApiResult<{ created: boolean }>> => ({ ok: true, value: { created: false } })),
    resetSession: vi.fn(async () => ({ ok: true as const, value: { reset: true as const } })),
    createRoom: vi.fn(
      async (): Promise<OnlineApiResult<OnlineRoomCreated>> => ({
        ok: true,
        value: { roomId: 'room-12345678', url: `https://localhost/online/rooms/room-12345678`, created: true, closed: false },
      }),
    ),
    closeRoom: vi.fn(async () => true),
    ...overrides,
  };
}

function renderOnline(api: OnlineApi, client: FakeOnlineClient, strict = false) {
  const tree = <OnlineApp api={api} createClient={() => client as unknown as RoomClient} />;
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/online');
});

describe('在线入口页面', () => {
  it('建立匿名会话后创建房间，切换到房间地址并接入同源房间', async () => {
    const client = new FakeOnlineClient();
    const api = fakeApi();
    renderOnline(api, client);

    const create = await screen.findByTestId('online-create-room');
    await act(async () => {
      fireEvent.click(create);
    });

    await waitFor(() => expect(client.connectOnline).toHaveBeenCalledWith('room-12345678'));
    expect(api.createRoom).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/online/rooms/room-12345678');
    expect(screen.getByTestId('online-invite-url').textContent).toContain('/online/rooms/room-12345678');
    // 邀请链接只含公开房间号。
    expect(screen.getByTestId('online-invite-url').textContent).not.toMatch(/token|key/);
  });

  it('建房失败时展示错误并允许用同一请求编号重试', async () => {
    const client = new FakeOnlineClient();
    const createRoom = vi
      .fn<OnlineApi['createRoom']>()
      .mockResolvedValueOnce({ ok: false, code: 'NETWORK', message: '无法连接在线入口 —— 请检查网络后重试' })
      .mockResolvedValueOnce({
        ok: true,
        value: { roomId: 'room-87654321', url: 'https://localhost/online/rooms/room-87654321', created: true, closed: false },
      });
    const api = fakeApi({ createRoom });
    renderOnline(api, client);

    const create = await screen.findByTestId('online-create-room');
    await act(async () => {
      fireEvent.click(create);
    });
    expect(await screen.findByTestId('online-error')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('online-create-room'));
    });
    await waitFor(() => expect(client.connectOnline).toHaveBeenCalledWith('room-87654321'));

    const firstRequest = createRoom.mock.calls[0]![0];
    const secondRequest = createRoom.mock.calls[1]![0];
    // 同一次建房意图的重试复用同一个 requestId，服务端不会产生第二个房间。
    expect(secondRequest).toBe(firstRequest);
  });

  it('凭房间号或邀请链接加入，并拒绝无效输入', async () => {
    const client = new FakeOnlineClient();
    const api = fakeApi();
    renderOnline(api, client);

    const input = await screen.findByTestId('online-room-input');
    fireEvent.change(input, { target: { value: 'bad' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('online-join-room'));
    });
    expect(await screen.findByTestId('online-error')).toHaveTextContent('请输入有效的房间号或邀请链接');
    expect(client.connectOnline).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'https://localhost/online/rooms/room-abcdefgh' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('online-join-room'));
    });
    await waitFor(() => expect(client.connectOnline).toHaveBeenCalledWith('room-abcdefgh'));
  });

  it('匿名凭据失效时提示原席位不可恢复，并支持显式开始新会话', async () => {
    const client = new FakeOnlineClient();
    const api = fakeApi({
      ensureSession: vi.fn(async () => ({ ok: false as const, code: 'SESSION_INVALID' as const, message: '失效' })),
    });
    renderOnline(api, client);

    expect(await screen.findByTestId('online-session-error')).toHaveTextContent('原席位无法恢复');
    await act(async () => {
      fireEvent.click(screen.getByTestId('online-session-reset'));
    });

    expect(api.resetSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('online-create-room')).toBeInTheDocument();
  });

  it('只通过同源 API 取匿名会话，不接触 LAN 控制接口', async () => {
    const client = new FakeOnlineClient();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const api = fakeApi();
    renderOnline(api, client);

    await screen.findByTestId('online-create-room');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.ensureSession).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('就绪/开始操作交给在线客户端，退出时显式离开，卸载时只释放传输', async () => {
    const client = new FakeOnlineClient();
    const api = fakeApi();
    const lobby = createLobbyState();
    const view = renderOnline(api, client);

    const create = await screen.findByTestId('online-create-room');
    await act(async () => {
      fireEvent.click(create);
    });
    await waitFor(() => expect(client.connectOnline).toHaveBeenCalledWith('room-12345678'));
    act(() => {
      client.emit({
        ...IDLE_CONNECTION_STATE,
        status: 'connected',
        roomId: 'room-12345678',
        memberId: 'member-1',
        role: 'host',
        members: [{ id: 'member-1', role: 'host', name: '房主', connected: true }],
        lobby,
      });
    });

    await act(async () => {
      fireEvent.click(await screen.findByTestId('lobby-ready-toggle'));
    });
    expect(client.sendLobbyReady).toHaveBeenCalledWith(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId('online-leave-room'));
    });
    await act(async () => {
      const confirmButtons = screen.getAllByRole('button', { name: '退出房间' });
      fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(api.closeRoom).toHaveBeenCalledWith('room-12345678');
    expect(window.location.pathname).toBe('/online');

    client.disconnect.mockClear();
    view.unmount();
    expect(client.disconnect).toHaveBeenCalledWith(false);
  });

  it('StrictMode 下重复挂载不会重复建房或留下多个连接', async () => {
    const client = new FakeOnlineClient();
    const api = fakeApi();
    renderOnline(api, client, true);

    const create = await screen.findByTestId('online-create-room');
    await act(async () => {
      fireEvent.click(create);
    });

    await waitFor(() => expect(client.connectOnline).toHaveBeenCalledWith('room-12345678'));
    expect(api.createRoom).toHaveBeenCalledTimes(1);
    expect(client.connectOnline).toHaveBeenCalledTimes(1);
  });
});
