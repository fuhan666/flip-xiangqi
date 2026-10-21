/**
 * 在线入口启动器：单一 HTTPS/WSS 地址，多房间匿名对战。
 *
 *   npm run start:online
 *   npm run dev:online          （先构建静态产物，再用 tsx 启动同一入口）
 *
 * 环境变量：
 *   ONLINE_PORT          监听端口，默认 8443
 *   ONLINE_HOST          监听地址，默认 0.0.0.0
 *   ONLINE_PUBLIC_ORIGIN 对外地址（https://host[:port]），默认 https://localhost:<port>
 *   ONLINE_TLS_KEY       TLS 私钥文件路径（必需）
 *   ONLINE_TLS_CERT      TLS 证书文件路径（必需）
 *   ONLINE_STATIC_DIR    静态产物目录，默认 dist
 */
import { readFile } from 'node:fs/promises';
import { OnlineRuntime, OnlineRuntimeError } from './online-runtime.js';
import { defaultLogger } from './log.js';

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 8443;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`ONLINE_PORT 无效：${raw}，请使用 1-65535 之间的整数`);
    process.exit(1);
  }
  return value;
}

async function readTlsFile(path: string | undefined, label: string): Promise<string> {
  if (!path) {
    throw new OnlineRuntimeError('TLS_CONFIG', `缺少 ${label}：请设置证书/私钥文件路径`);
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new OnlineRuntimeError('TLS_CONFIG', `无法读取 ${label}（${path}）：${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const port = readPort(process.env.ONLINE_PORT);
  const publicOrigin = process.env.ONLINE_PUBLIC_ORIGIN ?? `https://localhost:${port}`;
  const keyPath = process.env.ONLINE_TLS_KEY;
  const certPath = process.env.ONLINE_TLS_CERT;

  if (!keyPath || !certPath) {
    console.error('在线入口需要 TLS 证书：请设置 ONLINE_TLS_KEY 与 ONLINE_TLS_CERT。');
    console.error('本地自签证书生成方式见 docs/online-setup.md。');
    process.exit(1);
  }

  let runtime: OnlineRuntime;
  try {
    runtime = new OnlineRuntime({
      port,
      host: process.env.ONLINE_HOST ?? '0.0.0.0',
      publicOrigin,
      staticDir: process.env.ONLINE_STATIC_DIR ?? 'dist',
      tls: {
        key: await readTlsFile(keyPath, 'TLS 私钥'),
        cert: await readTlsFile(certPath, 'TLS 证书'),
      },
      logger: defaultLogger,
    });
  } catch (error) {
    if (error instanceof OnlineRuntimeError) {
      console.error(`在线入口启动失败（${error.code}）：${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const started = await runtime.start();
  console.log('翻牌中国象棋 · 在线匿名多房间入口已启动');
  console.log(`  地址：${started.publicOrigin}`);
  console.log(`  建房：${started.publicOrigin}/online`);
  console.log('  房间号与邀请链接只包含公开房间标识，权限来自浏览器匿名凭据。');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n收到 ${signal}，正在关闭房间并释放端口…`);
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('在线入口异常退出：', (error as Error).message);
  process.exit(1);
});
