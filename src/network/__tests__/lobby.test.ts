import { describe, expect, it } from 'vitest';
import {
  applyLobbyCommand,
  buildStartParameters,
  createLobbyState,
  defaultLobbySettings,
  describeSideDisplay,
  displaySides,
  findTimeControl,
  parseLobbyState,
  sideOptionViews,
  snapshotLobbyState,
  TIME_CONTROLS,
  type LobbyCommand,
  type LobbyState,
} from '../lobby';

const HOST = { memberId: 'host-1', name: '房主' };
const GUEST = { memberId: 'guest-1', name: '客人' };

function run(state: LobbyState, command: LobbyCommand): ReturnType<typeof applyLobbyCommand> {
  return applyLobbyCommand(state, command);
}

/** 把大厅推进到「双方在线且均已就绪」的可开局状态。 */
function readyLobby(sidePreference: 'host-red' | 'host-black' | 'random' = 'host-red'): LobbyState {
  let state = createLobbyState();
  for (const command of [
    { type: 'member-joined', role: 'host' },
    { type: 'member-joined', role: 'guest' },
    { type: 'update-settings', actor: 'host', sidePreference, timeControlId: 'standard' },
    { type: 'set-ready', actor: 'host', ready: true, settingsVersion: 2 },
    { type: 'set-ready', actor: 'guest', ready: true, settingsVersion: 2 },
  ] as LobbyCommand[]) {
    const result = run(state, command);
    if (!result.ok) {
      throw new Error(`setup rejected: ${result.code}`);
    }
    state = result.state;
  }
  return state;
}

describe('lobby defaults and catalogs', () => {
  it('starts with random sides, no timer, nobody ready and unlocked settings', () => {
    const state = createLobbyState();
    expect(state).toMatchObject({
      phase: 'lobby',
      settings: { sidePreference: 'random', timeControlId: 'none', locked: false, settingsVersion: 1 },
      ready: { host: false, guest: false },
      presence: { host: false, guest: false },
      startParameters: null,
    });
    expect(defaultLobbySettings().settingsVersion).toBe(1);
  });

  it('exposes the three time control tiers with their explanations', () => {
    expect(TIME_CONTROLS.map((option) => option.id)).toEqual(['none', 'standard', 'blitz']);
    expect(TIME_CONTROLS.map((option) => option.label)).toEqual(['不计时', '20 分 + 60 秒', '10 分 + 30 秒']);
    expect(TIME_CONTROLS.map((option) => option.description)).toEqual(['悠闲对弈', '标准局', '快棋']);
    expect(findTimeControl('none')).toMatchObject({ baseTimeSeconds: null, incrementSeconds: 0 });
    expect(findTimeControl('standard')).toMatchObject({ baseTimeSeconds: 1200, incrementSeconds: 60 });
    expect(findTimeControl('blitz')).toMatchObject({ baseTimeSeconds: 600, incrementSeconds: 30 });
  });

  it('flips the side option copy for the guest while keeping host-relative ids', () => {
    const hostView = sideOptionViews('host');
    const guestView = sideOptionViews('guest');
    expect(hostView.map((option) => option.id)).toEqual(['host-red', 'host-black', 'random']);
    expect(hostView.map((option) => option.label)).toEqual(['执红先行', '执黑后行', '随机分先']);
    expect(guestView.find((option) => option.id === 'host-red')?.label).toBe('执黑后行');
    expect(guestView.find((option) => option.id === 'host-red')?.description).toBe('你执黑');
    expect(guestView.find((option) => option.id === 'host-black')?.label).toBe('执红先行');
    expect(guestView.find((option) => option.id === 'random')?.description).toBe('开局前掷定，双方公平');
  });
});

