/**
 * 大厅领域模型：分先/局时设置、就绪门禁与开局参数快照。
 *
 * 该文件必须保持纯 TypeScript（不依赖 Node API 与 DOM API），
 * 以便同时被浏览器客户端与 Node 宿主服务引用。
 *
 * 所有大厅状态转换集中在本文件：权限、锁定、就绪绑定设置版本、
 * 开局门禁与一次性随机分先都由纯函数裁决，服务端只做调用方，
 * 客户端 UI 不承担任何校验职责。
 */
import type { PlayerRole } from './protocol.js';

/** 棋子颜色（红方先行）。 */
export type PieceSide = 'red' | 'black';

/** 分先方式（始终以房主视角记录；界面按查看者身份换算文案）。 */
export type SidePreference = 'host-red' | 'host-black' | 'random';

export type TimeControlId = 'none' | 'standard' | 'blitz';

export type LobbyPhase = 'lobby' | 'started';

export interface TimeControlOption {
  id: TimeControlId;
  /** 档位名，如「20 分 + 60 秒」。 */
  label: string;
  /** 说明文案，如「标准局」。 */
  description: string;
  /** 总局时（秒），null 表示不计时。 */
  baseTimeSeconds: number | null;
  /** 每步加秒（读秒）；本期不新增运行时语义，仅随快照携带。 */
  incrementSeconds: number;
}

export const TIME_CONTROLS: readonly TimeControlOption[] = [
  { id: 'none', label: '不计时', description: '悠闲对弈', baseTimeSeconds: null, incrementSeconds: 0 },
  { id: 'standard', label: '20 分 + 60 秒', description: '标准局', baseTimeSeconds: 1200, incrementSeconds: 60 },
  { id: 'blitz', label: '10 分 + 30 秒', description: '快棋', baseTimeSeconds: 600, incrementSeconds: 30 },
];

export interface SideOptionView {
  id: SidePreference;
  label: string;
  description: string;
}

export interface LobbySettings {
  sidePreference: SidePreference;
  timeControlId: TimeControlId;
  /** 房主锁定后设置不可再修改；解锁会清空双方就绪。 */
  locked: boolean;
  /** 设置实际变化一次 +1；就绪状态绑定该版本，过期准备被拒绝。 */
  settingsVersion: number;
}

export interface LobbyReady {
  host: boolean;
  guest: boolean;
}

export interface PlayerSeat {
  memberId: string;
  role: PlayerRole;
  name: string;
  side: PieceSide;
}

/** 开局参数快照：开始对局时一次性冻结，只读，供对局状态机消费。 */
export interface StartParameters {
  roomId: string;
  sidePreference: SidePreference;
  timeControlId: TimeControlId;
  baseTimeSeconds: number | null;
  incrementSeconds: number;
  settingsVersion: number;
  redMemberId: string;
  blackMemberId: string;
  players: PlayerSeat[];
}

export interface LobbyState {
  phase: LobbyPhase;
  settings: LobbySettings;
  ready: LobbyReady;
  /** 双方是否在大厅内（离开/掉线即置 false）。 */
  presence: LobbyReady;
  startParameters: StartParameters | null;
}

export type LobbyRejectCode =
  | 'NOT_HOST'
  | 'LOCKED'
  | 'INVALID_VALUE'
  | 'STALE_VERSION'
  | 'NOT_READY'
  | 'MEMBER_MISSING'
  | 'ALREADY_STARTED'
  /** 旁观者只读：一切大厅命令与对局动作通道均拒绝旁观者消息。 */
  | 'SPECTATOR_READONLY';

export type LobbyCommand =
  | { type: 'update-settings'; actor: PlayerRole; sidePreference: SidePreference; timeControlId: TimeControlId }
  | { type: 'set-locked'; actor: PlayerRole; locked: boolean }
  | { type: 'set-ready'; actor: PlayerRole; ready: boolean; settingsVersion: number }
  | { type: 'member-joined'; role: PlayerRole }
  | { type: 'member-left'; role: PlayerRole }
  | {
      type: 'start';
      actor: PlayerRole;
      roomId: string;
      host: { memberId: string; name: string };
      guest: { memberId: string; name: string };
      /** 随机分先时由服务端抽取一次的裁决：true = 房主执红；非随机分先传 null。 */
      hostRedWhenRandom: boolean | null;
    };

