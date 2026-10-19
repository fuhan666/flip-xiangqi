import type { MemberSnapshot } from '../../network/protocol';
import { describeSideDisplay, displaySides, type LobbyState, type SideDisplay } from '../../network/lobby';

interface MemberListProps {
  members: MemberSnapshot[];
  selfId: string | null;
  lobby: LobbyState | null;
}

interface SpectatorListProps {
  members: MemberSnapshot[];
  selfId?: string | null;
}

function memberLabel(member: MemberSnapshot): string {
  return member.role === 'host' ? '房主' : '客人';
}

function offlineLabel(member: MemberSnapshot): string {
  return member.leaveReason === 'dropped' ? '已掉线' : '已离开';
}

/** 旁观者名单：只读身份，无执色归属与准备灯；在线人数只计当前在线成员。 */
export function SpectatorList({ members, selfId }: SpectatorListProps) {
  const spectators = members.filter((member) => member.role === 'spectator');
  const onlineCount = spectators.filter((member) => member.connected).length;
  return (
    <div className="spectator-block" data-testid="spectator-list">
      <p className="spectator-count" data-testid="spectator-count">
        旁观 {onlineCount} 人在线{spectators.length > onlineCount ? `（共 ${spectators.length} 人）` : ''}
      </p>
      <ul aria-label="旁观者" className="spectator-list">
        {spectators.map((member) => (
          <li
            className={`spectator-card${member.connected ? '' : ' spectator-card-offline'}`}
            data-testid="spectator-item"
            key={member.id}
          >
            <span aria-hidden="true" className="spectator-badge">
              👀
            </span>
            <span className="member-name">
              旁观 · {member.name}
              {member.id === selfId ? '（你）' : ''}
            </span>
            <span
              className={`member-status${member.connected ? ' member-status-online' : ' member-status-offline'}`}
              data-testid="spectator-status"
            >
              {member.connected ? '在线' : offlineLabel(member)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 房间成员列表：两位执色玩家（昵称 + 红黑归属 + 就绪灯 + 连接状态），离线成员置灰并标注原因。旁观者另见 SpectatorList。 */
export function MemberList({ members, selfId, lobby }: MemberListProps) {
  const players = members.filter(
    (member): member is MemberSnapshot & { role: 'host' | 'guest' } => member.role !== 'spectator',
  );
  const hasGuest = players.some((member) => member.role === 'guest');
  const sides: Record<'host' | 'guest', SideDisplay> = lobby ? displaySides(lobby) : { host: 'pending', guest: 'pending' };

  return (
    <ul aria-label="房间成员" className="member-list" data-testid="member-list">
      {players.map((member) => {
        const ready = Boolean(lobby?.ready[member.role]);
        return (
          <li
            className={`member-card${member.connected ? '' : ' member-card-offline'}`}
            data-testid={`member-${member.role}`}
            key={member.id}
          >
            <span aria-hidden="true" className={`member-crown${member.role === 'host' ? ' member-crown-host' : ''}`}>
              {member.role === 'host' ? '♛' : '♟'}
            </span>
            <span className="member-name">
              {memberLabel(member)}
              {member.id === selfId ? '（你）' : ''}
            </span>
            <span className={`member-side member-side-${sides[member.role]}`} data-testid={`member-side-${member.role}`}>
              {describeSideDisplay(sides[member.role])}
            </span>
            <span className={`member-ready${ready ? ' member-ready-on' : ''}`} data-testid={`member-ready-${member.role}`}>
              <span aria-hidden="true" className="ready-lamp" />
              {ready ? '已准备' : '未准备'}
            </span>
            <span className={`member-status${member.connected ? ' member-status-online' : ' member-status-offline'}`}>
              {member.connected ? '在线' : offlineLabel(member)}
            </span>
          </li>
        );
      })}
      {hasGuest ? null : (
        <li className="member-card member-card-pending" data-testid="member-guest-pending">
          <span aria-hidden="true" className="member-crown">
            ♟
          </span>
          <span className="member-name">客人</span>
          <span className={`member-side member-side-${sides.guest}`}>{describeSideDisplay(sides.guest)}</span>
          <span className="member-ready">
            <span aria-hidden="true" className="ready-lamp" />
            未准备
          </span>
          <span className="member-status">等待加入…</span>
        </li>
      )}
    </ul>
  );
}
