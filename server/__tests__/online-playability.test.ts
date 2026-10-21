// @vitest-environment node
/**
 * 联机可玩性回归（真实会话 + 公开视图）：
 * 两端只凭公开数据即可完成 翻牌 → 走子 → 吃子 → 悔棋 → 认输结算，
 * 且整条链路上的每条出站消息都不携带内部棋局数据。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSession, type RoomSessionOptions, type SessionConnection } from '../room-session';
import { asConnectionId, generateId, type ConnectionId } from '../room-identity';
import {
  buildClientGameAction,
  buildClientGameNegotiate,
  buildClientGameNegotiateReply,
  buildClientGameResign,
  buildClientHello,
  buildClientLobbyReady,
  buildClientLobbyStart,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
} from '../../src/network/protocol';

type AnyMessage = Record<string, any>;

class FakeConnection implements SessionConnection {
  readonly connectionId: ConnectionId = asConnectionId(generateId());
  readonly sent: AnyMessage[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(): void {}
  last(type: string): AnyMessage | null {
    const matches = this.sent.filter((message) => message.type === type);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }
}

function deliver(session: RoomSession, connection: FakeConnection, message: ClientMessage): void {
  const parsed = parseClientMessage(encodeMessage(message));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    session.handleMessage(connection.connectionId, parsed.message);
  }
}

describe('联机两端可玩（公开数据驱动）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('翻牌、走子、吃子、悔棋与结算都能只靠公开投影完成', () => {
    vi.useFakeTimers();
    let now = 10_000;
    const options: RoomSessionOptions = {
      nowFn: () => now,
      drawHostRed: () => true,
      drawSeed: () => 42,
      clockIntervalMs: 60_000,
      logger: () => undefined,
    };
    const session = new RoomSession(options);
    const host = new FakeConnection();
    const guest = new FakeConnection();
    session.attach(host);
    deliver(session, host, buildClientHello({ role: 'host', name: '房主', roomId: session.roomId, token: session.hostToken }));
    session.attach(guest);
    deliver(session, guest, buildClientHello({ role: 'guest', name: '客人', roomId: session.roomId }));
    deliver(session, host, buildClientLobbyReady(session.roomId, true, 1));
    deliver(session, guest, buildClientLobbyReady(session.roomId, true, 1));
    deliver(session, host, buildClientLobbyStart(session.roomId));

    const matchId = session.getPublicMatch()!.matchId;
    const byMember = new Map([
      [session.getMatch()!.startParameters.redMemberId, host],
      [session.getMatch()!.startParameters.blackMemberId, guest],
    ]);
    const connectionFor = (camp: 'red' | 'black') =>
      byMember.get(
        camp === 'red'
          ? session.getMatch()!.startParameters.redMemberId
          : session.getMatch()!.startParameters.blackMemberId,
      )!;

    let captureSeen = false;
    let captureSnapshot: AnyMessage | null = null;

    for (let step = 0; step < 80 && !captureSeen; step += 1) {
      const publicState = session.getPublicMatch()!.gameState;
      const actor = connectionFor(publicState.currentTurn);
      const requestId = `r-${step}`;

      const captureGroup = publicState.legalMoves
        .flatMap((group) => group.targets.map((target) => ({ group, target })))
        .find((entry) => entry.target.kind === 'capture');

      if (captureGroup) {
        deliver(
          session,
          actor,
          buildClientGameAction(session.roomId, {
            requestId,
            matchId,
            stepNumber: session.getPublicMatch()!.stepNumber,
            revision: session.getPublicMatch()!.revision,
            action: {
              type: 'move',
              from: captureGroup.group.from,
              to: captureGroup.target.position,
            },
          }),
        );
        captureSeen = true;
        captureSnapshot = actor.last('game.patch');
        break;
      }

      const moved = publicState.legalMoves
        .flatMap((group) => group.targets.map((target) => ({ group, target })))
        .find((entry) => entry.target.kind === 'empty');

      if (moved && step % 2 === 1) {
        // 隔步走子：让局面在棋盘上真正流动起来
        deliver(
          session,
          actor,
          buildClientGameAction(session.roomId, {
            requestId,
            matchId,
            stepNumber: session.getPublicMatch()!.stepNumber,
            revision: session.getPublicMatch()!.revision,
            action: { type: 'move', from: moved.group.from, to: moved.target.position },
          }),
        );
        continue;
      }

      const hidden = publicState.pieces.find((piece) => !piece.revealed)!;
      deliver(
        session,
        actor,
        buildClientGameAction(session.roomId, {
          requestId,
          matchId,
          stepNumber: session.getPublicMatch()!.stepNumber,
          revision: session.getPublicMatch()!.revision,
          action: { type: 'flip', position: hidden.position },
        }),
      );
    }

    expect(captureSeen).toBe(true);
    const captured = captureSnapshot!.payload.changes.history.append.at(-1);
    expect(captured.consequences.some((consequence: AnyMessage) => consequence.type === 'capture')).toBe(true);

    // 悔棋：请求 → 同意后，被吃棋子重新回到棋盘（公开视图同样恢复）
    const before = session.getPublicMatch()!;
    const requester = connectionFor(before.gameState.currentTurn);
    const responder = requester === host ? guest : host;
    deliver(
      session,
      requester,
      buildClientGameNegotiate(session.roomId, {
        requestId: 'undo-1',
        matchId,
        revision: before.revision,
        kind: 'undo',
      }),
    );
    const pending = session.getPublicMatch()!.pendingNegotiation;
    expect(pending).not.toBeNull();
    deliver(
      session,
      responder,
      buildClientGameNegotiateReply(session.roomId, {
        requestId: 'undo-reply-1',
        matchId,
        negotiationId: pending!.negotiationId,
        accept: true,
      }),
    );
    const undone = session.getPublicMatch()!;
    expect(undone.stepNumber).toBe(before.stepNumber - 1);
    expect(undone.gameState.actionHistory).toHaveLength(before.gameState.actionHistory.length - 1);
    expect(undone.gameState.pieces.filter((piece) => piece.revealed && piece.captured)).toHaveLength(0);

    // 认输结算：公开视图给出胜者与原因，且不含内部数据
    const loserCamp = undone.gameState.currentTurn;
    const loser = connectionFor(loserCamp);
    deliver(
      session,
      loser,
      buildClientGameResign(session.roomId, {
        requestId: 'resign-1',
        matchId,
        revision: session.getPublicMatch()!.revision,
      }),
    );
    const settled = session.getPublicMatch()!;
    expect(settled.settlement).not.toBeNull();
    expect(settled.settlement!.reason).toBe('resignation');
    expect(settled.gameState.winner).toBe(loserCamp === 'red' ? 'black' : 'red');
    expect(settled.gameState.legalMoves).toHaveLength(0);

    // 所有出站消息都不含内部字段与内部棋子 ID
    for (const connection of [host, guest]) {
      for (const message of connection.sent) {
        const serialized = JSON.stringify(message);
        expect(serialized).not.toContain('"seed"');
        expect(serialized).not.toContain('"initial"');
        expect(serialized).not.toContain('"undoStack"');
        expect(serialized).not.toMatch(/(black|red)-(king|rook|cannon|horse|elephant|advisor|pawn)-/);
        if (message.type === 'game.state' || message.type === 'game.rejected') {
          for (const piece of message.payload.state.pieces) {
            if (!piece.revealed) {
              expect(Object.keys(piece).sort()).toEqual(['id', 'position', 'revealed']);
            }
          }
        }
      }
    }
  });
});
