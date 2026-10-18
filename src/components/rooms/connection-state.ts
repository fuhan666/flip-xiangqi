import type { ConnectionState } from '../../network/client';

export const IDLE_CONNECTION_STATE: ConnectionState = {
  status: 'idle',
  errorCode: null,
  message: null,
  roomId: null,
  memberId: null,
  role: null,
  members: [],
  closedReason: null,
  lobby: null,
  lastRejection: null,
  pendingCommand: null,
  game: null,
  rtt: null,
  reconnecting: false,
  justReconnected: false,
};
