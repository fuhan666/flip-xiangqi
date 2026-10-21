// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { RoomServer } from '../../../server/room-server';
import { RoomClient } from '../client';
import { NetworkFaults } from './helpers/network-faults';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('state did not converge before deadline');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function setup() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  let now = Date.now();
  const server = new RoomServer({ preferredPort: port, drawHostRed: () => true, drawSeed: () => 42,
    nowFn: () => now, clockIntervalMs: 20, logger: () => undefined });
  await server.start();
  const faults = [new NetworkFaults(), new NetworkFaults(), new NetworkFaults()];
  const clients = faults.map(f => new RoomClient({ webSocketFactory: f.factory, reconnectDelays: [20], random: () => 1 }));
  cleanups.push(async () => { clients.forEach(c => c.disconnect()); faults.forEach(f => f.close()); await server.closeRoom(); });
  const [host, guest, spectator] = clients;
  host.connect({ host: '127.0.0.1', port }, { role: 'host', name: '红', token: server.hostToken });
  await until(() => host.getState().status === 'connected');
  guest.connect({ host: '127.0.0.1', port }, { role: 'guest', name: '黑' });
  spectator.connect({ host: '127.0.0.1', port }, { role: 'spectator', name: '观' });
  await until(() => clients.every(c => c.getState().status === 'connected'), 5000);
  host.sendLobbySettings('host-red', 'standard');
  await until(() => guest.getState().lobby?.settings.sidePreference === 'host-red');
  host.sendLobbyReady(true); guest.sendLobbyReady(true);
  await until(() => host.getState().lobby?.ready.host === true && host.getState().lobby?.ready.guest === true);
  host.sendLobbyStart();
  await until(() => clients.every(c => c.getState().game !== null));
  async function consistent(step: number) {
    await until(() => clients.every(c => c.getState().game!.stepNumber === step && c.getState().game!.pendingAction === null));
    clients.forEach(c => c.requestGameSync());
    await until(() => clients.every(c => c.getState().game!.revision === server.getPublicMatch()!.revision));
    const authority = server.getPublicMatch()!;
    for (const client of clients) {
      const actual = client.getState().game!;
      expect(actual.gameState).toEqual(authority.gameState);
      expect(actual.matchEvents).toEqual(authority.matchEvents);
      expect(actual.pendingNegotiation).toEqual(authority.pendingNegotiation);
      expect(actual.settlement).toEqual(authority.settlement);
      expect(actual.clock!.paused).toBe(authority.clock!.paused);
      expect(actual.clock!.turn).toBe(authority.clock!.turn);
    }
  }
  return { server, faults, clients, host, guest, spectator, consistent, advance: (ms: number) => { now += ms; } };
}

