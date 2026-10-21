import { useRef, useState } from 'react';
import type { Camp } from '../game';
import { copyText } from './rooms/clipboard';
import { downloadRecord } from '../records/download.js';
import { parseRecord, recordJSON, recordText } from '../records/record';
import type { GameRecord } from '../records/record';
import { ReplayViewer } from './ReplayViewer';

/**
 * `source` 用于联机终局：复制/下载必须使用服务器返回的原文，
 * 不在客户端按当前局面重新生成；本地记录不传 `source`，沿用本地制谱。
 */
export function GameRecordControls({ record, onReplay, source }: { record: GameRecord; onReplay: (record: GameRecord) => void; source?: { text: string; json: string } }) {
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState('');
  const content = (format: 'txt' | 'json') => source ? (format === 'txt' ? source.text : source.json) : (format === 'txt' ? recordText(record) : recordJSON(record));
  const copy = async (format: 'txt' | 'json') => {
    const ok = await copyText(content(format));
    setNotice(ok ? '棋谱已复制' : '复制失败，请下载棋谱文件');
  };
  return <section className="record-controls" aria-label="棋谱操作">
    <div className="record-actions"><button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>导出棋谱</button><button type="button" onClick={() => onReplay(record)}>开始复盘</button></div>
    {expanded ? <div className="record-actions">
      <button type="button" onClick={() => void copy('txt')}>复制文本</button>
      <button type="button" onClick={() => void copy('json')}>复制 JSON</button>
      <button type="button" onClick={() => downloadRecord(record, 'txt', content('txt'))}>下载 TXT</button>
      <button type="button" onClick={() => downloadRecord(record, 'json', content('json'))}>下载 JSON</button>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}

export function RecordImporter({ onReplay }: { onReplay: (record: GameRecord) => void }) {
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  return <section className="panel">
    <button type="button" onClick={() => input.current?.click()}>载入 JSON 棋谱</button>
    <input ref={input} hidden type="file" accept=".json,application/json" aria-label="选择 JSON 棋谱" onChange={async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        if (file.size > 10_000_000) throw new Error();
        const record = parseRecord(await file.text());
        setError(''); onReplay(record);
      } catch { setError('无法载入棋谱：文件损坏、版本不支持或对局序列不一致'); }
    }} />
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

export function RecordReplay({ record, perspective, onClose }: { record: GameRecord | null; perspective?: Camp; onClose: () => void }) {
  return record ? <ReplayViewer record={record} perspective={perspective} onClose={onClose} /> : null;
}
