/**
 * 测试用自签证书：只用于本机 HTTPS/WSS 验证。
 * 证书生成到系统临时目录，不写入仓库；客户端仍显式信任这张测试证书（不关闭 TLS 校验）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let cached: { key: string; cert: string } | null = null;

export function testTls(): { key: string; cert: string } {
  if (cached) {
    return cached;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'flip-online-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  cached = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  return cached;
}