export type LobbyCommandResult =
  | { ok: true; state: LobbyState; changed: boolean }
  | { ok: false; code: LobbyRejectCode; detail: string };

export const INITIAL_SETTINGS_VERSION = 1;

/** 实施默认：随机分先、不计时、双方未准备、设置未锁。 */
export function defaultLobbySettings(): LobbySettings {
  return {
    sidePreference: 'random',
    timeControlId: 'none',
    locked: false,
    settingsVersion: INITIAL_SETTINGS_VERSION,
  };
}

export function createLobbyState(): LobbyState {
  return {
    phase: 'lobby',
    settings: defaultLobbySettings(),
    ready: { host: false, guest: false },
    presence: { host: false, guest: false },
    startParameters: null,
  };
}

export function isSidePreference(value: unknown): value is SidePreference {
  return value === 'host-red' || value === 'host-black' || value === 'random';
}

export function isTimeControlId(value: unknown): value is TimeControlId {
  return value === 'none' || value === 'standard' || value === 'blitz';
}

export function findTimeControl(id: TimeControlId): TimeControlOption {
  const option = TIME_CONTROLS.find((entry) => entry.id === id);
  if (!option) {
    throw new Error(`unknown time control: ${id}`);
  }
  return option;
}

function reject(code: LobbyRejectCode, detail: string): LobbyCommandResult {
  return { ok: false, code, detail };
}

export function buildStartParameters(input: {
  roomId: string;
  settings: LobbySettings;
  host: { memberId: string; name: string };
  guest: { memberId: string; name: string };
  hostSide: PieceSide;
}): StartParameters {
  const time = findTimeControl(input.settings.timeControlId);
  const guestSide: PieceSide = input.hostSide === 'red' ? 'black' : 'red';
  const players: PlayerSeat[] = [
    { memberId: input.host.memberId, role: 'host', name: input.host.name, side: input.hostSide },
    { memberId: input.guest.memberId, role: 'guest', name: input.guest.name, side: guestSide },
  ];
  const parameters: StartParameters = {
    roomId: input.roomId,
    sidePreference: input.settings.sidePreference,
    timeControlId: input.settings.timeControlId,
    baseTimeSeconds: time.baseTimeSeconds,
    incrementSeconds: time.incrementSeconds,
    settingsVersion: input.settings.settingsVersion,
    redMemberId: players.find((seat) => seat.side === 'red')?.memberId ?? '',
    blackMemberId: players.find((seat) => seat.side === 'black')?.memberId ?? '',
    players,
  };
  return deepFreeze(parameters);
}

/**
 * 大厅状态机：唯一的合法状态转换入口。
 * 成功时返回新状态（原状态不被修改）；失败时给出非致命拒绝码。
 */
