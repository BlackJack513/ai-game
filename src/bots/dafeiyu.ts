/**
 * 大肥鱼 —— 单挑专用
 *
 * 打法只有三件事：
 *  1. 家门口的中立点按「产出/守军」比价抢，同一回合能合兵就合兵；
 *  2. 后方节点的余粮一路往前线推，别让产出卡在 100 上限；
 *  3. 谁家老宅露出来并且守军对不上号，就把够用的兵一次砸进去。
 */
import { NEUTRAL, type Bot, type NodeKind, type Observation, type ObsNode, type Order } from '../engine/types.js';

const INF = Number.POSITIVE_INFINITY;

interface Route {
  dist: number[];
  prev: number[];
}

interface NodeInfo {
  node: ObsNode;
  avail: number;
  route: Route;
}

interface Move {
  from: number;
  to: number;
  troops: number;
}

interface Plan {
  moves: Move[];
  score: number;
}

function bfs(view: Observation, source: number, blocked: Set<number>): Route {
  const n = view.nodes.length;
  const dist: number[] = new Array(n).fill(INF);
  const prev: number[] = new Array(n).fill(-1);
  dist[source] = 0;
  prev[source] = source;
  const queue: number[] = [source];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    for (const v of view.adj[u]) {
      if (dist[v] !== INF) continue;
      if (blocked.has(v)) continue;
      dist[v] = dist[u] + 1;
      prev[v] = u;
      queue.push(v);
    }
  }
  return { dist, prev };
}

function walkTo(route: Route, from: number, to: number): number[] | null {
  if (route.dist[to] === INF) return null;
  const path: number[] = [to];
  let cur = to;
  while (cur !== from) {
    cur = route.prev[cur];
    if (cur < 0) return null;
    path.push(cur);
  }
  path.reverse();
  return path;
}

/** 终点可以是敌方节点：先走到它旁边，再跨最后一步。 */
function marchTo(view: Observation, route: Route, from: number, target: number): number[] | null {
  const direct = walkTo(route, from, target);
  if (direct) return direct;
  if (target === from) return null;
  let bridge = -1;
  let best = INF;
  for (const u of view.adj[target]) {
    if (route.dist[u] < best) {
      best = route.dist[u];
      bridge = u;
    }
  }
  if (bridge < 0) return null;
  const path = walkTo(route, from, bridge);
  if (!path) return null;
  path.push(target);
  return path;
}

function travelTurns(path: number[]): number {
  return Math.max(0, path.length - 2);
}

/** 占下来以后每回合能产多少，用来给节点定价。 */
function worthOf(kind: NodeKind, counts: Record<NodeKind, number>): number {
  if (kind === 'foundry') return 48;
  if (kind === 'watchtower') return 34;
  if (kind === 'home') return 40;
  return 24 + Math.floor((counts[kind] + 1) / 2) * 12;
}

function blankCounts(): Record<NodeKind, number> {
  return { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 };
}

