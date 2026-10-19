import type { Page, WebSocketRoute } from '@playwright/test';
import type { ConnectionState } from '../../src/network/client';

interface Rule {
  direction: 'send' | 'receive';
  type: string;
  effect: 'drop' | 'delay' | 'duplicate' | 'hold';
  requestId?: string;
  generation?: number;
  delayMs?: number;
  count?: number;
}

/** Application delivery injection, in addition to real WebSocket disconnects. */
export class BrowserNetworkFaults {
  rules: Rule[] = [];
  log: Array<{ direction: string; type: string; effect: string; generation: number; delayMs: number }> = [];
  connections: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = [];
  held: Array<() => void> = [];
  authority: any = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  async install(page: Page) {
    await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
      const generation = this.connections.length;
      const server = route.connectToServer();
      this.connections.push({ page: route, server });
      const forward = (direction: 'send' | 'receive', raw: string | Buffer, send: () => void) => {
        const packet = JSON.parse(raw.toString());
        if (direction === 'receive' && packet.type === 'game.state') this.authority = packet.payload;
        const rule = this.rules.find(r => r.direction === direction && r.type === packet.type &&
          (r.requestId === undefined || r.requestId === packet.requestId) &&
          (r.generation === undefined || r.generation === generation));
        if (!rule) { send(); return; }
        this.log.push({ direction, type: packet.type, effect: rule.effect, generation, delayMs: rule.delayMs ?? 0 });
        if ((rule.count ?? 1) <= 1) this.rules.splice(this.rules.indexOf(rule), 1);
        else rule.count!--;
        if (rule.effect === 'drop') return;
        if (rule.effect === 'hold') { this.held.push(send); return; }
        if (rule.effect === 'duplicate') send();
        const timer = setTimeout(() => { this.timers.delete(timer); send(); }, rule.delayMs ?? 0);
        this.timers.add(timer);
      };
      route.onMessage(raw => forward('send', raw, () => server.send(raw)));
      server.onMessage(raw => forward('receive', raw, () => route.send(raw)));
    });
  }

  async disconnect() {
    const current = this.connections.at(-1)!;
    await current.server.close({ code: 3999, reason: 'scripted-disconnect' });
    await current.page.close({ code: 3999, reason: 'scripted-disconnect' });
  }
  release() { this.held.splice(0).reverse().forEach(send => send()); }
  dispose() { this.timers.forEach(clearTimeout); this.timers.clear(); this.held = []; }
}

/** Read the actual client adopted by React, with no production debug API. */
export async function adoptedState(page: Page, sync = false): Promise<ConnectionState> {
  return page.evaluate(doSync => {
    const element = document.querySelector('[data-testid="online-game"]') as any;
    const key = Object.keys(element ?? {}).find(k => k.startsWith('__reactFiber$'));
    let fiber = key ? element[key] : null;
    while (fiber) {
      const client = fiber.memoizedProps?.client;
      if (client?.getState) {
        if (doSync) client.requestGameSync();
        return client.getState();
      }
      fiber = fiber.return;
    }
    throw new Error('OnlineGame client not mounted');
  }, sync);
}
