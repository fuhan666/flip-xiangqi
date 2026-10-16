/**
 * 连接层基础日志：仅记录时间、房间/成员、事件与错误码。
 */

type LogFields = Record<string, string | number | undefined>;

export type Logger = (event: string, fields?: LogFields) => void;

export const defaultLogger: Logger = (event, fields = {}) => {
  const parts = Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  const suffix = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  console.log(`[room] ${new Date().toISOString()} ${event}${suffix}`);
};
