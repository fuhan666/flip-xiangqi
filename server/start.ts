/**
 * 宿主启动入口：
 *   开发   npm run dev          → tsx server/start.ts --dev（Vite middleware + 热更新）
 *   生产   npm start -- --port  → node dist-server/server/start.js（服务 dist/ 静态产物）
 *
 * 参数：--port <uiPort>（默认开发 5173 / 生产 4173，环境变量 UI_PORT 同义）
 *      --room-port <port>（默认 8080，环境变量 ROOM_PORT 同义）
 */
import { HostRuntime } from './host-runtime.js';
import { defaultLogger } from './log.js';

interface CliOptions {
  dev: boolean;
  uiPort: number;
  roomPort: number;
}

function parsePort(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`${label} 无效：${raw}，请使用 1-65535 之间的整数`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const dev = argv.includes('--dev');
  let uiPortArg: string | undefined;
  let roomPortArg: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--port') {
      uiPortArg = argv[index + 1];
      index += 1;
    } else if (token === '--room-port') {
      roomPortArg = argv[index + 1];
      index += 1;
    } else if (token?.startsWith('--port=')) {
      uiPortArg = token.slice('--port='.length);
    } else if (token?.startsWith('--room-port=')) {
      roomPortArg = token.slice('--room-port='.length);
    }
  }

  return {
    dev,
    uiPort: parsePort(uiPortArg ?? process.env.UI_PORT, dev ? 5173 : 4173, 'UI 端口'),
    roomPort: parsePort(roomPortArg ?? process.env.ROOM_PORT, 8080, '房间端口'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtime = new HostRuntime({
    uiPort: options.uiPort,
    roomPort: options.roomPort,
    dev: options.dev,
    staticDir: 'dist',
    logger: defaultLogger,
  });

  const uiPort = await runtime.start();

  console.log('翻牌中国象棋 · 局域网联机宿主已启动');
  console.log(`  本机控制台：http://127.0.0.1:${uiPort}`);
  console.log(`  建房默认端口：${options.roomPort}（被占用时自动顺延）`);
  console.log('  点击「创建房间」后，界面会展示可分享给对手的局域网地址。');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n收到 ${signal}，正在释放房间与端口…`);
    await runtime.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('宿主启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
