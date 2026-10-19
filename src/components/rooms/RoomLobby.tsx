import type { ReactNode } from 'react';
import type {
  LobbyRejection,
  MemberSnapshot,
  PlayerRole,
  Role,
  SidePreference,
  TimeControlId,
} from '../../network/protocol';
import type { LobbyRequestKind } from '../../network/client';
import {
  TIME_CONTROLS,
  describeSideDisplay,
  displaySides,
  findTimeControl,
  sideOptionViews,
  type LobbyState,
} from '../../network/lobby';
import { MemberList, SpectatorList } from './MemberList';

interface RoomLobbyProps {
  members: MemberSnapshot[];
  selfId: string | null;
  viewerRole: Role | null;
  /** 服务端权威大厅快照；握手完成前为 null，只渲染成员区。 */
  lobby: LobbyState | null;
  pendingCommand: LobbyRequestKind | null;
  lastRejection: LobbyRejection | null;
  onSettingsChange: (sidePreference: SidePreference, timeControlId: TimeControlId) => void;
  onLockChange: (locked: boolean) => void;
  onReadyToggle: (ready: boolean) => void;
  onStart: () => void;
  /** 成员区下方的连接状态说明（建房/加入两端各自文案）。 */
  connectionHint?: ReactNode;
  /** 是否处于断线重连中（重连期间禁用设置/准备/开始发送动作，退出入口保持可用）。 */
  reconnecting?: boolean;
}

/** 双方归属摘要：随机分先在开局前显示「待开局确定」。 */
function sideSummary(lobby: LobbyState): string {
  const sides = displaySides(lobby);
  const suffix = lobby.startParameters ? '' : lobby.settings.sidePreference === 'random' ? '（随机分先，开局前掷定）' : '';
  return `房主：${describeSideDisplay(sides.host)} · 客人：${describeSideDisplay(sides.guest)}${suffix}`;
}

function startSummary(lobby: LobbyState, viewerRole: PlayerRole | null): string {
  const parameters = lobby.startParameters;
  if (!parameters) {
    return '';
  }
  const time = findTimeControl(parameters.timeControlId);
  if (viewerRole === null) {
    // 旁观视角：固定红方在下，只描述双方归属，不出玩家口吻文案。
    return `旁观视角（红方在下） · 局时 ${time.label}（${time.description}）`;
  }
  const selfSeat = parameters.players.find((seat) => seat.role === viewerRole);
  const opponentSeat = parameters.players.find((seat) => seat.role !== viewerRole);
  return `你执${selfSeat?.side === 'red' ? '红' : '黑'}，对手执${opponentSeat?.side === 'red' ? '红' : '黑'} · 局时 ${time.label}（${time.description}）`;
}

function startSnapshot(lobby: LobbyState): string {
  const parameters = lobby.startParameters;
  if (!parameters) {
    return '';
  }
  const time = findTimeControl(parameters.timeControlId);
  const redSeat = parameters.players.find((seat) => seat.side === 'red');
  const blackSeat = parameters.players.find((seat) => seat.side === 'black');
  const preference = parameters.sidePreference === 'random' ? '随机分先' : parameters.sidePreference === 'host-red' ? '房主执红' : '房主执黑';
  return `开局参数快照：分先「${preference}」 → ${redSeat?.name ?? '红方'}执红 · ${blackSeat?.name ?? '黑方'}执黑 · 局时「${time.label}（${time.description}）」 · 设置版本 v${parameters.settingsVersion}`;
}