describe('settings commands', () => {
  it('lets only the host change settings and rejects guests', () => {
    const state = createLobbyState();
    const result = run(state, {
      type: 'update-settings',
      actor: 'guest',
      sidePreference: 'host-red',
      timeControlId: 'none',
    });
    expect(result).toMatchObject({ ok: false, code: 'NOT_HOST' });
  });

  it('bumps the settings version and clears both ready flags on an actual change', () => {
    let state = readyLobby('host-red');
    expect(state.ready).toEqual({ host: true, guest: true });

    const result = run(state, {
      type: 'update-settings',
      actor: 'host',
      sidePreference: 'host-black',
      timeControlId: 'blitz',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.changed).toBe(true);
    expect(result.state.settings).toMatchObject({ sidePreference: 'host-black', timeControlId: 'blitz', settingsVersion: 3 });
    expect(result.state.ready).toEqual({ host: false, guest: false });
  });

  it('keeps the version and ready flags when the submitted settings are unchanged', () => {
    const state = readyLobby('host-red');
    const result = run(state, {
      type: 'update-settings',
      actor: 'host',
      sidePreference: 'host-red',
      timeControlId: 'standard',
    });
    expect(result).toMatchObject({ ok: true, changed: false });
    if (result.ok) {
      expect(result.state).toBe(state);
    }
  });

  it('freezes settings while locked and clears ready after unlocking', () => {
    let state = readyLobby('host-red');

    const locked = run(state, { type: 'set-locked', actor: 'host', locked: true });
    expect(locked.ok).toBe(true);
    if (!locked.ok) {
      return;
    }
    state = locked.state;
    expect(state.settings.locked).toBe(true);
    expect(state.ready).toEqual({ host: true, guest: true });

    expect(
      run(state, { type: 'update-settings', actor: 'host', sidePreference: 'random', timeControlId: 'none' }),
    ).toMatchObject({ ok: false, code: 'LOCKED' });

    const unlocked = run(state, { type: 'set-locked', actor: 'host', locked: false });
    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) {
      return;
    }
    expect(unlocked.state.ready).toEqual({ host: false, guest: false });
    expect(unlocked.state.settings.locked).toBe(false);
  });

  it('rejects invalid setting values', () => {
    const state = createLobbyState();
    expect(
      run(state, {
        type: 'update-settings',
        actor: 'host',
        sidePreference: 'yellow' as never,
        timeControlId: 'none',
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_VALUE' });
    expect(
      run(state, {
        type: 'update-settings',
        actor: 'host',
        sidePreference: 'random',
        timeControlId: 'marathon' as never,
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_VALUE' });
    expect(run(state, { type: 'set-locked', actor: 'guest', locked: true })).toMatchObject({ ok: false, code: 'NOT_HOST' });
  });
});

describe('ready commands', () => {
  it('binds ready to the settings version and rejects stale versions', () => {
    const state = createLobbyState();
    expect(
      run(state, { type: 'set-ready', actor: 'host', ready: true, settingsVersion: 99 }),
    ).toMatchObject({ ok: false, code: 'STALE_VERSION' });

    const accepted = run(state, { type: 'set-ready', actor: 'host', ready: true, settingsVersion: 1 });
    expect(accepted).toMatchObject({ ok: true, changed: true });
  });

  it('treats duplicate ready submits as idempotent', () => {
    let state = createLobbyState();
    const first = run(state, { type: 'set-ready', actor: 'guest', ready: true, settingsVersion: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    state = first.state;
    const second = run(state, { type: 'set-ready', actor: 'guest', ready: true, settingsVersion: 1 });
    expect(second).toMatchObject({ ok: true, changed: false });
  });

  it('clears both ready flags when either member leaves before the start', () => {
    let state = readyLobby();
    const result = run(state, { type: 'member-left', role: 'guest' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    state = result.state;
    expect(state.presence).toEqual({ host: true, guest: false });
    expect(state.ready).toEqual({ host: false, guest: false });
  });
});

describe('start gate and frozen snapshot', () => {
  function startCommand(hostRedWhenRandom: boolean | null = null): Extract<LobbyCommand, { type: 'start' }> {
    return { type: 'start', actor: 'host', roomId: 'room-1', host: HOST, guest: GUEST, hostRedWhenRandom };
  }

  it('requires both members online and ready', () => {
    const noGuest = readyLobby();
    const left = applyLobbyCommand(noGuest, { type: 'member-left', role: 'guest' });
    if (!left.ok) {
      throw new Error('member-left failed');
    }
    expect(run(left.state, startCommand())).toMatchObject({ ok: false, code: 'MEMBER_MISSING' });

    const notReady = applyLobbyCommand(readyLobby(), { type: 'set-ready', actor: 'guest', ready: false, settingsVersion: 2 });
    if (!notReady.ok) {
      throw new Error('unready failed');
    }
    expect(run(notReady.state, startCommand())).toMatchObject({ ok: false, code: 'NOT_READY' });

    expect(run(readyLobby(), { ...startCommand(), actor: 'guest' })).toMatchObject({ ok: false, code: 'NOT_HOST' });
  });

  it('resolves fixed side preferences without a draw', () => {
    const hostRed = run(readyLobby('host-red'), startCommand());
    const hostBlack = run(readyLobby('host-black'), startCommand());
    expect(hostRed.ok && hostRed.state.startParameters).toMatchObject({
      sidePreference: 'host-red',
      redMemberId: 'host-1',
      blackMemberId: 'guest-1',
    });
    expect(hostBlack.ok && hostBlack.state.startParameters).toMatchObject({
      sidePreference: 'host-black',
      redMemberId: 'guest-1',
      blackMemberId: 'host-1',
    });
  });

  it('draws random sides exactly once via the supplied verdict', () => {
    const hostRedRandom = run(readyLobby('random'), startCommand(true));
    expect(hostRedRandom.ok && hostRedRandom.state.startParameters).toMatchObject({
      sidePreference: 'random',
      redMemberId: 'host-1',
      blackMemberId: 'guest-1',
    });

    const guestRedRandom = run(readyLobby('random'), startCommand(false));
    expect(guestRedRandom.ok && guestRedRandom.state.startParameters).toMatchObject({
      sidePreference: 'random',
      redMemberId: 'guest-1',
      blackMemberId: 'host-1',
    });

    expect(run(readyLobby('random'), startCommand(null))).toMatchObject({ ok: false, code: 'INVALID_VALUE' });
  });

  it('freezes the snapshot once and rejects repeat starts without redrawing', () => {
    const first = run(readyLobby('random'), startCommand(true));
    if (!first.ok) {
      throw new Error('first start failed');
    }
    expect(first.state.phase).toBe('started');
    const frozen = first.state.startParameters;

    const second = applyLobbyCommand(first.state, startCommand(false));
    expect(second).toMatchObject({ ok: false, code: 'ALREADY_STARTED' });
    if (!second.ok) {
      expect(first.state.startParameters).toBe(frozen);
    }
  });

  it('carries the time control tier, values and settings version into the snapshot', () => {
    const result = run(readyLobby('host-red'), startCommand());
    if (!result.ok || !result.state.startParameters) {
      throw new Error('start failed');
    }
    const snapshot = result.state.startParameters;
    expect(snapshot).toMatchObject({
      roomId: 'room-1',
      timeControlId: 'standard',
      baseTimeSeconds: 1200,
      incrementSeconds: 60,
      settingsVersion: 2,
      players: [
        { memberId: 'host-1', role: 'host', name: '房主', side: 'red' },
        { memberId: 'guest-1', role: 'guest', name: '客人', side: 'black' },
      ],
    });
  });

  it('rejects settings and ready changes after the freeze', () => {
    const result = run(readyLobby(), startCommand(true));
    if (!result.ok) {
      throw new Error('start failed');
    }
    expect(
      run(result.state, { type: 'update-settings', actor: 'host', sidePreference: 'random', timeControlId: 'none' }),
    ).toMatchObject({ ok: false, code: 'ALREADY_STARTED' });
    expect(
      run(result.state, { type: 'set-ready', actor: 'guest', ready: false, settingsVersion: 2 }),
    ).toMatchObject({ ok: false, code: 'ALREADY_STARTED' });
    expect(run(result.state, { type: 'set-locked', actor: 'host', locked: true })).toMatchObject({
      ok: false,
      code: 'ALREADY_STARTED',
    });
  });

  it('produces a read-only independent snapshot without connection secrets', () => {
    const parameters = buildStartParameters({
      roomId: 'room-1',
      settings: { ...defaultLobbySettings(), sidePreference: 'host-red', timeControlId: 'blitz', settingsVersion: 4 },
      host: HOST,
      guest: GUEST,
      hostSide: 'black',
    });
    expect(parameters).toMatchObject({ settingsVersion: 4, baseTimeSeconds: 600, incrementSeconds: 30, redMemberId: 'guest-1' });
    expect(Object.isFrozen(parameters)).toBe(true);
    expect(Object.isFrozen(parameters.players)).toBe(true);
    expect(JSON.stringify(parameters)).not.toMatch(/token|socket|ws:|http/i);
  });

  it('snapshots state independently so wire copies cannot mutate the authority', () => {
    const state = readyLobby('host-red');
    const copy = snapshotLobbyState(state);
    expect(copy).not.toBe(state);
    expect(copy.settings).not.toBe(state.settings);
    // 冻结后修改一律被拒绝，权威状态不可能被连线对象波及。
    expect(() => {
      copy.settings.sidePreference = 'random';
    }).toThrow();
    expect(() => {
      copy.ready.host = true;
    }).toThrow();
    expect(state.settings.sidePreference).toBe('host-red');
    expect(state.ready.host).toBe(true);
  });
});

describe('display helpers', () => {
  it('shows pending sides until the random draw happens', () => {
    expect(displaySides(createLobbyState())).toEqual({ host: 'pending', guest: 'pending' });
    expect(describeSideDisplay('pending')).toBe('待开局确定');
    expect(describeSideDisplay('red')).toBe('红方');
    expect(describeSideDisplay('black')).toBe('黑方');
  });

  it('reflects fixed preferences immediately and the final draw after the start', () => {
    const fixed = applyLobbyCommand(createLobbyState(), {
      type: 'update-settings',
      actor: 'host',
      sidePreference: 'host-black',
      timeControlId: 'none',
    });
    expect(fixed.ok && displaySides(fixed.state)).toEqual({ host: 'black', guest: 'red' });

    const started = run(readyLobby('random'), {
      type: 'start',
      actor: 'host',
      roomId: 'room-1',
      host: HOST,
      guest: GUEST,
      hostRedWhenRandom: true,
    });
    expect(started.ok && displaySides(started.state)).toEqual({ host: 'red', guest: 'black' });
  });
});

describe('wire parsing', () => {
  it('round-trips a lobby state snapshot', () => {
    const state = readyLobby('host-red');
    const started = run(state, {
      type: 'start',
      actor: 'host',
      roomId: 'room-1',
      host: HOST,
      guest: GUEST,
      hostRedWhenRandom: null,
    });
    if (!started.ok) {
      throw new Error('start failed');
    }
    const wire = JSON.parse(JSON.stringify(snapshotLobbyState(started.state))) as unknown;
    expect(parseLobbyState(wire)).toEqual(snapshotLobbyState(started.state));
  });

  it('rejects malformed lobby snapshots', () => {
    expect(parseLobbyState(null)).toBeNull();
    expect(parseLobbyState({ phase: 'lobby', settings: {}, ready: {}, presence: {} })).toBeNull();
    expect(
      parseLobbyState({
        phase: 'started',
        settings: { sidePreference: 'random', timeControlId: 'none', locked: false, settingsVersion: 1 },
        ready: { host: true, guest: true },
        presence: { host: true, guest: true },
        startParameters: null,
      }),
    ).toBeNull();
  });
});
