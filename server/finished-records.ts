/**
 * 终局棋谱临时档案：只保存已结算对局的服务端权威 JSON/TXT 与到期时间。
 *
 * - 按 matchId 独立存放，写入后不可覆盖、不可续期；
 * - 只保存字符串与最小元数据，绝不持有可变 MatchState 引用；
 * - 到期由读写检查 + 后台清理双重保证，进程重启后自然清空。
 */
import { snapshotState } from '../src/game/index.js';
import type { MatchState } from '../src/network/match.js';
import type { FinishedRecordSummary } from '../src/network/protocol.js';
import { createRecord, parseRecord, recordJSON, recordText } from '../src/records/record.js';

/** 终局记录保留时长：30 分钟（自结算时刻起）。 */
export const FINISHED_RECORD_TTL_MS = 30 * 60_000;

export interface FinishedRecordEntry extends FinishedRecordSummary {
  roomId: string;
  /** 冻结的两名参与者 memberId；观众不在此列，按房间当前获准成员授权。 */
  memberIds: string[];
  json: string;
  text: string;
}

export interface ArchiveFinishedRecordInput {
  roomId: string;
  matchId: string;
  memberIds: string[];
  endedAt: number;
  json: string;
  text: string;
}

export interface FinishedRecordArchiveOptions {
  nowFn?: () => number;
  ttlMs?: number;
  /** 到期清理周期，默认 60 秒；始终限制在不大于 TTL 的范围内。 */
  sweepIntervalMs?: number;
}

export class FinishedRecordArchive {
  private readonly entries = new Map<string, FinishedRecordEntry>();
  private readonly nowFn: () => number;
  private readonly ttlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(options: FinishedRecordArchiveOptions = {}) {
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? FINISHED_RECORD_TTL_MS;
    const interval = options.sweepIntervalMs ?? Math.min(this.ttlMs, 60_000);
    // 无读取者时也要释放内存：定时清理是唯一的兜底，不能只靠下次访问。
    this.sweepTimer = setInterval(() => this.sweep(), interval);
    this.sweepTimer.unref?.();
  }

  /** 首次归档成功返回条目；同一 matchId 已归档时返回 null，绝不覆盖或续期。 */
  archive(input: ArchiveFinishedRecordInput): FinishedRecordEntry | null {
    if (this.entries.has(input.matchId)) {
      return null;
    }
    const entry: FinishedRecordEntry = {
      roomId: input.roomId,
      matchId: input.matchId,
      memberIds: [...input.memberIds],
      endedAt: input.endedAt,
      expiresAt: input.endedAt + this.ttlMs,
      json: input.json,
      text: input.text,
    };
    this.entries.set(input.matchId, entry);
    return entry;
  }

  has(matchId: string): boolean {
    return this.entries.has(matchId);
  }

  /** 读取未过期条目；过期条目在返回前删除。 */
  get(matchId: string): FinishedRecordEntry | null {
    const entry = this.entries.get(matchId);
    if (!entry) {
      return null;
    }
    if (this.nowFn() >= entry.expiresAt) {
      this.entries.delete(matchId);
      return null;
    }
    return entry;
  }

  /** 本房未过期终局摘要，按结算时间升序。 */
  summaries(): FinishedRecordSummary[] {
    this.sweep();
    return [...this.entries.values()]
      .map(({ matchId, endedAt, expiresAt }) => ({ matchId, endedAt, expiresAt }))
      .sort((a, b) => a.endedAt - b.endedAt);
  }

  /** 清理全部已过期条目。 */
  sweep(): void {
    const now = this.nowFn();
    for (const [matchId, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(matchId);
      }
    }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    this.entries.clear();
  }
}

/**
 * 由已结算的权威对局生成格式 1 的 JSON 与文本。
 *
 * 只接受 settlement 非空的 MatchState；记录内只使用该局独立开局帧与最终有效主线，
 * 不拼接撤销栈、旧分支或 matchEvents。
 */
export function buildFinishedMatchRecord(match: MatchState): { json: string; text: string } {
  const settlement = match.settlement;
  if (!settlement) {
    throw new Error('对局尚未结算，不能生成终局棋谱');
  }
  const red = match.startParameters.players.find((player) => player.side === 'red');
  const black = match.startParameters.players.find((player) => player.side === 'black');
  if (!red || !black) {
    throw new Error('开局参数缺少双方成员，不能生成终局棋谱');
  }
  const record = createRecord(
    match.initial,
    snapshotState(match.gameState),
    { mode: 'online', seats: { red: red.name, black: black.name } },
    {
      winner: settlement.winner,
      reason: settlement.reason,
      durationSeconds: settlement.redDurationSeconds + settlement.blackDurationSeconds,
      timeBasis: 'player-clocks',
    },
  );
  const json = recordJSON(record);
  // 服务端交付前自检：格式不一致时宁可不交付，也不返回半份或伪造棋谱。
  parseRecord(json);
  return { json, text: recordText(record) };
}
