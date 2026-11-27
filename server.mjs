/**
 * 星流 Starflow —— 联机单挑房间服务。
 *
 * 单端口 HTTP 服务：同时托管静态页面与联机 API。
 * 服务端是唯一裁判：两名玩家各自提交指令，服务端用 Match.step(overrides)
 * 同时结算并广播帧快照，因此双方永远看到同一局、同一结果。
 *
 * 协议（同源，无第三方依赖）：
 *   GET  /api/room/events?key=XXX&token=...&name=...  → SSE，推送 hello / state / notice
 *   POST /api/room/order   { key, token, orders }   → 提交本回合指令
 *   POST /api/room/restart { key, token }           → 终局后重开一局
 *
 * 启动：PORT=5173 node server.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Match } from './js/engine/runner.js';
import { hashSeed } from './js/engine/rng.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const SEATS = 2;
const TURN_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;

/** key → room */
const rooms = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function normalizeKey(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

function sanitizeName(raw) {
  const name = String(raw ?? '').trim().replace(/[\r\n<>]/g, '').slice(0, 16);
  return name || '玩家';
}

function token() {
  return randomBytes(12).toString('hex');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeNotice(res, message, level = 'info') {
  writeEvent(res, { type: 'notice', message, level });
}

function eachSeat(room, fn) {
  room.seats.forEach((seat, index) => {
    if (seat) fn(seat, index);
  });
}

function broadcast(room, payload) {
  eachSeat(room, (seat) => {
    if (!seat.connected || !seat.res) return;
    try {
      writeEvent(seat.res, payload);
    } catch {
      detachSeat(room, seat, '连接已断开');
    }
  });
}

function broadcastNotice(room, message, level = 'info') {
  broadcast(room, { type: 'notice', message, level });
}

function createRoom(key) {
  return {
    key,
    seed: hashSeed(`starflow:${key}`),
    seats: new Array(SEATS).fill(null),
    match: null,
    finished: false,
    turnTimer: null,
    emptyTimer: null,
    lastActivity: Date.now(),
  };
}

function connectedCount(room) {
  return room.seats.filter((seat) => seat?.connected).length;
}

function clearTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
}

function armTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.match || room.finished) return;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    const missing = [];
    eachSeat(room, (seat, index) => {
      if (seat.orders === null) {
        seat.orders = [];
        missing.push(seat.name || `玩家 ${index + 1}`);
      }
    });
    if (missing.length === 0) return;
    broadcastNotice(room, `${missing.join('、')} 超时未下令，本回合按空指令结算`, 'warn');
    resolveTurn(room);
  }, TURN_TIMEOUT_MS);
  room.turnTimer.unref?.();
}

function startMatch(room, seed = hashSeed(`starflow:${room.key}`)) {
  room.seed = seed;
  room.finished = false;
  const names = room.seats.map((seat, index) => seat?.name || `玩家 ${index + 1}`);
  room.match = new Match({
    mode: 'duel',
    seed: room.seed,
    botIds: ['human', 'human'],
    bots: names.map((name) => ({ name, decide: () => [] })),
    names,
  });
  eachSeat(room, (seat) => {
    seat.orders = null;
  });
  broadcastNotice(room, '双方已就位，对局开始', 'ok');
  broadcastState(room);
  armTurnTimer(room);
}

function broadcastState(room) {
  const waitingFor = room.seats
    .map((seat, index) => (seat?.connected && seat.orders === null ? index : -1))
    .filter((index) => index >= 0);
  const payload = {
    type: 'state',
    key: room.key,
    seed: room.seed,
    phase: room.finished ? 'finished' : room.match ? 'playing' : 'waiting',
    waitingFor,
    finished: room.finished,
    result: room.match ? room.match.result() : null,
  };
  broadcast(room, payload);
  return payload;
}

function resolveTurn(room) {
  if (!room.match || room.finished) return;
  clearTurnTimer(room);
  const overrides = new Map();
  eachSeat(room, (seat, index) => {
    overrides.set(index, Array.isArray(seat.orders) ? seat.orders : []);
    seat.orders = null;
  });
  room.match.step(overrides);
  if (room.match.finished) {
    room.finished = true;
    clearTurnTimer(room);
  }
  broadcastState(room);
  if (!room.finished) armTurnTimer(room);
}

function maybeResolve(room) {
  if (!room.match || room.finished) return;
  // 只等在线玩家的指令；断线者的空指令已在 detachSeat 中补齐
  const ready = room.seats.every((seat) => !seat || !seat.connected || seat.orders !== null);
  if (ready) resolveTurn(room);
}

function detachSeat(room, seat, message) {
  if (!seat.connected && !seat.res) return;
  seat.connected = false;
  seat.res = null;
  if (message) broadcastNotice(room, message, 'warn');
  if (connectedCount(room) === 0) {
    if (!room.emptyTimer) {
      room.emptyTimer = setTimeout(() => {
        rooms.delete(room.key);
      }, EMPTY_ROOM_TTL_MS);
      room.emptyTimer.unref?.();
    }
  } else {
    // 对手断线：本回合按空指令推进，避免留下的人一直等
    if (seat.orders === null) seat.orders = [];
    maybeResolve(room);
    broadcastState(room);
  }
}

