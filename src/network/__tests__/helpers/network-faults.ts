import { WebSocket } from 'ws';
import type { WebSocketLike } from '../../client';

type Direction = 'send' | 'receive';
interface Packet { type: string; requestId?: string }
export interface Fault {
  direction: Direction;
  type: string;
  requestId?: string;
  generation?: number;
  effect: 'drop' | 'delay' | 'duplicate' | 'hold' | 'disconnect';
  delayMs?: number;
  count?: number;
}

/** Scripted application delivery faults; never logs payloads or credentials. */
export class NetworkFaults {
  rules: Fault[] = [];
  log: Array<Packet & { direction: Direction; generation: number; effect: string; delayMs: number }> = [];
  sockets: WebSocket[] = [];
  held: Array<() => void> = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();

  factory = (url: string): WebSocketLike => {
    const generation = this.sockets.length;
    const ws = new WebSocket(url);
    this.sockets.push(ws);
    const facade: WebSocketLike = {
      get readyState() { return ws.readyState; },
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send: raw => this.deliver('send', generation, raw, () => { if (ws.readyState === 1) ws.send(raw); }),
      close: (code, reason) => ws.close(code, reason),
    };
    ws.on('open', () => facade.onopen?.({}));
    ws.on('message', raw => {
      const callback = facade.onmessage;
      this.deliver('receive', generation, raw.toString(), () => callback?.({ data: raw.toString() }));
    });
    ws.on('close', code => facade.onclose?.({ code }));
    ws.on('error', error => facade.onerror?.(error));
    return facade;
  };

  private later(fn: () => void, delayMs: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, delayMs);
    this.timers.add(timer);
  }

  private deliver(direction: Direction, generation: number, raw: string, deliver: () => void) {
    const packet: Packet = JSON.parse(raw);
    const rule = this.rules.find(r => r.direction === direction && r.type === packet.type &&
      (r.requestId === undefined || r.requestId === packet.requestId) &&
      (r.generation === undefined || r.generation === generation));
    if (!rule) { deliver(); return; }
    this.log.push({ type: packet.type, requestId: packet.requestId, direction, generation, effect: rule.effect, delayMs: rule.delayMs ?? 0 });
    if ((rule.count ?? 1) <= 1) this.rules.splice(this.rules.indexOf(rule), 1);
    else rule.count!--;
    switch (rule.effect) {
      case 'drop': return;
      case 'disconnect': this.sockets[generation].terminate(); return;
      case 'hold': this.held.push(deliver); return;
      case 'delay': this.later(deliver, rule.delayMs ?? 0); return;
      case 'duplicate': deliver(); this.later(deliver, rule.delayMs ?? 0); return;
    }
  }

  releaseReverse() { this.held.splice(0).reverse().forEach(deliver => deliver()); }
  close() {
    this.timers.forEach(clearTimeout); this.timers.clear(); this.held = [];
    this.sockets.forEach(ws => ws.terminate());
  }
}
