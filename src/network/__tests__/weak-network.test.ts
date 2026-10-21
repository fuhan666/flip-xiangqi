// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomClient, type WebSocketLike } from '../client';
import { buildStartParameters, createLobbyState } from '../lobby';
import { createMatch } from '../match';
import { publicSnapshotOf } from './helpers/public-fixtures';
import { buildServerMessage } from '../protocol';
import { computeReconnectDelay } from '../heartbeat';

/** Application delivery faults; WebSocket itself remains ordered and reliable. */
class ScriptedSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  sent: Array<{ type: string; requestId?: string; payload: any }> = [];
  log: string[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  deliver(message: Parameters<typeof buildServerMessage>[0], delay = 0) {
    // Capture the original callback to exercise generation isolation as well.
    const callback = this.onmessage;
    this.log.push(`${message.type}:delay=${delay}`);
    if (delay) setTimeout(() => callback?.({ data: buildServerMessage(message) }), delay);
    else callback?.({ data: buildServerMessage(message) });
  }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

const clients: RoomClient[] = [];
afterEach(() => { clients.splice(0).forEach(c => c.disconnect()); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  const sockets: ScriptedSocket[] = [];
  const client = new RoomClient({ webSocketFactory: () => {
    const socket = new ScriptedSocket(); sockets.push(socket); return socket;
  } });
  clients.push(client);
  const startParameters = buildStartParameters({
    roomId: 'room', host: { memberId: 'host', name: '红方' }, guest: { memberId: 'guest', name: '黑方' },
    settings: { sidePreference: 'host-red', timeControlId: 'standard', locked: true, settingsVersion: 1 }, hostSide: 'red',
  });
  const snap = publicSnapshotOf(createMatch({ matchId: 'match', seed: 42, startParameters }));
  client.connect({ host: '127.0.0.1', port: 12345 }, { role: 'host', name: '红方', token: 'test' });
  const socket = sockets[0];
  socket.readyState = 1; socket.onopen?.({});
  socket.deliver({ type: 'welcome', roomId: 'room', payload: {
    roomId: 'room', memberId: 'host', role: 'host', name: '红方', members: [], lobby: createLobbyState(), game: snap,
  } });
  const state = (revision = snap.revision) => ({
    type: 'game.state' as const,
    roomId: 'room',
    payload: {
      matchId: snap.matchId,
      stepNumber: snap.stepNumber,
      revision,
      state: snap.gameState,
      startParameters: snap.startParameters,
      ...(snap.clock ? { clock: snap.clock } : {}),
    },
  });
  const clock = (revision: number, sampleSeq: number) => ({
    type: 'game.clock' as const,
    roomId: 'room',
    payload: { matchId: snap.matchId, revision, sampleSeq, clock: { ...snap.clock!, sampleSeq } },
  });
  const pong = () => {
    const ping = socket.sent.filter(m => m.type === 'ping').at(-1);
    if (ping) socket.deliver({ type: 'pong', roomId: 'room', payload: { seq: ping.payload.seq } });
  };
  return { client, socket, sockets, snap, state, clock, pong };
}

describe('bounded weak-network recovery', () => {
  it.each([1999, 2001])('pong at %dms respects the 2s heartbeat boundary', delay => {
    const f = fixture();
    vi.advanceTimersByTime(2000);
    const ping = f.socket.sent.filter(m => m.type === 'ping').at(-1)!;
    f.socket.deliver({ type: 'pong', roomId: 'room', payload: { seq: ping.payload.seq } }, delay);
    vi.advanceTimersByTime(delay);
    expect(f.client.getState().status).toBe(delay < 2000 ? 'connected' : 'reconnecting');
  });

  it('retry jitter is reproducible and bounded by 80–100% of exponential backoff', () => {
    expect(computeReconnectDelay(0, [500, 1000, 2000, 4000], () => 0)).toBe(400);
    expect(computeReconnectDelay(5, [500, 1000, 2000, 4000], () => 1)).toBe(4000);
    expect(computeReconnectDelay(1, [500, 1000, 2000, 4000], () => 0.5)).toBe(900);
  });

  it('explicit sync at the same revision rolls back an unreceived action without replay or sound', () => {
    const f = fixture();
    expect(f.client.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } }).ok).toBe(true);
    f.socket.deliver(f.state());
    expect(f.client.getState().game!.pendingAction).not.toBeNull();
    f.client.requestGameSync();
    const sync = f.socket.sent.at(-1)!;
    f.socket.deliver({ ...f.state(), requestId: sync.requestId });
    expect(f.client.getState().game!.pendingAction).toBeNull();
    expect(f.client.getState().game!.gameState).toEqual(f.snap.gameState);
    expect(f.client.getState().game!.lastAcceptedAction).toBeNull();
  });

  it('requests recovery within 3s when the action or rejection is lost but pongs arrive', () => {
    const f = fixture();
    f.client.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    vi.advanceTimersByTime(2000); f.pong();
    vi.advanceTimersByTime(1000);
    expect(f.socket.sent.filter(m => m.type === 'game.sync')).toHaveLength(1);
    expect(f.socket.sent.filter(m => m.type === 'game.action')).toHaveLength(1);
  });

  it('bounds a lost sync response and coalesces duplicate sync requests', () => {
    const f = fixture();
    f.client.requestGameSync(); f.client.requestGameSync();
    expect(f.socket.sent.filter(m => m.type === 'game.sync')).toHaveLength(1);
    vi.advanceTimersByTime(2000); f.pong();
    vi.advanceTimersByTime(1000);
    expect(f.client.getState().status).toBe('reconnecting');
  });

  it('a sync overtaken by a newer revision cannot leave recovery suspended', () => {
    const f = fixture();
    f.client.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    f.client.requestGameSync();
    const first = f.socket.sent.at(-1)!;
    f.socket.deliver(f.state(1));
    f.socket.deliver({ ...f.state(0), requestId: first.requestId });
    const syncs = f.socket.sent.filter(m => m.type === 'game.sync');
    expect(syncs).toHaveLength(2);
    f.socket.deliver({ ...f.state(1), requestId: syncs[1].requestId });
    expect(f.client.getState().game!.pendingAction).toBeNull();
    expect(f.client.getState().game!.revision).toBe(1);
  });

  it('a clock ahead of the board triggers sync without hiding the missing state revision', () => {
    const f = fixture();
    f.socket.deliver(f.clock(5, 10));
    expect(f.client.getState().game!.revision).toBe(f.snap.revision);
    expect(f.socket.sent.at(-1)!.type).toBe('game.sync');
    f.socket.deliver({ ...f.state(5), requestId: f.socket.sent.at(-1)!.requestId });
    f.socket.deliver(f.clock(5, 11));
    f.socket.deliver(f.clock(4, 12));
    f.socket.deliver(f.clock(5, 9));
    expect(f.client.getState().game!.revision).toBe(5);
    expect(f.client.getState().game!.clock!.sampleSeq).toBe(11);
  });

  it('protocol 6 clocks with the same transition sequence still advance by server time', () => {
    const f = fixture();
    const packet = f.clock(f.snap.revision, f.snap.clock!.sampleSeq);
    packet.payload.clock.serverTime += 1000;
    packet.payload.clock.red.baseTimeRemainingMs! -= 1000;
    f.socket.deliver(packet);
    expect(f.client.getState().game!.clock!.red.baseTimeRemainingMs).toBe(packet.payload.clock.red.baseTimeRemainingMs);
    f.socket.deliver(f.clock(f.snap.revision, f.snap.clock!.sampleSeq));
    f.socket.deliver(f.state());
    expect(f.client.getState().game!.clock!.serverTime).toBe(packet.payload.clock.serverTime);
  });

  it('ignores an old rejection with no pending request after a newer same-step state', () => {
    const f = fixture();
    f.socket.deliver(f.state(5));
    f.socket.deliver({ type: 'game.rejected', roomId: 'room', requestId: 'old', payload: {
      matchId: 'match', stepNumber: 0, state: { ...f.snap.gameState, currentTurn: 'black' }, reason: 'stale',
    } });
    expect(f.client.getState().game!.gameState.currentTurn).toBe('red');
  });

  it('recovers a lost terminal broadcast even when no further board or clock updates arrive', () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) { vi.advanceTimersByTime(2000); f.pong(); }
    vi.advanceTimersByTime(1000);
    expect(f.socket.sent.some(m => m.type === 'game.sync')).toBe(true);
  });

  it('coalesces manual reconnects and ignores delayed messages from the old generation', () => {
    const f = fixture();
    f.socket.deliver(f.state(99), 1500);
    f.socket.drop();
    f.client.reconnect(); f.client.reconnect(); f.client.reconnect();
    expect(f.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1500);
    expect(f.client.getState().game!.revision).toBe(f.snap.revision);
    f.client.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('higher revision undo may lower the step, while old snapshots and a retired match cannot revive it', () => {
    const f = fixture();
    f.socket.deliver({ ...f.state(3), payload: { ...f.state(3).payload, stepNumber: 1 } });
    f.socket.deliver(f.state(4));
    f.socket.deliver({ ...f.state(3), payload: { ...f.state(3).payload, stepNumber: 1 } });
    expect(f.client.getState().game!.stepNumber).toBe(0);
    expect(f.client.getState().game!.revision).toBe(4);
    f.socket.deliver({ type: 'lobby.state', roomId: 'room', payload: { lobby: createLobbyState() } });
    f.socket.deliver(f.state(100));
    expect(f.client.getState().game).toBeNull();
  });
});