describe('real room fault matrix', () => {
  it('100–500ms bidirectional jitter and a lost action acknowledgement converge within 6.5s', async () => {
    const f = await setup();
    f.faults[0].rules.push({ direction: 'send', type: 'game.action', effect: 'delay', delayMs: 500 });
    f.faults[0].rules.push({ direction: 'receive', type: 'game.patch', effect: 'drop' });
    f.faults[1].rules.push({ direction: 'receive', type: 'game.patch', effect: 'delay', delayMs: 100 });
    f.faults[2].rules.push({ direction: 'receive', type: 'game.patch', effect: 'delay', delayMs: 300 });
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await until(() => f.clients.every(c => c.getState().game!.stepNumber === 1 && c.getState().game!.pendingAction === null), 6500);
    await f.consistent(1);
    f.guest.sendGameAction({ type: 'flip', position: { x: 0, y: 3 } });
    await f.consistent(2);
    expect(f.faults.flatMap(t => t.log).map(entry => entry.effect)).toContain('drop');
  }, 10000);

  it.each(['drop', 'disconnect'] as const)('unreceived action: %s then recover and make the next move', async effect => {
    const f = await setup();
    f.faults[0].rules.push({ direction: 'send', type: 'game.action', effect });
    expect(f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } }).ok).toBe(true);
    await until(() => f.host.getState().status === 'connected' && f.host.getState().game!.pendingAction === null, 6500);
    await f.consistent(0);
    expect(f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } }).ok).toBe(true);
    await f.consistent(1);
    expect(f.server.getMatch()!.gameState.actionHistory).toHaveLength(1);
  }, 10000);

  it('lost rejection while heartbeats continue clears the action and adopts the pending negotiation', async () => {
    const f = await setup();
    f.faults[0].rules.push({ direction: 'receive', type: 'game.patch', effect: 'hold' });
    f.faults[0].rules.push({ direction: 'receive', type: 'game.clock', effect: 'drop', count: 200 });
    f.guest.sendGameNegotiate('draw');
    await until(() => f.server.getMatch()!.pendingNegotiation !== null);
    f.faults[0].rules.push({ direction: 'receive', type: 'game.rejected', effect: 'drop' });
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await until(() => f.host.getState().game!.pendingAction === null, 6500);
    expect(f.host.getState().game!.pendingNegotiation).not.toBeNull();
    f.faults[0].rules = [];
    f.host.sendGameNegotiateReply(false);
    await until(() => f.clients.every(c => !c.getState().game!.pendingNegotiation));
    f.faults[0].releaseReverse();
    await f.consistent(0);
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await f.consistent(1);
  }, 10000);

  it('committed action with lost acknowledgement, duplicate action and reversed delayed state commits once', async () => {
    const f = await setup();
    f.faults[0].rules.push({ direction: 'receive', type: 'game.patch', effect: 'disconnect' });
    expect(f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } }).ok).toBe(true);
    await until(() => f.faults[0].sockets.length === 2 && f.host.getState().status === 'connected');
    await f.consistent(1);
    f.faults[1].rules.push({ direction: 'send', type: 'game.action', effect: 'duplicate', delayMs: 50 });
    f.faults[2].rules.push({ direction: 'receive', type: 'game.patch', effect: 'hold' });
    f.faults[2].rules.push({ direction: 'receive', type: 'game.state', effect: 'hold' });
    expect(f.guest.sendGameAction({ type: 'flip', position: { x: 0, y: 3 } }).ok).toBe(true);
    await until(() => f.server.getMatch()!.stepNumber === 2);
    f.spectator.requestGameSync();
    await until(() => f.faults[2].held.length === 2);
    f.faults[2].releaseReverse();
    await f.consistent(2);
    expect(f.server.getMatch()!.gameState.actionHistory).toHaveLength(2);
  });

  it.each(['undo', 'draw'] as const)('%s disconnect cancellation clears both clock pauses and ignores old reply', async kind => {
    const f = await setup();
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await f.consistent(1);
    f.host.sendGameNegotiate(kind);
    await until(() => f.clients.every(c => c.getState().game!.pendingNegotiation !== null));
    f.faults[1].rules.push({ direction: 'send', type: 'game.negotiate.reply', effect: 'hold' });
    f.guest.sendGameNegotiateReply(true);
    await until(() => f.faults[1].held.length === 1);
    f.advance(8000);
    f.faults[1].sockets.at(-1)!.terminate();
    await until(() => f.faults[1].sockets.length === 2 && f.guest.getState().status === 'connected');
    await f.consistent(1);
    expect(f.server.getMatch()!.clock.paused).toBe(false);
    const before = f.server.getMatch()!.clock.black.baseTimeRemainingMs!;
    f.advance(1000);
    await until(() => f.server.getMatch()!.clock.black.baseTimeRemainingMs! < before);
    f.faults[1].releaseReverse();
    f.guest.sendGameAction({ type: 'flip', position: { x: 0, y: 3 } });
    await f.consistent(2);
  });

  it('lost negotiation completion and terminal broadcast converge with healthy heartbeats', async () => {
    const f = await setup();
    f.host.sendGameNegotiate('draw');
    await until(() => f.clients.every(c => c.getState().game!.pendingNegotiation !== null));
    f.faults[0].rules.push({ direction: 'receive', type: 'game.patch', effect: 'drop' });
    f.faults[2].rules.push({ direction: 'receive', type: 'game.patch', effect: 'drop' });
    f.guest.sendGameNegotiateReply(true);
    await until(() => f.clients.every(c => c.getState().game!.settlement?.reason === 'draw-agreement'), 6500);
    await f.consistent(0);
    expect(f.faults[0].sockets).toHaveLength(1);
  }, 10000);

  it('spectator drop preserves negotiation; deadline and response overlap settles only once', async () => {
    const f = await setup();
    f.host.sendGameNegotiate('draw');
    await until(() => f.guest.getState().game!.pendingNegotiation !== null);
    f.faults[2].sockets.at(-1)!.terminate();
    await until(() => f.faults[2].sockets.length === 2 && f.spectator.getState().status === 'connected');
    expect(f.server.getMatch()!.pendingNegotiation).not.toBeNull();
    f.advance(30001);
    f.guest.sendGameNegotiateReply(true);
    await until(() => f.clients.every(c => c.getState().game!.pendingNegotiation === null));
    await f.consistent(0);
    expect(f.server.getMatch()!.settlement).toBeNull();
    expect(f.server.getMatch()!.matchEvents!.filter(e => e.type === 'draw-timeout')).toHaveLength(1);
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await f.consistent(1);
  });

  it('repeated host/guest/spectator drops share handshakes and retain one seat per role', async () => {
    const f = await setup();
    for (let round = 0; round < 3; round++) {
      f.faults.forEach(transport => transport.sockets.at(-1)!.terminate());
      await until(() => f.clients.every(c => c.getState().status === 'reconnecting'));
      f.clients.forEach(c => { c.reconnect(); c.reconnect(); c.reconnect(); });
      await until(() => f.clients.every(c => c.getState().status === 'connected'));
      expect(f.server.getMembers()).toHaveLength(3);
      expect(f.server.getMembers().every(m => m.connected)).toBe(true);
      await f.consistent(0);
    }
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await f.consistent(1);
  });

  it('a dropped opponent patch converges through the 5s version check without a manual sync', async () => {
    const f = await setup();
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await until(() => f.clients.every(c => c.getState().game!.stepNumber === 1 && c.getState().game!.pendingAction === null));

    f.faults[0].rules.push({ direction: 'receive', type: 'game.patch', effect: 'drop', count: 5 });
    f.guest.sendGameAction({ type: 'flip', position: { x: 0, y: 3 } });
    await until(() => f.server.getMatch()!.stepNumber === 2);
    // 房主错过对手的补丁：自己没有任何在途动作，只能靠 5 秒版本核对发现并恢复。
    expect(f.host.getState().game!.stepNumber).toBe(1);
    expect(f.host.getState().game!.pendingAction).toBeNull();

    await until(() => f.host.getState().game!.stepNumber === 2, 8000);
    const authority = f.server.getPublicMatch()!;
    expect(f.host.getState().game!.revision).toBe(authority.revision);
    expect(f.host.getState().game!.gameState).toEqual(authority.gameState);
    expect(f.host.getState().game!.matchEvents).toEqual(authority.matchEvents);
    // 不自动重放：房主没有重发任何动作。
    expect(f.server.getMatch()!.gameState.actionHistory).toHaveLength(2);
  }, 12000);

  it('a lost terminal settlement patch is found by the version check after the clock stops', async () => {
    const f = await setup();
    // 先让双方自然收敛，不发任何手动同步请求。
    f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
    await until(() => f.clients.every(c => c.getState().game!.stepNumber === 1 && c.getState().game!.pendingAction === null));

    // 丢掉结算之后到达的所有补丁，模拟终局广播整体遗漏。
    f.faults[1].rules.push({ direction: 'receive', type: 'game.patch', effect: 'drop', count: 5 });
    f.host.sendGameResign();
    await until(() => f.server.getMatch()!.settlement !== null);
    expect(f.guest.getState().game!.settlement).toBeNull();

    await until(() => f.guest.getState().game!.settlement !== null, 8000);
    expect(f.guest.getState().game!.settlement!.reason).toBe('resignation');
    expect(f.guest.getState().game!.gameState.winner).toBe('black');
  }, 12000);

  it.each([89999, 90001])('resume at %dms uses the authoritative grace result', async elapsed => {
    const f = await setup();
    f.faults[1].rules.push({ direction: 'send', type: 'hello', effect: 'hold' });
    f.faults[1].sockets.at(-1)!.terminate();
    await until(() => f.faults[1].held.length === 1);
    f.advance(elapsed);
    f.faults[1].releaseReverse();
    await until(() => f.guest.getState().status === 'connected');
    await f.consistent(0);
    if (elapsed < 90000) {
      expect(f.server.getMatch()!.settlement).toBeNull();
      f.host.sendGameAction({ type: 'flip', position: { x: 0, y: 6 } });
      await f.consistent(1);
    } else expect(f.clients.every(c => c.getState().game!.settlement?.reason === 'disconnect-timeout')).toBe(true);
  });
});