/** 房间大厅：成员区 + 对局设置 + 就绪/开始操作区（两端共用一套视图）。 */
export function RoomLobby({
  members,
  selfId,
  viewerRole,
  lobby,
  pendingCommand,
  lastRejection,
  onSettingsChange,
  onLockChange,
  onReadyToggle,
  onStart,
  connectionHint,
  reconnecting = false,
}: RoomLobbyProps) {
  const started = lobby?.phase === 'started';
  const isSpectator = viewerRole === 'spectator';
  const playerRole: PlayerRole | null = viewerRole === 'host' || viewerRole === 'guest' ? viewerRole : null;
  const settingsEditable = Boolean(lobby && viewerRole === 'host' && !lobby.settings.locked && !started && !reconnecting);
  const ownReady = Boolean(playerRole && lobby?.ready[playerRole]);
  const allReady = Boolean(lobby && lobby.ready.host && lobby.ready.guest && lobby.presence.host && lobby.presence.guest);
  const busy = pendingCommand !== null || reconnecting;
  const startHint =
    !lobby || started || isSpectator
      ? null
      : allReady
        ? viewerRole === 'host'
          ? '双方已就绪，可以开始对局'
          : '双方已就绪，等待房主开始对局'
        : viewerRole === 'host'
          ? '等待双方准备'
          : '双方准备后，由房主开始对局';

  return (
    <>
      <section className="room-panel">
        <h2>房间成员</h2>
        <MemberList lobby={lobby} members={members} selfId={selfId} />
        <SpectatorList members={members} selfId={selfId} />
        {connectionHint}
      </section>

      {lobby ? (
        <section className="room-panel">
          <h2>对局设置</h2>
          {lobby.settings.locked && !started ? (
            <p className="room-hint" data-testid="settings-locked-note">
              设置已锁定 —— 分先与局时不再变化，双方可安心准备
            </p>
          ) : null}

          <fieldset className="setting-group" disabled={!settingsEditable}>
            <legend>分先方式</legend>
            <div className="setting-options" data-testid="setting-side-group">
              {sideOptionViews(playerRole ?? 'host').map((option) => (
                <label className="setting-option" key={option.id}>
                  <input
                    aria-label={option.label}
                    checked={lobby.settings.sidePreference === option.id}
                    data-testid={`setting-side-${option.id}`}
                    name="lobby-side"
                    onChange={() => {
                      if (settingsEditable) {
                        onSettingsChange(option.id, lobby.settings.timeControlId);
                      }
                    }}
                    type="radio"
                    value={option.id}
                  />
                  <span className="setting-option-label">{option.label}</span>
                  <span className="setting-option-desc">{option.description}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="setting-group" disabled={!settingsEditable}>
            <legend>局时</legend>
            <div className="setting-options" data-testid="setting-time-group">
              {TIME_CONTROLS.map((option) => (
                <label className="setting-option" key={option.id}>
                  <input
                    aria-label={option.label}
                    checked={lobby.settings.timeControlId === option.id}
                    data-testid={`setting-time-${option.id}`}
                    name="lobby-time"
                    onChange={() => {
                      if (settingsEditable) {
                        onSettingsChange(lobby.settings.sidePreference, option.id);
                      }
                    }}
                    type="radio"
                    value={option.id}
                  />
                  <span className="setting-option-label">{option.label}</span>
                  <span className="setting-option-desc">{option.description}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <p className="room-hint" data-testid="side-summary">
            {sideSummary(lobby)}
          </p>

          {viewerRole === 'host' && !started ? (
            <div className="panel-actions">
              <button
                className="panel-action-secondary"
                data-testid="settings-lock"
                disabled={busy}
                onClick={() => onLockChange(!lobby.settings.locked)}
                type="button"
              >
                {lobby.settings.locked ? '解锁设置' : '锁定设置'}
              </button>
            </div>
          ) : null}
          {viewerRole !== 'host' && !started ? (
            <p className="room-hint" data-testid="settings-readonly-note">
              {isSpectator
                ? '旁观模式：设置与准备均为只读 —— 你看到的是实时同步的结果'
                : '设置由房主决定 —— 你看到的是实时同步的结果'}
            </p>
          ) : null}
        </section>
      ) : null}

      {lobby ? (
        <section className="room-panel">
          <h2>{started ? '对局已开始' : '准备就绪'}</h2>
          {started ? (
            <>
              <p className="room-notice" data-testid="lobby-started">
                {startSummary(lobby, playerRole)}
              </p>
              <p className="room-hint" data-testid="start-snapshot">
                {startSnapshot(lobby)}
              </p>
            </>
          ) : isSpectator ? (
            <p className="room-hint" data-testid="spectator-waiting-note">
              旁观中 —— 不参与准备与开局 —— 对局开始后自动进入观战
            </p>
          ) : (
            <>
              <div className="panel-actions">
                <button
                  className="panel-action-primary"
                  data-testid="lobby-ready-toggle"
                  disabled={busy}
                  onClick={() => onReadyToggle(!ownReady)}
                  type="button"
                >
                  {busy && pendingCommand === 'ready' ? '提交中…' : ownReady ? '取消准备' : '准备'}
                </button>
                {viewerRole === 'host' ? (
                  <button
                    className={allReady ? 'panel-action-gold' : 'panel-action-secondary'}
                    data-testid="lobby-start"
                    disabled={busy}
                    onClick={onStart}
                    type="button"
                  >
                    {busy && pendingCommand === 'start' ? '开始中…' : '开始对局'}
                  </button>
                ) : null}
              </div>
              {startHint ? (
                <p aria-live="polite" className="room-hint" data-testid="lobby-start-hint">
                  {startHint}
                </p>
              ) : null}
            </>
          )}
          {lastRejection ? (
            <p aria-live="assertive" className="room-error" data-testid="lobby-notice">
              {lastRejection.message}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