function findSeat(room, suppliedToken) {
  if (!suppliedToken) return -1;
  return room.seats.findIndex((seat) => seat && seat.token === suppliedToken);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function normalizeOrders(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((order) => order && Number.isFinite(order.from) && Number.isFinite(order.to) && Number.isFinite(order.troops))
    .slice(0, 5)
    .map((order) => ({
      from: Math.max(0, Math.trunc(order.from)),
      to: Math.max(0, Math.trunc(order.to)),
      troops: Math.max(1, Math.min(100, Math.trunc(order.troops))),
    }));
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    json(res, 400, { error: '无效路径' });
    return;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(ROOT, relative);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    json(res, 403, { error: '禁止访问' });
    return;
  }
  fs.stat(target, (error, stats) => {
    if (error || !stats.isFile()) {
      json(res, 404, { error: '文件不存在' });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    // 供前端判断当前站点是否带联机服务
    if (pathname === '/api/health' && req.method === 'GET') {
      json(res, 200, { ok: true });
      return;
    }

    // SSE：建房 / 加入房间
    if (pathname === '/api/room/events' && req.method === 'GET') {
      const key = normalizeKey(url.searchParams.get('key'));
      if (key.length < 3 || key.length > 16) {
        json(res, 400, { error: '房间密钥需为 3–16 位字母或数字' });
        return;
      }

      let room = rooms.get(key);
      let index = room ? findSeat(room, url.searchParams.get('token')) : -1;
      if (room && index < 0) index = room.seats.findIndex((seat) => seat === null);
      if (room && index < 0) {
        json(res, 409, { error: '房间已满，请换一个密钥' });
        return;
      }
      if (!room) {
        room = createRoom(key);
        rooms.set(key, room);
        index = 0;
      }
      if (room.emptyTimer) {
        clearTimeout(room.emptyTimer);
        room.emptyTimer = null;
      }
      room.lastActivity = Date.now();

      const previous = room.seats[index];
      if (previous?.res) {
        try {
          previous.res.end();
        } catch {
          /* 忽略 */
        }
      }
      const supplied = url.searchParams.get('token');
      const seatToken = previous?.token && supplied === previous.token ? previous.token : token();
      const seat = {
        token: seatToken,
        name: sanitizeName(url.searchParams.get('name')),
        res,
        connected: true,
        orders: previous?.orders ?? null,
      };
      room.seats[index] = seat;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      writeEvent(res, {
        type: 'hello',
        key,
        seed: room.seed,
        seat: index,
        token: seatToken,
        name: seat.name,
      });

      if (connectedCount(room) === SEATS && !room.match) {
        startMatch(room);
      } else {
        if (seat.name && index === 0 && connectedCount(room) === 1 && !room.match) {
          writeNotice(res, '房间已创建，把密钥发给朋友即可加入', 'ok');
        }
        broadcastState(room);
      }

      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          detachSeat(room, seat, null);
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
        detachSeat(room, seat, `${seat.name} 已离开房间`);
      });
      return;
    }

    // 提交本回合指令
    if (pathname === '/api/room/order' && req.method === 'POST') {
      const body = await readBody(req);
      const key = normalizeKey(body.key);
      const room = rooms.get(key);
      const index = room ? findSeat(room, String(body.token ?? '')) : -1;
      if (!room || index < 0) {
        json(res, 404, { error: '房间或座位不存在，请重新加入' });
        return;
      }
      const seat = room.seats[index];
      if (room.finished || !room.match) {
        json(res, 409, { error: '当前不可提交指令' });
        return;
      }
      if (seat.orders !== null) {
        json(res, 409, { error: '本回合已提交，请等待结算' });
        return;
      }
      seat.orders = normalizeOrders(body.orders);
      const state = broadcastState(room);
      json(res, 200, { ok: true, waitingFor: state.waitingFor });
      maybeResolve(room);
      return;
    }

    // 终局后重开
    if (pathname === '/api/room/restart' && req.method === 'POST') {
      const body = await readBody(req);
      const key = normalizeKey(body.key);
      const room = rooms.get(key);
      const index = room ? findSeat(room, String(body.token ?? '')) : -1;
      if (!room || index < 0) {
        json(res, 404, { error: '房间或座位不存在，请重新加入' });
        return;
      }
      if (!room.finished) {
        json(res, 409, { error: '对局尚未结束' });
        return;
      }
      const seed = hashSeed(`starflow:${room.key}:${Date.now()}`);
      startMatch(room, seed);
      json(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(res, 404, { error: '未知接口' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }
    json(res, 405, { error: '不支持的方法' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务器错误';
    if (!res.headersSent) json(res, 400, { error: message });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`星流联机服务已启动：http://localhost:${PORT}/`);
});
