import { useEffect, useRef, useState } from 'react';
import type { Camp } from '../game/index.js';
import type { OnlineRecord, RecordUnavailable, RoomConnection } from '../network/client.js';
import type { FinishedRecordSummary } from '../network/protocol.js';
import { parseRecord, type GameRecord } from '../records/record.js';
import { GameRecordControls, RecordReplay } from './GameRecordControls.js';

export interface OnlineRecordPanelProps {
  client: RoomConnection;
  matchId: string;
  recordResult: OnlineRecord | null;
  recordError: RecordUnavailable | null;
  perspective: Camp;
}

function formatExpiry(expiresAt: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
  return minutes > 0 ? `约 ${minutes} 分钟后过期` : '即将过期';
}

/**
 * 联机终局棋谱面板：只展示服务端交付的服务器原文，不在客户端重新制谱。
 * 记录状态与公开棋局完全独立，旧局棋谱不会替换当前局面。
 */
export function OnlineRecordPanel({ client, matchId, recordResult, recordError, perspective }: OnlineRecordPanelProps) {
  const requested = useRef<string | null>(null);
  const [replaying, setReplaying] = useState<GameRecord | null>(null);

  useEffect(() => {
    setReplaying(null);
  }, [matchId]);

  useEffect(() => {
    if (requested.current === matchId || recordResult || recordError) {
      return;
    }
    requested.current = matchId;
    client.requestGameRecord?.(matchId);
  }, [client, matchId, recordResult, recordError]);

  const current = recordResult?.matchId === matchId ? recordResult : null;
  const failure = recordError?.matchId === matchId ? recordError : null;

  if (current) {
    let record: GameRecord | null = null;
    try {
      record = parseRecord(current.json);
    } catch {
      record = null;
    }
    if (!record) {
      return (
        <p className="room-hint" data-testid="online-record-invalid" role="alert">
          棋谱校验失败，请重试或联系房主。
        </p>
      );
    }
    return (
      <div data-testid="online-record-ready">
        <p className="room-hint">本局棋谱由服务器生成，{formatExpiry(current.expiresAt)}。</p>
        <GameRecordControls
          onReplay={setReplaying}
          record={record}
          source={{ text: current.text, json: current.json }}
        />
        {replaying ? <RecordReplay onClose={() => setReplaying(null)} perspective={perspective} record={replaying} /> : null}
      </div>
    );
  }

  if (failure) {
    return (
      <div data-testid="online-record-error">
        <p className="room-hint" role="alert">
          {failure.code === 'NOT_FINISHED' ? '对局尚未结束，暂不能获取棋谱。' : failure.code === 'FORBIDDEN' ? '无权读取该房间的棋谱。' : '棋谱不存在或已过期，无法再导出。'}
        </p>
        <button
          className="panel-action-secondary"
          data-testid="online-record-retry"
          onClick={() => client.requestGameRecord(matchId)}
          type="button"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <p className="room-hint" data-testid="online-record-loading">
      正在取回服务器棋谱…
    </p>
  );
}

export interface OnlineRecordLibraryProps {
  client: RoomConnection;
  records: FinishedRecordSummary[];
  recordResult: OnlineRecord | null;
  recordError: RecordUnavailable | null;
  perspective: Camp;
}

/** 本房临时终局棋谱列表：返回大厅或再局后仍可取回保留期内的旧局。 */
export function OnlineRecordLibrary({ client, records, recordResult, recordError, perspective }: OnlineRecordLibraryProps) {
  const [selected, setSelected] = useState<string | null>(null);
  if (records.length === 0) {
    return null;
  }
  return (
    <section className="room-panel online-record-panel" data-testid="online-record-list">
      <h2>本房终局棋谱</h2>
      <p className="room-hint">服务器保留 30 分钟；过期或服务器重启后不可再取回。</p>
      <ul className="record-actions">
        {records.map((item) => (
          <li key={item.matchId}>
            <button
              className="panel-action-secondary"
              data-testid={`online-record-entry-${item.matchId}`}
              onClick={() => setSelected(item.matchId)}
              type="button"
            >
              {new Date(item.endedAt).toLocaleTimeString()} 结束的对局
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <OnlineRecordPanel
          client={client}
          matchId={selected}
          perspective={perspective}
          recordError={recordError}
          recordResult={recordResult}
        />
      ) : null}
    </section>
  );
}
