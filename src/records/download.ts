import { recordJSON, recordText, type GameRecord } from './record.js';

/** 浏览器专用下载：服务端与共享逻辑不得依赖 Blob / document / window。 */
export function downloadRecord(record: GameRecord, format: 'txt' | 'json', content?: string): void {
  const text = content ?? (format === 'txt' ? recordText(record) : recordJSON(record));
  const blob = new Blob([text], { type: format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `flip-xiangqi-${record.result.totalSteps}-steps.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let the browser acquire the download before releasing the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
