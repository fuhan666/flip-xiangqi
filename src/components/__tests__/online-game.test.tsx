import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineGame } from '../OnlineGame.js';
import type { ConnectionState, RoomConnection } from '../../network/client.js';
import { buildStartParameters, createLobbyState } from '../../network/lobby.js';
import { createMatch, snapshotMatch } from '../../network/match.js';
import { IDLE_CONNECTION_STATE } from '../rooms/connection-state.js';

describe('OnlineGame component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestMatch(hostRed = true) {
    const startParameters = buildStartParameters({
      roomId: 'room-1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: hostRed ? 'host-red' : 'host-black', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: hostRed ? 'red' : 'black',
    });
    const match = createMatch({ matchId: 'm1', seed: 12345, startParameters });
    return { startParameters, match, snapshot: snapshotMatch(match) };
  }

  it('renders start summary, snapshot, turn indicator, step counter, and shuffling banner', () => {
    const { startParameters, snapshot } = createTestMatch(true);
    const lobby = createLobbyState();
    lobby.phase = 'started';
    lobby.startParameters = startParameters;

    const connection: ConnectionState = {
      ...IDLE_CONNECTION_STATE,
      status: 'connected',
      roomId: 'room-1',
      memberId: 'host-1',
      role: 'host',
      lobby,
      game: {
        matchId: 'm1',
        seed: 12345,
        stepNumber: 0,
        startParameters,
        confirmedState: snapshot.gameState,
        displayState: snapshot.gameState,
        pendingAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: null,
      },
    };

    const mockClient = {
      sendGameAction: vi.fn().mockReturnValue({ ok: true }),
      requestGameSync: vi.fn(),
    } as unknown as RoomConnection;

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    // 兼容已有断言
    expect(screen.getByTestId('lobby-started')).toHaveTextContent('你执红，对手执黑');
    expect(screen.getByTestId('start-snapshot')).toHaveTextContent('房主执红 · 客人执黑');
    expect(screen.getByTestId('turn-indicator')).toHaveTextContent('轮到你（红方）');
    expect(screen.getByTestId('step-number')).toHaveTextContent('第 0 步');

    // ≤0.5 秒「洗牌中…」提示出现
    expect(screen.getByTestId('shuffling-banner')).toBeInTheDocument();
    expect(screen.getByTestId('shuffling-banner')).toHaveTextContent('洗牌中…');

    // 350ms 后自动隐藏
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByTestId('shuffling-banner')).not.toBeInTheDocument();
  });

  it('displays rejection notice "你的操作未被采纳，请重新操作" when statusNotice is set', () => {
    const { startParameters, snapshot } = createTestMatch(true);
    const lobby = createLobbyState();
    lobby.phase = 'started';
    lobby.startParameters = startParameters;

    const connection: ConnectionState = {
      ...IDLE_CONNECTION_STATE,
      status: 'connected',
      roomId: 'room-1',
      memberId: 'host-1',
      role: 'host',
      lobby,
      game: {
        matchId: 'm1',
        seed: 12345,
        stepNumber: 0,
        startParameters,
        confirmedState: snapshot.gameState,
        displayState: snapshot.gameState,
        pendingAction: null,
        lastError: '非法操作',
        lastRejectedReason: '非法操作',
        statusNotice: '你的操作未被采纳，请重新操作',
        lastAcceptedAction: null,
      },
    };

    const mockClient = {
      sendGameAction: vi.fn().mockReturnValue({ ok: true }),
      requestGameSync: vi.fn(),
    } as unknown as RoomConnection;

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    const notice = screen.getByTestId('online-rejection-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent('你的操作未被采纳，请重新操作');
  });

  it('disallows interaction when it is not player turn', () => {
    // 房主为黑方（客人为红方，先手）
    const { startParameters, snapshot } = createTestMatch(false);
    const lobby = createLobbyState();
    lobby.phase = 'started';
    lobby.startParameters = startParameters;

    const connection: ConnectionState = {
      ...IDLE_CONNECTION_STATE,
      status: 'connected',
      roomId: 'room-1',
      memberId: 'host-1',
      role: 'host',
      lobby,
      game: {
        matchId: 'm1',
        seed: 12345,
        stepNumber: 0,
        startParameters,
        confirmedState: snapshot.gameState,
        displayState: snapshot.gameState,
        pendingAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: null,
      },
    };

    const mockClient = {
      sendGameAction: vi.fn().mockReturnValue({ ok: true }),
      requestGameSync: vi.fn(),
    } as unknown as RoomConnection;

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    expect(screen.getByTestId('turn-indicator')).toHaveTextContent('等待对方行动');

    // 找到一个暗子格子
    const hiddenPiece = snapshot.gameState.pieces.find((p) => !p.revealed && p.position !== null)!;
    const cellBtn = screen.getByTestId(`cell-${hiddenPiece.position!.x}-${hiddenPiece.position!.y}`);

    fireEvent.click(cellBtn);

    // 非己方回合，不应发起网络请求
    expect(mockClient.sendGameAction).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('当前非己方回合，请等待对方行动');
  });

  it('covers full pending -> reject -> retry interaction chain and visible players bar', () => {
    const { startParameters, snapshot } = createTestMatch(true);
    const lobby = createLobbyState();
    lobby.phase = 'started';
    lobby.startParameters = startParameters;

    const mockClient = {
      sendGameAction: vi.fn().mockReturnValue({ ok: true }),
      requestGameSync: vi.fn(),
    } as unknown as RoomConnection;

    let connection: ConnectionState = {
      ...IDLE_CONNECTION_STATE,
      status: 'connected',
      roomId: 'room-1',
      memberId: 'host-1',
      role: 'host',
      members: [
        { id: 'host-1', role: 'host', name: '房主', connected: true },
        { id: 'guest-1', role: 'guest', name: '客人', connected: true },
      ],
      lobby,
      game: {
        matchId: 'm1',
        seed: 12345,
        stepNumber: 0,
        startParameters,
        confirmedState: snapshot.gameState,
        displayState: snapshot.gameState,
        pendingAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: null,
      },
    };

    const { rerender } = render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    // 验证真实可见的席位卡片
    expect(screen.getByTestId('member-host')).toBeVisible();
    expect(screen.getByTestId('member-guest')).toBeVisible();
    expect(screen.getByTestId('member-host')).toHaveTextContent('在线');
    expect(screen.getByTestId('member-guest')).toHaveTextContent('在线');

    // 1. 用户翻开暗子 -> 触发 sendGameAction
    const hiddenPiece = snapshot.gameState.pieces.find((p) => !p.revealed && p.position !== null)!;
    const cellBtn = screen.getByTestId(`cell-${hiddenPiece.position!.x}-${hiddenPiece.position!.y}`);
    fireEvent.click(cellBtn);
    expect(mockClient.sendGameAction).toHaveBeenCalledWith({ type: 'flip', position: hiddenPiece.position! });

    // 2. 模拟进入 pending 状态
    connection = {
      ...connection,
      game: {
        ...connection.game!,
        pendingAction: { requestId: 'req-1', stepNumber: 0, action: { type: 'flip', position: hiddenPiece.position! } },
      },
    };
    rerender(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);
    expect(screen.getByTestId('online-busy-hint')).toHaveTextContent('正在提交…');

    // 3. 模拟服务端下发拒绝回滚
    connection = {
      ...connection,
      game: {
        ...connection.game!,
        pendingAction: null,
        statusNotice: '你的操作未被采纳，请重新操作',
        lastRejectedReason: '校验失败',
        lastAcceptedAction: null,
      },
    };
    rerender(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);
    expect(screen.getByTestId('online-rejection-notice')).toHaveTextContent('你的操作未被采纳，请重新操作');
    expect(screen.queryByTestId('online-busy-hint')).not.toBeInTheDocument();

    // 4. 用户重试操作 -> 再次允许发送
    fireEvent.click(cellBtn);
    expect(mockClient.sendGameAction).toHaveBeenCalledTimes(2);
  });

  it('adapts perspective and player info bars correctly when player is black vs red', () => {
    // 房主为黑方（客人为红方）
    const { startParameters, snapshot } = createTestMatch(false);
    const lobby = createLobbyState();
    lobby.phase = 'started';
    lobby.startParameters = startParameters;

    const connection: ConnectionState = {
      ...IDLE_CONNECTION_STATE,
      status: 'connected',
      roomId: 'room-1',
      memberId: 'host-1',
      role: 'host',
      members: [
        { id: 'host-1', role: 'host', name: '房主', connected: true },
        { id: 'guest-1', role: 'guest', name: '客人', connected: true },
      ],
      lobby,
      game: {
        matchId: 'm1',
        seed: 12345,
        stepNumber: 0,
        startParameters,
        confirmedState: snapshot.gameState,
        displayState: snapshot.gameState,
        pendingAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: null,
      },
    };

    const mockClient = {
      sendGameAction: vi.fn().mockReturnValue({ ok: true }),
      requestGameSync: vi.fn(),
    } as unknown as RoomConnection;

    const { container } = render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    // 棋盘数据属性验证为黑方视角
    const board = container.querySelector('.board');
    expect(board).toHaveAttribute('data-perspective', 'black');

    // 顶部对手信息条：客人（执红方）
    const opponentBar = screen.getByTestId('online-opponent-bar');
    expect(opponentBar).toContainElement(screen.getByTestId('member-guest'));
    expect(screen.getByTestId('member-guest')).toHaveTextContent('客人');
    expect(screen.getByTestId('member-guest')).toHaveTextContent('执红方');
    expect(screen.getByTestId('member-guest')).toHaveTextContent('在线');
    expect(opponentBar.querySelector('.connection-status')).toBeInTheDocument();

    // 底部己方信息条：房主（执黑方）
    const selfBar = screen.getByTestId('online-self-bar');
    expect(selfBar).toContainElement(screen.getByTestId('member-host'));
    expect(screen.getByTestId('member-host')).toHaveTextContent('房主');
    expect(screen.getByTestId('member-host')).toHaveTextContent('执黑方');
    expect(screen.getByTestId('member-host')).toHaveTextContent('在线');

    // 当前为红方回合，黑方处于等待置灰状态
    expect(selfBar).toHaveClass('turn-waiting');
    expect(selfBar).toHaveAttribute('data-turn-state', 'waiting');
    expect(screen.getByTestId('turn-indicator')).toHaveTextContent('等待对方行动');

    // 退出按钮在底栏内
    expect(selfBar.querySelector('[data-testid="close-room"]')).toBeInTheDocument();
  });

  it('renders golden glow active state on bottom bar during own turn', () => {
    // 房主为红方（先手）
    const { startParameters, snapshot } = createTestMatch(true);
    const lobby = createLobbyState();
    lobby.phase = 'started';
    lobby.startParameters = startParameters;

    const connection: ConnectionState = {
      ...IDLE_CONNECTION_STATE,
      status: 'connected',
      roomId: 'room-1',
      memberId: 'host-1',
      role: 'host',
      members: [
        { id: 'host-1', role: 'host', name: '房主', connected: true },
        { id: 'guest-1', role: 'guest', name: '客人', connected: true },
      ],
      lobby,
      game: {
        matchId: 'm1',
        seed: 12345,
        stepNumber: 0,
        startParameters,
        confirmedState: snapshot.gameState,
        displayState: snapshot.gameState,
        pendingAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: null,
      },
    };

    const mockClient = {
      sendGameAction: vi.fn().mockReturnValue({ ok: true }),
      requestGameSync: vi.fn(),
    } as unknown as RoomConnection;

    const { container } = render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    // 棋盘数据属性验证为红方视角
    const board = container.querySelector('.board');
    expect(board).toHaveAttribute('data-perspective', 'red');

    // 底部己方信息条：高亮金光 active
    const selfBar = screen.getByTestId('online-self-bar');
    expect(selfBar).toHaveClass('turn-active');
    expect(selfBar).toHaveAttribute('data-turn-state', 'active');
    expect(screen.getByTestId('turn-indicator')).toHaveTextContent('轮到你（红方）');
  });
});