export function createDafeiyu(): Bot {
  return {
    name: '大肥鱼',
    style: '家门口抢产 · 余粮前置 · 见空即斩',
    decide(view: Observation): Order[] {
      const me = view.you;
      const nodes = view.nodes;
      const enemies = view.players.filter((p) => p.id !== me && p.alive).map((p) => p.id);
      if (enemies.length === 0) return [];
      const enemyPlayers = new Set(enemies);
      const enemyNodes = new Set<number>();
      for (const node of nodes) {
        if (enemyPlayers.has(node.owner)) enemyNodes.add(node.id);
      }

      const mine = nodes.filter((node) => node.owner === me);
      if (mine.length === 0) return [];

      const home = view.homeNode;
      const stock = new Map<number, number>();
      const counts = blankCounts();
      for (const node of mine) {
        stock.set(node.id, node.troops ?? 0);
        counts[node.kind]++;
      }

      const incoming = new Map<number, number>();
      for (const column of view.columns) {
        if (!enemyPlayers.has(column.owner)) continue;
        const target = column.path[column.path.length - 1];
        if (nodes[target].owner !== me) continue;
        incoming.set(target, (incoming.get(target) ?? 0) + column.troops);
      }

      const enemyHome = nodes.find((node) => node.kind === 'home' && enemyPlayers.has(node.owner));
      const enemyHomeId = enemyHome ? enemyHome.id : -1;

      /** 对手开局几乎不占点，多半是在憋一波斩首，这时老家要多留兵。 */
      let enemyNodeMax = 0;
      for (const player of view.players) {
        if (player.id !== me && player.alive) enemyNodeMax = Math.max(enemyNodeMax, player.nodes);
      }
      const rushSuspect = view.turn >= 2 && view.turn <= 8 && enemyNodeMax <= 2;
      const homeBase = rushSuspect ? 12 : view.turn <= 1 ? 2 : 4;

      const reserve = new Map<number, number>();
      for (const node of mine) {
        const base = node.id === home ? homeBase : 0;
        reserve.set(node.id, Math.max(base, (incoming.get(node.id) ?? 0) + 2));
      }

      /** 到最近敌方节点的距离，用来判断谁在后方、谁在前线。 */
      const front: number[] = new Array(nodes.length).fill(INF);
      const queue: number[] = [];
      for (const node of nodes) {
        if (enemyPlayers.has(node.owner)) {
          front[node.id] = 0;
          queue.push(node.id);
        }
      }
      for (let head = 0; head < queue.length; head++) {
        const u = queue[head];
        for (const v of view.adj[u]) {
          if (front[v] !== INF) continue;
          front[v] = front[u] + 1;
          queue.push(v);
        }
      }

      const infos: NodeInfo[] = [];
      for (const node of mine) {
        const avail = (stock.get(node.id) ?? 0) - (reserve.get(node.id) ?? 0);
        if (avail < 2) continue;
        infos.push({ node, avail, route: bfs(view, node.id, enemyNodes) });
      }

      const plans: Plan[] = [];

      /** 同一目标只挑一个能打赢的到达波次，波内按兵力从多到少分摊。 */
      const addStrike = (
        targetId: number,
        garrison: number,
        growth: number,
        kind: NodeKind,
        base: number,
        maxEta: number,
      ): void => {
        const waves = new Map<number, NodeInfo[]>();
        for (const info of infos) {
          const path = marchTo(view, info.route, info.node.id, targetId);
          if (!path) continue;
          const eta = travelTurns(path);
          const wave = waves.get(eta) ?? [];
          wave.push(info);
          waves.set(eta, wave);
        }

        let best: { eta: number; wave: NodeInfo[] } | null = null;
        for (const [eta, wave] of waves) {
          if (eta > maxEta) continue;
          const total = wave.reduce((sum, info) => sum + info.avail, 0);
          if (total < garrison + growth * eta + 1) continue;
          if (!best || eta < best.eta) best = { eta, wave };
        }
        if (!best) return;

        const need = garrison + growth * best.eta + 1;
        const wave = [...best.wave].sort((a, b) => b.avail - a.avail);
        const moves: Move[] = [];
        let left = need;
        for (const info of wave) {
          if (left <= 0) break;
          const take = Math.min(info.avail, left);
          left -= take;
          moves.push({ from: info.node.id, to: targetId, troops: take });
        }
        if (left > 0) return;

        const doorGuard = view.adj[home].includes(targetId) ? 1300 : 0;
        const doorRaid = enemyHomeId >= 0 && view.adj[enemyHomeId].includes(targetId) ? 800 : 0;
        plans.push({
          moves,
          score: base + doorGuard + doorRaid + worthOf(kind, counts) * 100 - garrison * 30 - best.eta * 200,
        });
      };

      for (const tn of nodes) {
        if (tn.owner === NEUTRAL) {
          addStrike(tn.id, tn.troops ?? 0, 0, tn.kind, 1500, 2);
        } else if (enemyPlayers.has(tn.owner) && tn.troops !== null) {
          addStrike(tn.id, tn.troops, tn.production, tn.kind, 1100, 0);
        }
      }

      if (enemyHome && enemyHome.troops !== null) {
        addStrike(enemyHome.id, enemyHome.troops, 4, enemyHome.kind, 9_000_000, 3);
      }

      const reinforce = (target: number, score: number): void => {
        for (const id of view.adj[target]) {
          if (nodes[id].owner !== me) continue;
          const have = (stock.get(id) ?? 0) - (reserve.get(id) ?? 0);
          if (have <= 1) continue;
          plans.push({ moves: [{ from: id, to: target, troops: have }], score });
        }
      };

      let homeThreat = incoming.get(home) ?? 0;
      for (const id of view.adj[home]) {
        const neighbor = nodes[id];
        if (enemyPlayers.has(neighbor.owner)) homeThreat += neighbor.troops ?? 0;
      }
      if (homeThreat + 2 >= (stock.get(home) ?? 0)) reinforce(home, 8_000_000);

      for (const [target, amount] of incoming) {
        if (target === home) continue;
        if (amount + 2 < (stock.get(target) ?? 0)) continue;
        reinforce(target, 7_000_000);
      }

      const byFront = [...mine].sort((a, b) => front[a.id] - front[b.id]);
      for (const info of infos) {
        const { node, avail } = info;
        for (const target of byFront) {
          if (target.id === node.id) continue;
          if (front[target.id] >= front[node.id]) continue;
          if (!view.adj[node.id].includes(target.id)) continue;
          const room = 96 - (stock.get(target.id) ?? 0);
          if (room < 2) continue;
          const send = Math.min(avail, room);
          if (send < 2) continue;
          plans.push({ moves: [{ from: node.id, to: target.id, troops: send }], score: 300 + send });
        }
      }

      plans.sort((a, b) => b.score - a.score);

      const orders: Order[] = [];
      const used = new Map<number, number>();
      const seen = new Set<string>();

      for (const plan of plans) {
        if (orders.length + plan.moves.length > view.maxOrders) continue;

        const trial = new Map<number, number>();
        let ok = true;
        for (const move of plan.moves) {
          const key = `${move.from}>${move.to}`;
          if (seen.has(key)) {
            ok = false;
            break;
          }
          const cap =
            (stock.get(move.from) ?? 0) -
            (reserve.get(move.from) ?? 0) -
            (used.get(move.from) ?? 0) -
            (trial.get(move.from) ?? 0);
          if (move.troops > cap) {
            ok = false;
            break;
          }
          trial.set(move.from, (trial.get(move.from) ?? 0) + move.troops);
        }
        if (!ok) continue;

        for (const move of plan.moves) {
          orders.push({ from: move.from, to: move.to, troops: move.troops });
          used.set(move.from, (used.get(move.from) ?? 0) + move.troops);
          seen.add(`${move.from}>${move.to}`);
        }
      }

      return orders;
    },
  };
}