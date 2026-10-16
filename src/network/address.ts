/**
 * 连接地址的解析与归一化：接受 `IP:端口`、带 `http://` / `ws://` 前缀、
 * 首尾空白等多种输入，统一为 `{ host, port }`。
 */

export interface ParsedAddress {
  host: string;
  port: number;
}

export type AddressParseResult = { ok: true; value: ParsedAddress } | { ok: false; message: string };

const SCHEME_PREFIX = /^(https?|wss?):\/\//i;

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isHostname(host: string): boolean {
  return host === 'localhost' || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host);
}

/** 纯数字点分串按 IPv4 校验（如 192.168.1.999 不允许当主机名通过）。 */
function looksLikeIpv4(host: string): boolean {
  return /^\d+(\.\d+)+$/.test(host);
}

export function parseServerAddress(input: string): AddressParseResult {
  const trimmed = input.trim().replace(SCHEME_PREFIX, '');
  const authority = trimmed.split('/')[0] ?? '';

  if (authority.length === 0) {
    return { ok: false, message: '请输入连接地址，例如 192.168.1.5:8080' };
  }

  const separatorIndex = authority.lastIndexOf(':');
  if (separatorIndex <= 0) {
    return { ok: false, message: '地址缺少端口 —— 需要「IP:端口」格式，例如 192.168.1.5:8080' };
  }

  const host = authority.slice(0, separatorIndex).replace(/^\[|\]$/g, '');
  const portText = authority.slice(separatorIndex + 1);

  if (!isIpv4(host) && !(isHostname(host) && !looksLikeIpv4(host))) {
    return { ok: false, message: `无法识别的主机名「${host}」—— 请使用 IPv4 地址，例如 192.168.1.5:8080` };
  }

  if (!/^\d{1,5}$/.test(portText)) {
    return { ok: false, message: `端口「${portText}」无效 —— 端口应为 1-65535 的数字` };
  }

  const port = Number(portText);
  if (port < 1 || port > 65535) {
    return { ok: false, message: `端口「${portText}」超出范围 —— 端口应为 1-65535 的数字` };
  }

  return { ok: true, value: { host, port } };
}

export function formatAddress(address: ParsedAddress): string {
  return `${address.host}:${address.port}`;
}

export function toWebSocketUrl(address: ParsedAddress, path = '/ws'): string {
  return `ws://${formatAddress(address)}${path}`;
}

export function toHttpUrl(address: ParsedAddress): string {
  return `http://${formatAddress(address)}/`;
}
