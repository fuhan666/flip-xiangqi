import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineGame } from '../OnlineGame.js';
import type { ConnectionState, GameClientState, RoomConnection } from '../../network/client.js';
import { buildStartParameters, createLobbyState } from '../../network/lobby.js';
import { applyMatchAction, createMatch, finalizeMatch, snapshotMatch, undoMatchAction } from '../../network/match.js';
import { parseRecord } from '../../records/record';
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

  function buildTestGame(startParameters: any, snapshot: any, overrides: Partial<GameClientState> = {}): GameClientState {
    return {
      matchId: 'm1',
      seed: 12345,
      stepNumber: 0,
      revision: 0,
      startParameters,
      confirmedState: snapshot.gameState,
      displayState: snapshot.gameState,
      clock: snapshot.clock,
      settlement: null,
      clockOffsetMs: 0,
      pendingAction: null,
      lastError: null,
      lastRejectedReason: null,
      statusNotice: null,
      lastAcceptedAction: null,
      pendingNegotiation: null,
      drawCooldownUntil: {},
      negotiationEvent: null,
      ...overrides,
    };
  }

  it.each(['resignation', 'draw-agreement', 'match-timeout', 'step-timeout', 'disconnect-timeout'] as const)('exports identical confirmed records for both sides after undo and %s; replay sends nothing', async (reason) => {
    const { startParameters, match } = createTestMatch(true);
    const first = match.gameState.pieces.find((p) => !p.revealed)!.position!;
    const accepted = applyMatchAction(match, startParameters.redMemberId, { type: 'flip', position: first });
    if (!accepted.ok) throw new Error('first flip rejected');
    const second = accepted.match.gameState.pieces.find((p) => !p.revealed)!.position!;
    const speculative = applyMatchAction(accepted.match, startParameters.blackMemberId, { type: 'flip', position: second });
    if (!speculative.ok) throw new Error('second flip rejected');
    const undone = undoMatchAction(speculative.match);
    if (!undone.ok) throw new Error('undo rejected');
    const ended = finalizeMatch(undone.match, reason === 'draw-agreement' ? null : 'red', reason);
    const snapshot = snapshotMatch(ended);
    const lobby = createLobbyState(); lobby.phase = 'started'; lobby.startParameters = startParameters;
    const connection: ConnectionState = { ...IDLE_CONNECTION_STATE, status:'connected', roomId:'room-1', memberId:'host-1', role:'host', lobby,
      game: buildTestGame(startParameters, snapshot, { confirmedState: snapshot.gameState, displayState: speculative.match.gameState, settlement: snapshot.settlement }) };
    const mockClient = { sendGameAction: vi.fn(), sendLobbyReturn: vi.fn(), requestGameSync: vi.fn() } as unknown as RoomConnection;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { rerender } = render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name:'导出棋谱' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name:'复制 JSON' })));
    const firstJSON = writeText.mock.calls[0][0] as string;
    const record = parseRecord(firstJSON);
    expect(record.moves).toHaveLength(1);
    expect(record.result.reason).toBe(reason);
    expect(firstJSON).not.toContain('host-1');
    expect(firstJSON).not.toContain('room-1');
    rerender(<OnlineGame client={mockClient} connection={{ ...connection, memberId:'guest-1', role:'guest' }} onExit={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name:'复制 JSON' })));
    expect(writeText.mock.calls[1][0]).toBe(firstJSON);
    fireEvent.click(screen.getByRole('button', { name:'开始复盘' }));
    expect(screen.queryByTestId('game-result-modal')).not.toBeInTheDocument();
    const viewer = screen.getByTestId('replay-viewer');
    expect(viewer.querySelector('.board')).toHaveAttribute('data-perspective','black');
    fireEvent.keyDown(window, { key:'End' });
    fireEvent.click(viewer.querySelector('[data-testid="cell-4-9"]')!);
    fireEvent.keyDown(window, { key:'ArrowLeft' });
    fireEvent.keyDown(window, { key:'Escape' });
    expect(screen.getByTestId('game-result-modal')).toBeInTheDocument();
    expect(mockClient.sendGameAction).not.toHaveBeenCalled();
    expect(mockClient.sendLobbyReturn).not.toHaveBeenCalled();
    expect(mockClient.requestGameSync).not.toHaveBeenCalled();
  });

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
      game: buildTestGame(startParameters, snapshot),
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
      game: buildTestGame(startParameters, snapshot, {
        lastError: '非法操作',
        lastRejectedReason: '非法操作',
        statusNotice: '你的操作未被采纳，请重新操作',
      }),
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
      game: buildTestGame(startParameters, snapshot),
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
      game: buildTestGame(startParameters, snapshot),
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
      game: buildTestGame(startParameters, snapshot),
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
      game: buildTestGame(startParameters, snapshot),
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

  it('renders clocks, disconnect grace banner, and check toast', () => {
    vi.setSystemTime(10_000);
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
        { id: 'guest-1', role: 'guest', name: '客人', connected: false },
      ],
      lobby,
      game: {
        matchId: 'm1',
        seed: 12345,
        stepNumber: 1,
        revision: 10,
        startParameters,
        confirmedState: { ...snapshot.gameState, checkedCamp: 'black' },
        displayState: { ...snapshot.gameState, checkedCamp: 'black' },
        clock: {
          ...snapshot.clock!,
          paused: true,
          disconnectGrace: {
            hostDeadlineMs: null,
            guestDeadlineMs: 100_000,
            firstDroppedRole: 'guest',
          },
        },
        settlement: null,
        clockOffsetMs: 0,
        pendingAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: null,
        pendingNegotiation: null,
        drawCooldownUntil: {},
        negotiationEvent: null,
      },
    };

    const mockClient = {
      sendGameAction: vi.fn(),
      sendLobbyReturn: vi.fn(),
    } as unknown as RoomConnection;

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    // 时钟存在
    expect(screen.getByTestId('player-clock-red')).toBeInTheDocument();
    expect(screen.getByTestId('player-clock-black')).toBeInTheDocument();

    // 90秒宽限期横幅展示
    expect(screen.getByTestId('disconnect-grace-banner')).toBeInTheDocument();
    expect(screen.getByTestId('disconnect-grace-banner')).toHaveTextContent('90 秒');

    // 将军横幅提示展示
    expect(screen.getByTestId('check-toast')).toBeInTheDocument();
    expect(screen.getByTestId('check-toast')).toHaveTextContent('将军！');

    // 1.5s 后自动隐藏
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.queryByTestId('check-toast')).not.toBeInTheDocument();
  });

  it('renders GameResultDialog on settlement and triggers rematch / return to lobby', () => {
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
        stepNumber: 5,
        revision: 50,
        startParameters,
        confirmedState: snapshot.gameState,
        displayState: snapshot.gameState,
        clock: snapshot.clock,
        settlement: {
          winner: 'red',
          loser: 'black',
          reason: 'step-timeout',
          redDurationSeconds: 45,
          blackDurationSeconds: 60,
          endedAt: 20_000,
        },
        clockOffsetMs: 0,
        pendingAction: null,
        lastError: null,
        lastRejectedReason: null,
        statusNotice: null,
        lastAcceptedAction: null,
        pendingNegotiation: null,
        drawCooldownUntil: {},
        negotiationEvent: null,
      },
    };

    const mockClient = {
      sendGameAction: vi.fn(),
      sendLobbyReturn: vi.fn(),
    } as unknown as RoomConnection;

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    // 弹窗展示
    expect(screen.getByTestId('game-result-modal')).toBeInTheDocument();
    expect(screen.getByTestId('result-outcome-title')).toHaveTextContent('胜利！');
    expect(screen.getByTestId('result-reason')).toHaveTextContent('单步用时耗尽超时判负');
    expect(screen.getByTestId('result-stats')).toHaveTextContent('红方总用时');

    // 点击再来一局
    fireEvent.click(screen.getByTestId('btn-rematch'));
    expect(mockClient.sendLobbyReturn).toHaveBeenCalledWith('rematch');

    // 点击返回大厅
    fireEvent.click(screen.getByTestId('btn-return-lobby'));
    expect(mockClient.sendLobbyReturn).toHaveBeenCalledWith('return-lobby');
  });
});


