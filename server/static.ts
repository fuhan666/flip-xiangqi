/**
 * 生产形态静态文件服务：为控制台页面与客人页面提供 dist/ 产物，
 * 未知路径回退到 index.html（SPA 路由）。
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticHandler(rootDir: string) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Method Not Allowed');
      return;
    }

    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://static.local').pathname);
    const candidate = path.join(rootDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));

    let filePath = candidate;
    if (!candidate.startsWith(path.resolve(rootDir))) {
      filePath = path.join(rootDir, 'index.html');
    }

    try {
      const info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        await stat(filePath);
      }
    } catch {
      filePath = path.join(rootDir, 'index.html');
      try {
        await stat(filePath);
      } catch {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('构建产物缺失，请先运行 npm run build');
        return;
      }
    }

    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  };
}
