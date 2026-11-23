// 零依赖静态服务器：直接服务仓库根目录（index.html + js/ + style.css）。
//   node scripts/serve.mjs [端口]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

export function startServer(port = Number(process.env.PORT ?? process.argv[2] ?? 5173)) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403');
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 ' + rel);
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`星流 Starflow 沙盘: http://127.0.0.1:${port}/`);
  });
  return server;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) startServer();
