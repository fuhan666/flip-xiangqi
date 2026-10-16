import type { MemberSnapshot } from '../../network/protocol';

interface MemberListProps {
  members: MemberSnapshot[];
  selfId: string | null;
}

function memberLabel(member: MemberSnapshot): string {
  return member.role === 'host' ? '房主' : '客人';
}

/** 房间成员列表：昵称（房主/客人）+ 连接状态，离线成员置灰并标注原因。 */
export function MemberList({ members, selfId }: MemberListProps) {
  const hasGuest = members.some((member) => member.role === 'guest');

  return (
    <ul aria-label="房间成员" className="member-list" data-testid="member-list">
      {members.map((member) => (
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
          <span className={`member-status${member.connected ? ' member-status-online' : ' member-status-offline'}`}>
            {member.connected ? '在线' : '已离开'}
          </span>
        </li>
      ))}
      {hasGuest ? null : (
        <li className="member-card member-card-pending" data-testid="member-guest-pending">
          <span aria-hidden="true" className="member-crown">
            ♟
          </span>
          <span className="member-name">客人</span>
          <span className="member-status">等待加入…</span>
        </li>
      )}
    </ul>
  );
}
