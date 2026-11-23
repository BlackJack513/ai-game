/**
 * 「zhanluDeepseek」—— 精确结算驱动的全局调度型 AI
 *
 * 每回合把 5 条指令当作稀缺资源，按优先级调度：
 *   1. 守家：模拟所有在途纵队按到达顺序结算（含产出增长），对会丢的节点
 *      计算缺口，从能在破防前赶到的己方节点增援；受威胁节点本回合不分兵
 *   2. 扩张：中立点按「产出 × 剩余回合 + 节点数价值 − 兵力 − 距离」排序，
 *      用刚好打赢的兵力抢占；贴敌点追加驻防，竞争激烈的点提高门槛
 *   3. 进攻：敌方弱点与老家，多源同回合到达合并结算；大优势时斩首
 *   4. 流动：后方富余向前线集结，接近 100 上限强制外送
 *
 * 核心是一个与引擎 resolveCombat 完全一致的推演器：知道「我抵达那一刻」
 * 目标的真实守军（中立守军不增长、敌方守军按产出增长），所以出兵量可以
 * 精确到个位数，不浪费兵力也不打不赢的仗。零记忆纯函数。
 */

import { NEUTRAL, type Bot, type Observation, type ObsNode, type Order } from '../engine/types.js';

const CAP = 100;

interface Arrival {
  at: number;
  owner: number;
  troops: number;
}

interface SimState {
  owner: number;
  troops: number;
}

interface Threat {
  breakAt: number;
  deficit: number;
}

interface Candidate {
  target: number;
  delay: number;
  need: number;
  minNeed: number;
  value: number;
  score: number;
}

/** 视野外目标的保守兵力估计。 */
function estOf(node: ObsNode): number {
  if (node.troops !== null) return node.troops;
  if (node.kind === 'home') return 14;
  if (node.kind === 'foundry') return 10;
  if (node.kind === 'watchtower') return 8;
  return 6;
}

/** 与引擎 resolveCombat 完全一致的结算：最多者胜，平局守方留点并清零。 */
function resolve(defender: number, garrison: number, group: Arrival[]): SimState {
  const sides = new Map<number, number>();
  sides.set(defender, garrison);
  for (const item of group) sides.set(item.owner, (sides.get(item.owner) ?? 0) + item.troops);
  const entries = [...sides.entries()].sort((a, b) => b[1] - a[1]);
  const max = entries[0][1];
  if (entries.filter((entry) => entry[1] === max).length > 1) {
    return { owner: defender, troops: 0 };
  }
  const second = entries.length > 1 ? entries[1][1] : 0;
  return { owner: entries[0][0], troops: Math.min(CAP, entries[0][1] - second) };
}

/** 带阻挡的最短路（边距）：敌方节点可作终点但不可穿过，与引擎寻路一致。 */
function edgeDistances(view: Observation, from: number): number[] {
  const n = view.nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  dist[from] = 0;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of view.adj[u]) {
      if (dist[v] !== Infinity) continue;
      dist[v] = dist[u] + 1;
      const owner = view.nodes[v].owner;
      if (owner !== NEUTRAL && owner !== view.you) continue;
      queue.push(v);
    }
  }
  return dist;
}

/** 忽略阻挡的多源 BFS，用于估算对手能多快赶到某个点。 */
function freeDistances(view: Observation, sources: number[]): number[] {
  const n = view.nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const queue: number[] = [];
  for (const source of sources) {
    if (dist[source] !== Infinity) continue;
    dist[source] = 0;
    queue.push(source);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of view.adj[u]) {
      if (dist[v] !== Infinity) continue;
      dist[v] = dist[u] + 1;
      queue.push(v);
    }
  }
  return dist;
}