describe('OnlineGame spectator view', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function spectatorFixture(overrides: Partial<GameClientState> = {}) {
    const startParameters = buildStartParameters({
      roomId: 'room-1',
      host: { memberId: 'host-1', name: '房主' },
      guest: { memberId: 'guest-1', name: '客人' },
      settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 },
      hostSide: 'red',
    });
    const match = createMatch({ matchId: 'm1', seed: 12345, startParameters });
    const snapshot = snapshotMatch(match);
    const lobby = createLobbyState();
    lobby.phase = 'started';
    lobby.startParameters = startParameters;
    const game: GameClientState = {
      matchId: 'm1',
      seed: 12345,
      stepNumber: 2,
      revision: 7,
      startParameters,
      confirmedState: snapshot.gameState,
      displayState: snapshot.gameState,
      clock: snapshot.clock,
      settlement: null,
      clockOffsetMs: 0,
      pendingAction: null,
      lastError: null,
      lastRejectedReason: null,
      statusNotice: null,
      lastAcceptedAction: null,
      pendingNegotiation: null,
      drawCooldownUntil: {},
      negotiationEvent: null,
      ...overrides,
    };
    const connection: ConnectionState = {
      ...IDLE_CONNECTION_STATE,
      status: 'connected',
      roomId: 'room-1',
      memberId: 'spec-1',
      role: 'spectator',
      members: [
        { id: 'host-1', role: 'host', name: '房主', connected: true },
        { id: 'guest-1', role: 'guest', name: '客人', connected: true },
        { id: 'spec-1', role: 'spectator', name: '旁观1', connected: true },
      ],
      lobby,
      game,
    };
    const mockClient = {
      sendGameAction: vi.fn().mockReturnValue({ ok: true }),
      sendGameNegotiate: vi.fn().mockReturnValue({ ok: true }),
      sendGameNegotiateReply: vi.fn().mockReturnValue({ ok: true }),
      sendGameResign: vi.fn().mockReturnValue({ ok: true }),
      sendChatPhrase: vi.fn().mockReturnValue({ ok: true }),
      sendLobbyReturn: vi.fn(),
      requestGameSync: vi.fn(),
    } as unknown as RoomConnection;
    return { connection, mockClient, snapshot };
  }

  it('renders a read-only view with neutral labels and no action entries', () => {
    const { connection, mockClient } = spectatorFixture();

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    // 旁观视角：固定红方在下，不出玩家口吻文案。
    expect(screen.getByTestId('lobby-started')).toHaveTextContent('旁观视角（红方在下）');
    expect(screen.getByTestId('lobby-started')).not.toHaveTextContent('你执');
    expect(screen.getByTestId('turn-indicator')).toHaveTextContent('轮到红方行动');
    expect(screen.getByTestId('turn-indicator')).not.toHaveTextContent('轮到你');

    // 只读：无操作入口。
    expect(screen.getByTestId('spectator-readonly-note')).toHaveTextContent('旁观中');
    expect(screen.queryByTestId('btn-undo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-draw')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-resign')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spectate-exit')).toHaveTextContent('离开观看');

    // 棋盘点击不产生任何动作消息与选中态。
    fireEvent.click(screen.getByTestId('cell-4-6'));
    expect(mockClient.sendGameAction).not.toHaveBeenCalled();
  });

  it('labels both players by camp with red at the bottom and lists spectators', () => {
    const { connection, mockClient } = spectatorFixture();

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    const selfBar = screen.getByTestId('online-self-bar');
    const opponentBar = screen.getByTestId('online-opponent-bar');
    expect(selfBar).toHaveTextContent('执红');
    expect(selfBar).toHaveTextContent('房主');
    expect(opponentBar).toHaveTextContent('执黑');
    expect(opponentBar).toHaveTextContent('客人');

    // 大厅与对局内都能看到旁观名单与在线人数。
    expect(screen.getByTestId('spectator-list')).toBeInTheDocument();
    expect(screen.getByTestId('spectator-count')).toHaveTextContent('旁观 1 人在线');
    expect(screen.getAllByTestId('spectator-item')).toHaveLength(1);
  });

  it('shows a neutral read-only negotiation notice without reply buttons', () => {
    const { connection, mockClient } = spectatorFixture({
      pendingNegotiation: {
        negotiationId: 'neg-1',
        type: 'draw',
        initiatorMemberId: 'guest-1',
        responderMemberId: 'host-1',
        baselineRevision: 7,
        createdAt: Date.now(),
        deadline: Date.now() + 30_000,
      },
    });

    render(<OnlineGame client={mockClient} connection={connection} onExit={vi.fn()} />);

    expect(screen.getByTestId('negotiation-dialog')).toHaveTextContent('求和协商进行中');
    expect(screen.queryByTestId('negotiation-agree-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('negotiation-reject-btn')).not.toBeInTheDocument();
  });

  it('shows the settlement dialog in spectator mode and never sends lobby returns', () => {
    const onExit = vi.fn();
    const { connection, mockClient } = spectatorFixture({
      settlement: {
        winner: 'red',
        loser: 'black',
        reason: 'resignation',
        redDurationSeconds: 30,
        blackDurationSeconds: 40,
        endedAt: 20_000,
      },
    });

    render(<OnlineGame client={mockClient} connection={connection} onExit={onExit} />);

    expect(screen.getByTestId('game-result-modal')).toBeInTheDocument();
    expect(screen.getByTestId('result-outcome-title')).toHaveTextContent('红方获胜！');
    expect(screen.getByTestId('result-reason')).toHaveTextContent('一方认输');
    expect(screen.queryByTestId('btn-rematch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-return-lobby')).not.toBeInTheDocument();

    // Escape 只本地收起结果层，不发送任何对局消息。
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mockClient.sendLobbyReturn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('game-result-modal')).not.toBeInTheDocument();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('offers local continue-watching and leave-watching actions in spectator mode', () => {
    const onExit = vi.fn();
    const settled = () =>
      spectatorFixture({
        settlement: {
          winner: 'red',
          loser: 'black',
          reason: 'resignation',
          redDurationSeconds: 30,
          blackDurationSeconds: 40,
          endedAt: 20_000,
        },
      });

    const first = settled();
    const firstRender = render(<OnlineGame client={first.mockClient} connection={first.connection} onExit={onExit} />);
    // 「继续观看」本地收起结果层。
    fireEvent.click(screen.getByTestId('btn-continue-watch'));
    expect(screen.queryByTestId('game-result-modal')).not.toBeInTheDocument();
    expect(first.mockClient.sendLobbyReturn).not.toHaveBeenCalled();
    firstRender.unmount();

    const second = settled();
    render(<OnlineGame client={second.mockClient} connection={second.connection} onExit={onExit} />);
    // 「离开观看」触发本地退出入口，不发送对局消息。
    fireEvent.click(screen.getByTestId('btn-leave-watch'));
    expect(onExit).toHaveBeenCalled();
    expect(second.mockClient.sendLobbyReturn).not.toHaveBeenCalled();
  });
});
