/**
 * 本机局域网 IPv4 地址探测：枚举非 internal IPv4、去重并保留接口名，
 * 私有局域网地址优先；无可用局域网地址时由调用方标注 loopback 仅供本机测试。
 */
import { networkInterfaces } from 'node:os';

export interface LanAddress {
  address: string;
  interfaceName: string;
  /** RFC1918 私有地址（常见家用/办公局域网）。 */
  private: boolean;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 192 && b === 168;
}

export function listLanAddresses(): LanAddress[] {
  const results: LanAddress[] = [];
  const seen = new Set<string>();

  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }
      if (seen.has(entry.address)) {
        continue;
      }
      seen.add(entry.address);
      results.push({
        address: entry.address,
        interfaceName,
        private: isPrivateIpv4(entry.address),
      });
    }
  }

  return results.sort((left, right) => {
    if (left.private !== right.private) {
      return left.private ? -1 : 1;
    }
    return left.interfaceName.localeCompare(right.interfaceName);
  });
}