function plan(view: Observation): Order[] {
  const n = view.nodes.length;
  const me = view.you;
  const now = view.turn;
  const home = view.homeNode;
  const remaining = Math.max(1, view.maxTurns - now);

  const mine: ObsNode[] = [];
  const mineSet = new Array<boolean>(n).fill(false);
  for (const node of view.nodes) {
    if (node.owner === me) {
      mine.push(node);
      mineSet[node.id] = true;
    }
  }
  if (mine.length === 0) return [];

  // ---- 距离表：从每个己方节点出发，敌方节点可作终点不可穿过 ----
  const tables = new Map<number, number[]>();
  for (const node of mine) tables.set(node.id, edgeDistances(view, node.id));
  const hopsOf = (from: number, to: number): number => {
    const table = tables.get(from);
    if (!table) return Infinity;
    const d = table[to];
    return Number.isFinite(d) && d >= 1 ? d - 1 : Infinity;
  };

  // ---- 产出 ----
  const counts: Record<string, number> = {
    home: 0,
    farm: 0,
    mine: 0,
    lab: 0,
    watchtower: 0,
    foundry: 0,
  };
  for (const node of mine) counts[node.kind] += 1;

  const myProd = (id: number): number => {
    const kind = view.nodes[id].kind;
    if (kind === 'home') return 4;
    if (kind === 'foundry') return 5;
    if (kind === 'watchtower') return 2;
    return 2 + Math.floor(counts[kind] / 2);
  };

  const prodAt = (id: number, owner: number): number => {
    if (owner === NEUTRAL) return 0;
    if (owner === me) return myProd(id);
    const node = view.nodes[id];
    if (node.owner === owner) return node.production;
    return 3;
  };

  const grow = (troops: number, owner: number, target: number, turns: number): number => {
    if (owner === NEUTRAL || turns <= 0) return troops;
    const prod = prodAt(target, owner);
    if (prod <= 0) return troops;
    let value = troops;
    for (let k = 0; k < turns && value < CAP; k++) value = Math.min(CAP, value + prod);
    return value;
  };

  // ---- 推演：目标在 horizon 回合后的归属与兵力 ----
  const simulate = (target: number, horizon: number, extra: Arrival[] = []): SimState => {
    const node = view.nodes[target];
    let owner = node.owner;
    let troops = estOf(node);
    const arrivals: Arrival[] = [];
    for (const column of view.columns) {
      if (column.path[column.path.length - 1] !== target) continue;
      const at = column.arriveTurn - now;
      if (at < 0 || at > horizon) continue;
      arrivals.push({ at, owner: column.owner, troops: column.troops });
    }
    for (const item of extra) {
      if (item.at >= 0 && item.at <= horizon) arrivals.push(item);
    }
    arrivals.sort((a, b) => a.at - b.at);

    let last = 0;
    let index = 0;
    while (index < arrivals.length) {
      const at = arrivals[index].at;
      troops = grow(troops, owner, target, at - last);
      last = at;
      const group: Arrival[] = [];
      while (index < arrivals.length && arrivals[index].at === at) {
        group.push(arrivals[index]);
        index++;
      }
      const result = resolve(owner, troops, group);
      owner = result.owner;
      troops = result.troops;
    }
    troops = grow(troops, owner, target, horizon - last);
    return { owner, troops };
  };

  // ---- 威胁：本方节点会不会在某一波到达后易主 ----
  const threatOf = (target: number): Threat | null => {
    const arrivals: Arrival[] = [];
    for (const column of view.columns) {
      if (column.path[column.path.length - 1] !== target) continue;
      const at = column.arriveTurn - now;
      if (at < 0) continue;
      arrivals.push({ at, owner: column.owner, troops: column.troops });
    }
    if (arrivals.length === 0) return null;
    arrivals.sort((a, b) => a.at - b.at);

    let owner = me;
    let troops = view.nodes[target].troops ?? 0;
    let last = 0;
    let index = 0;
    while (index < arrivals.length) {
      const at = arrivals[index].at;
      troops = grow(troops, owner, target, at - last);
      last = at;
      const group: Arrival[] = [];
      while (index < arrivals.length && arrivals[index].at === at) {
        group.push(arrivals[index]);
        index++;
      }
      const sides = new Map<number, number>();
      for (const item of group) sides.set(item.owner, (sides.get(item.owner) ?? 0) + item.troops);
      let enemyTop = 0;
      for (const [sideOwner, sideTroops] of sides) {
        if (sideOwner !== me) enemyTop = Math.max(enemyTop, sideTroops);
      }
      const mineNow = troops + (sides.get(me) ?? 0);
      if (mineNow < enemyTop) return { breakAt: at, deficit: enemyTop - mineNow + 1 };
      const result = resolve(owner, troops, group);
      owner = result.owner;
      troops = result.troops;
      if (owner !== me) return { breakAt: at, deficit: 1 };
    }
    return null;
  };

  // ---- 对手距离（含 FFA 多敌人）：用于判断老家短期是否可能被摸到 ----
  const enemyNodes = view.nodes.filter((node) => node.owner >= 0 && node.owner !== me);
  const enemyDist = freeDistances(
    view,
    enemyNodes.map((node) => node.id),
  );
  const enemyHomes = enemyNodes.filter((node) => node.kind === 'home');
  const enemyHomeDist = freeDistances(
    view,
    enemyHomes.map((node) => node.id),
  );
  const myHomeDist = freeDistances(view, [home]);

  // ---- 守军基线：老家最金贵，前线次之，后方留 1 ----
  const adjacentEnemy = (id: number): number => {
    let best = 0;
    for (const v of view.adj[id]) {
      const node = view.nodes[v];
      if (node.owner >= 0 && node.owner !== me) best = Math.max(best, estOf(node));
    }
    return best;
  };

  const baseKeep = (id: number): number => {
    const adj = adjacentEnemy(id);
    if (id === home) {
      // 老家间距 ≥ 4 边：敌方最近只能 3 回合后抵达，前期可以放心把兵派出去
      // 抢经济。距离一旦拉近立刻抬高守卫，危险交给在途纵队检测兜底。
      const reach = enemyDist[home];
      if (reach >= 5) return Math.min(28, 4 + Math.ceil(adj * 0.7));
      if (reach >= 4) return Math.min(28, 6 + Math.ceil(adj * 0.7));
      return Math.min(28, 8 + Math.ceil(adj * 0.7));
    }
    if (adj > 0) return Math.min(12, Math.ceil(adj * 0.6) + 3);
    return 1;
  };

  const threats = new Map<number, Threat>();
  for (const node of mine) {
    const threat = threatOf(node.id);
    if (threat) threats.set(node.id, threat);
  }

  // 任何有敌纵队指向的节点本回合都不分兵 —— 否则「刚好守住」会变成「刚好被
  // 抽空」。缺口交给增援阶段从别处补。
  const incomingTargets = new Array<boolean>(n).fill(false);
  for (const column of view.columns) {
    if (column.owner === me) continue;
    const target = column.path[column.path.length - 1];
    if (mineSet[target]) incomingTargets[target] = true;
  }

  const safeKeep = (id: number): number => {
    const base = baseKeep(id);
    if (threats.has(id) || incomingTargets[id]) return Math.max(base, view.nodes[id].troops ?? 0);
    return base;
  };

  // ---- 指令缓冲 ----
  const orders: Order[] = [];
  const used = new Array<number>(n).fill(0);

  const capacityOf = (id: number, keep: number): number =>
    Math.max(0, (view.nodes[id].troops ?? 0) - used[id] - keep);
  const capacity = (id: number): number => capacityOf(id, safeKeep(id));

  const send = (from: number, to: number, amount: number, keep: number): number => {
    if (orders.length >= view.maxOrders) return 0;
    if (from === to || !mineSet[from]) return 0;
    if (orders.some((order) => order.from === from && order.to === to)) return 0;
    if (!Number.isFinite(hopsOf(from, to))) return 0;
    const give = Math.min(Math.floor(amount), capacityOf(from, keep));
    if (give < 1) return 0;
    orders.push({ from, to, troops: give });
    used[from] += give;
    return give;
  };

  // ---- 阶段 1：缺口增援 ----
  const requests = [...threats.entries()]
    .map(([id, threat]) => ({ id, breakAt: threat.breakAt, deficit: threat.deficit }))
    .sort((a, b) => {
      const homeBias = (id: number): number => (id === home ? 1 : 0);
      return homeBias(b.id) - homeBias(a.id) || a.breakAt - b.breakAt || b.deficit - a.deficit;
    });

  for (const request of requests) {
    if (orders.length >= view.maxOrders) break;
    if (request.deficit <= 0) continue;
    const urgent = request.id === home;
    const sources = mine
      .filter((node) => node.id !== request.id)
      .map((node) => ({ id: node.id, delay: hopsOf(node.id, request.id) }))
      .filter((item) => Number.isFinite(item.delay) && item.delay <= Math.max(0, request.breakAt))
      .sort((a, b) => a.delay - b.delay || capacity(b.id) - capacity(a.id));

    let left = request.deficit;
    for (const source of sources) {
      if (left <= 0 || orders.length >= view.maxOrders) break;
      const keep = urgent ? Math.min(safeKeep(source.id), baseKeep(source.id)) : safeKeep(source.id);
      const give = send(source.id, request.id, left, keep);
      if (give > 0) left -= give;
    }
  }

  // ---- 节点价值 ----
  const valueOf = (target: number): number => {
    const node = view.nodes[target];
    const enemy = node.owner >= 0;
    if (enemy && node.kind === 'home') return view.mode === 'duel' ? 1_000_000 : 8_000;
    let prod: number;
    if (node.kind === 'home') prod = 4;
    else if (node.kind === 'foundry') prod = 5;
    else if (node.kind === 'watchtower') prod = 2;
    else prod = 2 + Math.floor((counts[node.kind] + 1) / 2);
    const horizon = Math.min(remaining, 90);
    let value = 26 + prod * horizon * 0.55;
    if (node.kind === 'foundry') value += 26;
    if (node.kind === 'watchtower') value += 20;
    if (enemy) value += 14;
    if (remaining <= 35) value += 24;
    if (remaining <= 12) value += 28;
    return value;
  };

  // ---- 领先时锁胜：不远征、不冒险斩首 ----
  const myNodes = mine.length;
  let bestOther = 0;
  for (const player of view.players) {
    if (player.id !== me && player.alive) bestOther = Math.max(bestOther, player.nodes);
  }
  const lockWin = myNodes > bestOther && remaining <= 50;

  // ---- 阶段 2/3：扩张与进攻候选 ----
  const candidates: Candidate[] = [];
  const range = view.mode === 'duel' ? 5 : 4;

  for (const node of view.nodes) {
    if (node.owner === me) continue;
    const target = node.id;

    let delay = Infinity;
    for (const source of mine) {
      const d = hopsOf(source.id, target);
      if (d < delay) delay = d;
    }
    if (!Number.isFinite(delay) || delay > range) continue;

    const predicted = simulate(target, delay);
    if (predicted.owner === me) continue;

    const enemy = node.owner >= 0;
    // 看不到兵力的敌方老家不做盲斩：凑出来的兵力很可能一头撞死在守军上，
    // 把主力和老家安全一起赔进去。等推进到视野内再果断下手。
    if (enemy && node.kind === 'home' && node.troops === null) continue;
    if (lockWin) {
      if (enemy && node.kind === 'home') {
        if (node.troops === null || predicted.troops > 10) continue;
      } else if (delay > 2) {
        continue;
      }
    }

    const minNeed = predicted.troops + 1;
    let need = minNeed;
    let value = valueOf(target);

    if (!enemy) {
      const near = enemyDist[target];
      if (near <= delay) {
        need += 4;
        value *= 0.72;
      } else if (near <= delay + 1) {
        need += 1;
        value *= 0.92;
      }
      const adj = adjacentEnemy(target);
      if (near <= 1) {
        need += Math.min(14, Math.ceil(adj * 0.55));
        value *= 0.78;
      } else if (near <= 2) {
        need += Math.min(6, Math.ceil(adj * 0.2));
        value *= 0.9;
      }
    } else {
      // 主动进攻敌方节点通常不划算：要顶着产出增长、视野外守军和援军。
      // 视野外的点完全不知道有多少兵，盲打极容易送兵，基本不碰；
      // 只有可见的薄弱点才顺手拿，特殊节点略加分。
      if (node.troops === null) {
        need += 10;
        value -= 60;
      } else {
        need += 4;
        value -= 10;
        if (predicted.troops <= 4) value += 40;
      }
      need += Math.min(6, Math.floor(adjacentEnemy(target) / 5));
      if (node.kind === 'foundry' || node.kind === 'watchtower') value += 20;
    }

    candidates.push({
      target,
      delay,
      need,
      minNeed,
      value,
      score: value - need * 2.8 - delay * 9,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (orders.length >= view.maxOrders) break;
    if (candidate.score <= 0) break;

    const pool = mine
      .filter((node) => capacity(node.id) >= 1 && hopsOf(node.id, candidate.target) === candidate.delay)
      .sort((a, b) => capacity(b.id) - capacity(a.id));
    if (pool.length === 0) continue;

    let total = 0;
    for (const node of pool) total += capacity(node.id);
    if (total < candidate.minNeed) continue;

    const rich = pool.find((node) => capacity(node.id) >= candidate.need);
    if (rich) {
      send(rich.id, candidate.target, candidate.need, safeKeep(rich.id));
      continue;
    }
    const enough = pool.find((node) => capacity(node.id) >= candidate.minNeed);
    if (enough) {
      send(enough.id, candidate.target, candidate.minNeed, safeKeep(enough.id));
      continue;
    }

    const maxSources = candidate.value >= 8_000 ? 4 : 2;
    const picks: Array<{ id: number; amount: number }> = [];
    let left = candidate.need;
    for (const node of pool) {
      if (left <= 0 || picks.length >= maxSources) break;
      if (orders.length + picks.length >= view.maxOrders) break;
      const amount = Math.min(left, capacity(node.id));
      if (amount >= 1) {
        picks.push({ id: node.id, amount });
        left -= amount;
      }
    }
    const gathered = picks.reduce((sum, pick) => sum + pick.amount, 0);
    if (gathered < candidate.minNeed) continue;
    for (const pick of picks) send(pick.id, candidate.target, pick.amount, safeKeep(pick.id));
  }

  // ---- 阶段 4：后方兵员向前线集结 ----
  // 锁胜阶段不再往交火线倒兵：终局先比节点数、再比总兵力，攒在手里最稳。
  if (!lockWin && orders.length < view.maxOrders) {
    const front = mine.filter((node) =>
      view.adj[node.id].some((v) => {
        const owner = view.nodes[v].owner;
        return owner >= 0 && owner !== me;
      }),
    );
    const anchors: ObsNode[] = front.length > 0 ? front : [];
    if (anchors.length === 0) {
      let pick = -1;
      let pickDist = Infinity;
      for (const node of mine) {
        if (node.id === home) continue;
        const d = enemyHomes.length > 0 ? enemyHomeDist[node.id] : myHomeDist[node.id];
        if (d < pickDist) {
          pickDist = d;
          pick = node.id;
        }
      }
      if (pick >= 0) anchors.push(view.nodes[pick]);
    }

    const anchorIds = new Set(anchors.map((node) => node.id));
    // 已经堆够的锚点不再接收：兵力过度集中会先顶到 100 上限，把产出白白浪费，
    // 终局比总兵力时反而吃亏。让它留着兵，别处还有薄弱点可打。
    const anchorLoad = new Map<number, number>();
    for (const anchor of anchors) anchorLoad.set(anchor.id, view.nodes[anchor.id].troops ?? 0);
    const shipTo = (from: number, keep: number, amount: number): boolean => {
      if (orders.length >= view.maxOrders) return false;
      if (anchorIds.has(from)) return false;
      let target = -1;
      let targetDelay = Infinity;
      for (const anchor of anchors) {
        if (anchor.id === from) continue;
        if ((anchorLoad.get(anchor.id) ?? 0) >= 60) continue;
        const d = hopsOf(from, anchor.id);
        if (d < targetDelay) {
          targetDelay = d;
          target = anchor.id;
        }
      }
      if (target < 0) return false;
      const give = send(from, target, amount, keep);
      if (give > 0) anchorLoad.set(target, (anchorLoad.get(target) ?? 0) + give);
      return give > 0;
    };

    for (const node of mine) {
      if (orders.length >= view.maxOrders) break;
      if (node.id === home || anchorIds.has(node.id)) continue;
      const troops = view.nodes[node.id].troops ?? 0;
      const overfull = troops - used[node.id] >= 95;
      const cap = capacity(node.id);
      if (cap >= 6 || (overfull && cap >= 1)) shipTo(node.id, safeKeep(node.id), cap);
    }

    if (orders.length < view.maxOrders && !threats.has(home)) {
      const cap = capacity(home);
      if (cap >= 6) shipTo(home, safeKeep(home), cap);
    }
  }

  return orders;
}

export function createZhanluDeepseek(): Bot {
  return {
    name: 'zhanluDeepseek',
    style: '精确结算 · 全局调度',
    decide(view: Observation): Order[] {
      try {
        return plan(view);
      } catch {
        return [];
      }
    },
  };
}