export function applyLobbyCommand(state: LobbyState, command: LobbyCommand): LobbyCommandResult {
  if (command.type === 'member-joined') {
    if (state.presence[command.role]) {
      return { ok: true, state, changed: false };
    }
    return {
      ok: true,
      changed: true,
      state: { ...state, presence: { ...state.presence, [command.role]: true } },
    };
  }

  if (command.type === 'member-left') {
    if (!state.presence[command.role]) {
      return { ok: true, state, changed: false };
    }
    return {
      ok: true,
      changed: true,
      state: {
        ...state,
        presence: { ...state.presence, [command.role]: false },
        // 开局前成员离开/掉线清空双方就绪；冻结后不再改动任何快照。
        ready: state.phase === 'lobby' ? { host: false, guest: false } : state.ready,
      },
    };
  }

  // 开局后冻结：设置、锁定、就绪、开始都不再接受。
  if (state.phase !== 'lobby') {
    return reject('ALREADY_STARTED', command.type);
  }

  if (command.type === 'update-settings') {
    if (command.actor !== 'host') {
      return reject('NOT_HOST', 'update-settings');
    }
    if (state.settings.locked) {
      return reject('LOCKED', 'update-settings');
    }
    if (!isSidePreference(command.sidePreference) || !isTimeControlId(command.timeControlId)) {
      return reject('INVALID_VALUE', 'update-settings');
    }
    const unchanged =
      state.settings.sidePreference === command.sidePreference && state.settings.timeControlId === command.timeControlId;
    if (unchanged) {
      return { ok: true, state, changed: false };
    }
    return {
      ok: true,
      changed: true,
      state: {
        ...state,
        settings: {
          ...state.settings,
          sidePreference: command.sidePreference,
          timeControlId: command.timeControlId,
          settingsVersion: state.settings.settingsVersion + 1,
        },
        // 设置实际变化清空双方就绪。
        ready: { host: false, guest: false },
      },
    };
  }

  if (command.type === 'set-locked') {
    if (command.actor !== 'host') {
      return reject('NOT_HOST', 'set-locked');
    }
    if (typeof command.locked !== 'boolean') {
      return reject('INVALID_VALUE', 'set-locked');
    }
    if (command.locked === state.settings.locked) {
      return { ok: true, state, changed: false };
    }
    return {
      ok: true,
      changed: true,
      state: {
        ...state,
        settings: { ...state.settings, locked: command.locked },
        // 解锁后设置可再变，双方就绪一律清空；锁定只是冻结，不动就绪。
        ready: command.locked ? state.ready : { host: false, guest: false },
      },
    };
  }

  if (command.type === 'set-ready') {
    if (command.settingsVersion !== state.settings.settingsVersion) {
      return reject('STALE_VERSION', 'set-ready');
    }
    if (typeof command.ready !== 'boolean') {
      return reject('INVALID_VALUE', 'set-ready');
    }
    if (state.ready[command.actor] === command.ready) {
      // 防重复提交：同值重发视为幂等成功，不产生新状态。
      return { ok: true, state, changed: false };
    }
    return {
      ok: true,
      changed: true,
      state: { ...state, ready: { ...state.ready, [command.actor]: command.ready } },
    };
  }

  // start
  if (command.actor !== 'host') {
    return reject('NOT_HOST', 'start');
  }
  if (!state.presence.host || !state.presence.guest) {
    return reject('MEMBER_MISSING', 'start');
  }
  if (!state.ready.host || !state.ready.guest) {
    return reject('NOT_READY', 'start');
  }

  let hostSide: PieceSide;
  if (state.settings.sidePreference === 'host-red') {
    hostSide = 'red';
  } else if (state.settings.sidePreference === 'host-black') {
    hostSide = 'black';
  } else if (command.hostRedWhenRandom === true) {
    hostSide = 'red';
  } else if (command.hostRedWhenRandom === false) {
    hostSide = 'black';
  } else {
    return reject('INVALID_VALUE', 'start-random-draw');
  }

  const startParameters = buildStartParameters({
    roomId: command.roomId,
    settings: state.settings,
    host: command.host,
    guest: command.guest,
    hostSide,
  });

  return {
    ok: true,
    changed: true,
    state: {
      phase: 'started',
      settings: state.settings,
      ready: state.ready,
      presence: state.presence,
      startParameters,
    },
  };
}

/** 线上传输用的独立快照：与内部状态解耦，调用方改动不会波及权威状态。 */
export function snapshotLobbyState(state: LobbyState): LobbyState {
  return deepFreeze(cloneLobbyState(state));
}

