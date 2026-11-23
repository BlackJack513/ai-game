// 开发模式：先编译一次，再监听 src/ 变化自动重编译，同时启动静态服务器。
//   node scripts/dev.mjs
import fs from 'node:fs';
import path from 'node:path';
import { build } from './build.mjs';
import { startServer, ROOT } from './serve.mjs';

build();

let timer = null;
let pending = false;

fs.watch(path.join(ROOT, 'src'), { recursive: true }, (_event, filename) => {
  if (!filename || !/\.(ts|css|html)$/.test(String(filename))) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (pending) return;
    pending = true;
    const started = Date.now();
    const ok = build({ quiet: true });
    pending = false;
    if (ok) console.log(`✓ 已重编译 ${path.basename(String(filename))} (${Date.now() - started}ms)`);
  }, 120);
});

startServer();