function cloneLobbyState(state: LobbyState): LobbyState {
  return {
    phase: state.phase,
    settings: { ...state.settings },
    ready: { ...state.ready },
    presence: { ...state.presence },
    startParameters: state.startParameters
      ? {
          ...state.startParameters,
          players: state.startParameters.players.map((seat) => ({ ...seat })),
        }
      : null,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

// —— 展示辅助（纯函数，供两端界面共用） ——

export type SideDisplay = PieceSide | 'pending';

export function displaySides(state: LobbyState): { host: SideDisplay; guest: SideDisplay } {
  const started = state.startParameters;
  if (started) {
    const hostSeat = started.players.find((seat) => seat.role === 'host');
    const guestSeat = started.players.find((seat) => seat.role === 'guest');
    return { host: hostSeat?.side ?? 'pending', guest: guestSeat?.side ?? 'pending' };
  }
  if (state.settings.sidePreference === 'host-red') {
    return { host: 'red', guest: 'black' };
  }
  if (state.settings.sidePreference === 'host-black') {
    return { host: 'black', guest: 'red' };
  }
  // 随机分先：开始前显示「待开局确定」。
  return { host: 'pending', guest: 'pending' };
}

export function describeSideDisplay(side: SideDisplay): string {
  if (side === 'red') {
    return '红方';
  }
  if (side === 'black') {
    return '黑方';
  }
  return '待开局确定';
}

/** 分先单选卡片文案：始终指房主执红/执黑，客人文案按自身身份换算。 */
export function sideOptionViews(viewerRole: PlayerRole): SideOptionView[] {
  const hostView: SideOptionView[] = [
    { id: 'host-red', label: '执红先行', description: '你执红，先手翻牌' },
    { id: 'host-black', label: '执黑后行', description: '你执黑' },
    { id: 'random', label: '随机分先', description: '开局前掷定，双方公平' },
  ];
  if (viewerRole === 'host') {
    return hostView;
  }
  return hostView.map((option) => {
    if (option.id === 'host-red') {
      return { id: option.id, label: '执黑后行', description: '你执黑' };
    }
    if (option.id === 'host-black') {
      return { id: option.id, label: '执红先行', description: '你执红，先手翻牌' };
    }
    return option;
  });
}

// —— 线格式校验（协议层与服务端共用） ——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemberId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseLobbySettings(value: unknown): LobbySettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const { sidePreference, timeControlId, locked, settingsVersion } = value;
  if (!isSidePreference(sidePreference) || !isTimeControlId(timeControlId)) {
    return null;
  }
  if (typeof locked !== 'boolean') {
    return null;
  }
  if (typeof settingsVersion !== 'number' || !Number.isInteger(settingsVersion) || settingsVersion < 1) {
    return null;
  }
  return { sidePreference, timeControlId, locked, settingsVersion };
}

export function parseStartParameters(value: unknown): StartParameters | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    roomId,
    sidePreference,
    timeControlId,
    baseTimeSeconds,
    incrementSeconds,
    settingsVersion,
    redMemberId,
    blackMemberId,
    players,
  } = value;
  if (typeof roomId !== 'string' || roomId.length === 0 || !isSidePreference(sidePreference) || !isTimeControlId(timeControlId)) {
    return null;
  }
  if (baseTimeSeconds !== null && (typeof baseTimeSeconds !== 'number' || !Number.isFinite(baseTimeSeconds))) {
    return null;
  }
  if (typeof incrementSeconds !== 'number' || !Number.isFinite(incrementSeconds)) {
    return null;
  }
  if (typeof settingsVersion !== 'number' || !Number.isInteger(settingsVersion) || settingsVersion < 1) {
    return null;
  }
  if (!isMemberId(redMemberId) || !isMemberId(blackMemberId) || !Array.isArray(players) || players.length !== 2) {
    return null;
  }
  const seats: PlayerSeat[] = [];
  for (const entry of players) {
    if (!isRecord(entry)) {
      return null;
    }
    const { memberId, role, name, side } = entry;
    if (!isMemberId(memberId) || (role !== 'host' && role !== 'guest') || typeof name !== 'string') {
      return null;
    }
    if (side !== 'red' && side !== 'black') {
      return null;
    }
    seats.push({ memberId, role, name, side });
  }
  return {
    roomId,
    sidePreference,
    timeControlId,
    baseTimeSeconds,
    incrementSeconds,
    settingsVersion,
    redMemberId,
    blackMemberId,
    players: seats,
  };
}

export function parseLobbyState(value: unknown): LobbyState | null {
  if (!isRecord(value)) {
    return null;
  }
  const { phase, settings, ready, presence, startParameters } = value;
  if (phase !== 'lobby' && phase !== 'started') {
    return null;
  }
  const parsedSettings = parseLobbySettings(settings);
  if (!parsedSettings || !isRecord(ready) || !isRecord(presence)) {
    return null;
  }
  if (typeof ready.host !== 'boolean' || typeof ready.guest !== 'boolean') {
    return null;
  }
  if (typeof presence.host !== 'boolean' || typeof presence.guest !== 'boolean') {
    return null;
  }
  const parsedStart = startParameters === null ? null : parseStartParameters(startParameters);
  if (startParameters !== null && !parsedStart) {
    return null;
  }
  if (phase === 'started' && !parsedStart) {
    return null;
  }
  return {
    phase,
    settings: parsedSettings,
    ready: { host: ready.host, guest: ready.guest },
    presence: { host: presence.host, guest: presence.guest },
    startParameters: parsedStart,
  };
}
