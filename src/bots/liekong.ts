/**
 * 裂空（Liekong）— 四人混战专精
 *
 * 思路：
 * - 经济优先：按「边际产出 × 剩余回合」给每个可占领节点估值，优先低守军、高产出、
 *   能补同类的点；兵工厂与瞭望塔额外加分。
 * - 视野即防御：老家 2 跳与瞭望塔 3 跳的视野能提前看到来袭纵队，只对本回合到达的
 *   威胁做精确增援，避免为了看不见的威胁囤兵。
 * - 预防性防守：邻接敌方兵力超过自身守军的节点，提前补到能挡住一次直接进攻；
 *   老家附近出现敌情时冻结老家，优先自保。
 * - 不盲攻：敌方节点兵力未知时不进攻，避免把兵送进战争迷雾；明显强于自己的对手，
 *   其普通节点大幅降权，避免主动招惹。
 * - 相邻多源合击：同一回合到达的多个己方节点可以合并结算，用最少指令凑出压倒兵力。
 * - 终局斩首：敌方老家可见且守军可被压过时集火拿下，直接淘汰一家并接收其领地。
 */

import type { Bot, NodeKind, Observation, ObsNode, Order } from '../engine/types.js';

const NEUTRAL = -1;

const TUNING = {
  /** 老家留守上限 */
  homeGuardMax: 16,
  /** 老家对邻近敌方兵力的防守折算上限 */
  homeGuardDangerCap: 14,
  /** 后方己方节点留守 */
  backKeep: 1,
  /** 打中立点的余量 */
  neutralBuffer: 0,
  /** 打敌方节点的余量（防未知增援） */
  enemyBuffer: 2,
  /** 目标邻接敌方节点时的额外余量 */
  neighborEnemyBuffer: 1,
  /** 占领后的额外留兵 */
  extraGarrison: 0,
  /** 瞭望塔基础价值 */
  towerValue: 18,
  /** 兵工厂基础价值 */
  foundryValue: 12,
  /** 敌方节点额外价值 */
  enemyNodeBonus: 10,
  /** 每个节点的基础价值（终局按节点数排名） */
  nodeBonus: 26,
  /** 斩首基础价值 */
  homeKillValue: 320,
  /** 后方前送的最小可调兵力 */
  shuttleThreshold: 3,
} as const;

type Counts = Record<NodeKind, number>;

function countsOf(nodes: readonly ObsNode[], owner: number): Counts {
  const counts: Counts = { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 };
  for (const node of nodes) if (node.owner === owner) counts[node.kind]++;
  return counts;
}

function productionOf(kind: NodeKind, counts: Counts): number {
  if (kind === 'home') return 4;
  if (kind === 'foundry') return 5;
  if (kind === 'watchtower') return 2;
  return 2 + Math.floor((counts[kind] ?? 0) / 2);
}

/** 从每个己方节点出发的最短距离（敌方节点可作为终点，但不能穿过）。 */
function buildReach(view: Observation): Array<number[] | null> {
  const n = view.nodes.length;
  const out: Array<number[] | null> = new Array(n).fill(null);
  for (let start = 0; start < n; start++) {
    if (view.nodes[start].owner !== view.you) continue;
    const dist = new Array<number>(n).fill(-1);
    dist[start] = 0;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi];
      for (const v of view.adj[u]) {
        if (dist[v] !== -1) continue;
        dist[v] = dist[u] + 1;
        const owner = view.nodes[v].owner;
        if (owner === NEUTRAL || owner === view.you) queue.push(v);
      }
    }
    out[start] = dist;
  }
  return out;
}

/** 本回合到达我方节点的敌方兵力（同一玩家多支纵队合并，跨玩家取最大）。 */
function immediateThreat(view: Observation): Map<number, number> {
  const perNode = new Map<number, Map<number, number>>();
  for (const column of view.columns) {
    if (column.owner === view.you) continue;
    const target = column.path[column.path.length - 1];
    if (view.nodes[target].owner !== view.you) continue;
    if (column.arriveTurn > view.turn) continue;
    let owners = perNode.get(target);
    if (!owners) {
      owners = new Map<number, number>();
      perNode.set(target, owners);
    }
    owners.set(column.owner, (owners.get(column.owner) ?? 0) + column.troops);
  }
  const threat = new Map<number, number>();
  for (const [node, owners] of perNode) {
    let worst = 0;
    for (const troops of owners.values()) worst = Math.max(worst, troops);
    threat.set(node, worst);
  }
  return threat;
}

function hasEnemyNeighbor(view: Observation, nodeId: number): boolean {
  for (const v of view.adj[nodeId]) {
    const owner = view.nodes[v].owner;
    if (owner >= 0 && owner !== view.you) return true;
  }
  return false;
}

function adjacentEnemyTroops(view: Observation, nodeId: number): number {
  let worst = 0;
  for (const v of view.adj[nodeId]) {
    const node = view.nodes[v];
    if (node.owner < 0 || node.owner === view.you) continue;
    worst = Math.max(worst, node.troops ?? 0);
  }
  return worst;
}

function frontKeepFor(turn: number): number {
  if (turn <= 10) return 1;
  if (turn <= 25) return 2;
  if (turn <= 50) return 3;
  return 4;
}

function homeGuardBase(turn: number): number {
  if (turn <= 1) return 3;
  if (turn <= 3) return 4;
  if (turn <= 8) return 6;
  if (turn <= 15) return 8;
  if (turn <= 30) return 10;
  return 12;
}

function homePressure(view: Observation): number {
  let pressure = 0;
  const seen = new Array<boolean>(view.nodes.length).fill(false);
  const home = view.homeNode;
  seen[home] = true;
  let frontier = [home];
  for (let depth = 0; depth <= 2; depth++) {
    const next: number[] = [];
    for (const u of frontier) {
      for (const v of view.adj[u]) {
        if (seen[v]) continue;
        seen[v] = true;
        const dist = depth + 1;
        const owner = view.nodes[v].owner;
        if (owner >= 0 && owner !== view.you) {
          const troops = view.nodes[v].troops ?? 0;
          pressure = Math.max(pressure, dist === 1 ? troops : Math.floor(troops * 0.2));
          continue;
        }
        if (dist < 2) next.push(v);
      }
    }
    frontier = next;
  }
  return pressure;
}

function reserveFor(
  view: Observation,
  node: ObsNode,
  threat: Map<number, number>,
  pressure: number,
): number {
  const troops = node.troops ?? 0;
  if (node.kind === 'home') {
    const base = Math.min(TUNING.homeGuardMax, homeGuardBase(view.turn));
    const danger = Math.min(TUNING.homeGuardDangerCap, Math.max(pressure, adjacentEnemyTroops(view, node.id)));
    return Math.min(troops, Math.max(base, (threat.get(node.id) ?? 0) + 1, danger));
  }
  let reserve: number = TUNING.backKeep;
  if (hasEnemyNeighbor(view, node.id)) {
    reserve = Math.max(frontKeepFor(view.turn), Math.min(6, adjacentEnemyTroops(view, node.id)));
  }
  if ((threat.get(node.id) ?? 0) > 0) reserve = Math.max(reserve, (threat.get(node.id) ?? 0) + 1);
  return Math.min(troops, reserve);
}

/** 已在路上的己方纵队兵力，避免对同一目标重复投入。 */
function ownIncoming(view: Observation, targetId: number): number {
  let total = 0;
  for (const column of view.columns) {
    if (column.owner !== view.you) continue;
    if (column.path[column.path.length - 1] !== targetId) continue;
    total += column.troops;
  }
  return total;
}

/** 敌方相邻同伙可能投入的增援（保守按 60% 估算，最多 8）。 */
function reinforcementEstimate(view: Observation, target: ObsNode): number {
  if (target.owner < 0) return 0;
  let best = 0;
  for (const v of view.adj[target.id]) {
    const node = view.nodes[v];
    if (node.owner !== target.owner) continue;
    if (node.troops === null) continue;
    best = Math.max(best, Math.max(0, node.troops - 2));
  }
  return Math.min(8, Math.ceil(best * 0.6));
}

function captureValue(
  view: Observation,
  node: ObsNode,
  counts: Counts,
  remaining: number,
): number {
  const count = counts[node.kind] ?? 0;
  let productionGain: number;
  if (node.kind === 'farm' || node.kind === 'mine' || node.kind === 'lab') {
    const before = count * (2 + Math.floor(count / 2));
    const after = (count + 1) * (2 + Math.floor((count + 1) / 2));
    productionGain = after - before;
  } else {
    productionGain = productionOf(node.kind, counts);
  }

  let value = productionGain * remaining + TUNING.nodeBonus;
  if (node.kind === 'watchtower') {
    value += TUNING.towerValue + Math.max(0, 60 - view.turn) * 0.9;
  }
  if (node.kind === 'foundry') value += TUNING.foundryValue;
  if (node.owner >= 0) {
    value += TUNING.enemyNodeBonus;
    for (const v of view.adj[node.id]) {
      if (view.nodes[v].kind === 'home' && view.nodes[v].owner === node.owner) {
        value += 35;
        break;
      }
    }
    const own = view.players.find((player) => player.id === view.you);
    const target = view.players.find((player) => player.id === node.owner);
    if (own && target) {
      if (target.nodes > own.nodes * 1.4) value *= 0.45;
      else if (target.nodes < own.nodes * 0.7) value *= 1.15;
    }
  }
  return value;
}

function homeKillValue(view: Observation): number {
  const own = view.players.find((player) => player.id === view.you);
  const leaderNodes = Math.max(...view.players.map((player) => (player.alive ? player.nodes : 0)));
  const edge = Math.max(0, own ? leaderNodes - own.nodes : 0);
  return TUNING.homeKillValue + Math.max(0, 150 - view.turn) * 2 + edge * 55;
}

interface Source {
  from: number;
  avail: number;
  turns: number;
}

interface Plan {
  target: number;
  need: number;
  value: number;
  sources: Source[];
  homeKill: boolean;
}

function planScore(plan: Plan): number {
  return plan.value / (plan.need + 2);
}

function buildPlans(
  view: Observation,
  reach: Array<number[] | null>,
  reserve: number[],
  spent: number[],
  counts: Counts,
  planned: Set<number>,
  homeAlert: boolean,
): Plan[] {
  const remaining = Math.max(1, view.maxTurns - view.turn + 1);
  const plans: Plan[] = [];

  for (const target of view.nodes) {
    if (target.owner === view.you) continue;
    if (planned.has(target.id)) continue;
    if (target.owner >= 0 && target.troops === null) continue;

    const isHome = target.kind === 'home' && target.owner >= 0;
    const enemyNeighbor = hasEnemyNeighbor(view, target.id);
    let buffer: number;
    if (target.owner === NEUTRAL) {
      buffer = TUNING.neutralBuffer + (enemyNeighbor ? TUNING.neighborEnemyBuffer : 0);
    } else {
      buffer =
        TUNING.enemyBuffer +
        (enemyNeighbor ? TUNING.neighborEnemyBuffer : 0) +
        reinforcementEstimate(view, target);
      if (isHome) buffer += 2;
    }

    const sources: Source[] = [];
    for (const source of view.nodes) {
      if (source.owner !== view.you) continue;
      // 老家只打中立点或斩首，避免为了普通敌方节点抽空老家守军。
      if (target.owner >= 0 && !isHome && source.id === view.homeNode) continue;
      // 老家附近出现敌情时冻结老家，专注自保。
      if (homeAlert && source.id === view.homeNode && !isHome) continue;
      const dist = reach[source.id];
      if (!dist) continue;
      const d = dist[target.id];
      if (d !== 1 && d !== 2 && d !== 3) continue;
      const avail = (source.troops ?? 0) - reserve[source.id] - spent[source.id];
      if (avail < 1) continue;
      sources.push({ from: source.id, avail, turns: d - 1 });
    }
    if (sources.length === 0) continue;

    let value: number;
    if (isHome) {
      value = homeKillValue(view);
    } else {
      value = captureValue(view, target, counts, remaining);
    }

    const incoming = ownIncoming(view, target.id);
    for (const turns of [0, 1, 2]) {
      const need = Math.max(
        0,
        (target.troops ?? 0) + 1 + buffer + TUNING.extraGarrison + turns - incoming,
      );
      if (need <= 0) continue;
      const sameTurn = sources.filter((source) => {
        if (source.turns !== turns) return false;
        if (turns === 0) return true;
        if (hasEnemyNeighbor(view, source.from)) return false;
        if (source.from === view.homeNode && view.turn <= 8) return false;
        return true;
      });
      const total = sameTurn.reduce((sum, source) => sum + source.avail, 0);
      if (total < need || sameTurn.length === 0) continue;

      // 普通目标优先单源，避免把 5 条指令耗在一次合击上；只有斩首才允许大规模合兵。
      let chosen: Source[] | null = null;
      const single = sameTurn
        .filter((source) => source.avail >= need)
        .sort((a, b) => a.avail - b.avail)[0];
      if (single) {
        chosen = [single];
      } else if (isHome) {
        const sorted = [...sameTurn].sort((a, b) => b.avail - a.avail);
        let sum = 0;
        const picks: Source[] = [];
        for (const source of sorted) {
          picks.push(source);
          sum += source.avail;
          if (sum >= need) break;
        }
        if (sum >= need) chosen = picks;
      } else if (sameTurn.length >= 2) {
        const sorted = [...sameTurn].sort((a, b) => b.avail - a.avail);
        let sum = 0;
        const picks: Source[] = [];
        for (const source of sorted) {
          if (picks.length >= 2) break;
          picks.push(source);
          sum += source.avail;
          if (sum >= need) break;
        }
        if (sum >= need) chosen = picks;
      }
      if (!chosen) continue;

      plans.push({
        target: target.id,
        need,
        value: value * (1 - turns * 0.12),
        sources: chosen,
        homeKill: isHome,
      });
      break;
    }
  }

  plans.sort((a, b) => planScore(b) - planScore(a));
  return plans;
}

interface Pick {
  from: number;
  to: number;
  troops: number;
}

function executePlan(
  plan: Plan,
  view: Observation,
  reserve: number[],
  spent: number[],
  orders: Order[],
  usedPairs: Set<string>,
  maxOrders: number,
): Pick[] {
  const picks: Pick[] = [];
  let remaining = plan.need;
  let budget = maxOrders - orders.length;

  for (const source of plan.sources) {
    if (remaining <= 0) break;
    if (budget <= 0) break;
    const avail = (view.nodes[source.from].troops ?? 0) - reserve[source.from] - spent[source.from];
    if (avail < 1) continue;
    const take = Math.min(avail, remaining);
    if (take < 1) continue;
    const key = `${source.from}>${plan.target}`;
    if (usedPairs.has(key)) continue;
    picks.push({ from: source.from, to: plan.target, troops: take });
    remaining -= take;
    budget--;
  }

  if (remaining > 0) return [];

  for (const pick of picks) {
    spent[pick.from] += pick.troops;
    usedPairs.add(`${pick.from}>${pick.to}`);
    orders.push({ from: pick.from, to: pick.to, troops: pick.troops });
  }
  return picks;
}

/** 防守：处理本回合到达的威胁，优先老家，其次是守得住的普通节点。 */
function defend(
  view: Observation,
  reach: Array<number[] | null>,
  threat: Map<number, number>,
  reserve: number[],
  spent: number[],
  orders: Order[],
  usedPairs: Set<string>,
  maxOrders: number,
  homeAlert: boolean,
): void {
  const targets = [...threat.entries()].sort((a, b) => {
    const nodeA = view.nodes[a[0]];
    const nodeB = view.nodes[b[0]];
    const homeA = nodeA.kind === 'home' ? 1 : 0;
    const homeB = nodeB.kind === 'home' ? 1 : 0;
    return homeB - homeA || b[1] - a[1];
  });

  let defenses = 0;
  for (const [targetId, incoming] of targets) {
    if (orders.length >= maxOrders || defenses >= 2) break;
    const target = view.nodes[targetId];
    const deficit = incoming + 1 - (target.troops ?? 0) - ownIncoming(view, targetId);
    if (deficit <= 0) continue;
    if (target.kind !== 'home' && deficit > 12) continue;

    const candidates: Source[] = [];
    for (const source of view.nodes) {
      if (source.owner !== view.you || source.id === targetId) continue;
      if (homeAlert && source.id === view.homeNode) continue;
      const dist = reach[source.id];
      if (!dist || dist[targetId] !== 1) continue;
      if ((threat.get(source.id) ?? 0) > 0) continue;
      const avail = (source.troops ?? 0) - reserve[source.id] - spent[source.id];
      if (avail >= 1) candidates.push({ from: source.id, avail, turns: 0 });
    }

    candidates.sort((a, b) => b.avail - a.avail);
    let remaining = deficit;
    const picks: Pick[] = [];
    for (const candidate of candidates) {
      if (remaining <= 0 || orders.length + picks.length >= maxOrders) break;
      const avail = (view.nodes[candidate.from].troops ?? 0) - reserve[candidate.from] - spent[candidate.from];
      if (avail < 1) continue;
      const key = `${candidate.from}>${targetId}`;
      if (usedPairs.has(key)) continue;
      const take = Math.min(avail, remaining);
      picks.push({ from: candidate.from, to: targetId, troops: take });
      remaining -= take;
    }
    if (remaining > 0) continue;

    for (const pick of picks) {
      spent[pick.from] += pick.troops;
      usedPairs.add(`${pick.from}>${pick.to}`);
      orders.push({ from: pick.from, to: pick.to, troops: pick.troops });
    }
    defenses++;
  }
}

/** 预防性增援：邻接敌方兵力超过自身守军的节点，提前补到能挡住直接进攻。 */
function prevent(
  view: Observation,
  reach: Array<number[] | null>,
  threat: Map<number, number>,
  reserve: number[],
  spent: number[],
  orders: Order[],
  usedPairs: Set<string>,
  maxOrders: number,
  homeAlert: boolean,
): void {
  const targets = view.nodes
    .filter((node) => node.owner === view.you)
    .map((node) => ({ node, potential: adjacentEnemyTroops(view, node.id) }))
    .filter((target) => target.potential > 0)
    .sort((a, b) => {
      const homeA = a.node.kind === 'home' ? 1 : 0;
      const homeB = b.node.kind === 'home' ? 1 : 0;
      return homeB - homeA || b.potential - a.potential;
    });

  let actions = 0;
  for (const { node, potential } of targets) {
    if (orders.length >= maxOrders || actions >= 2) break;
    const current = (node.troops ?? 0) + ownIncoming(view, node.id);
    if (current > potential) continue;

    const buffer = node.kind === 'home' ? 4 : 2;
    let deficit = Math.min(28, potential + buffer) - current;
    if (deficit <= 0) continue;

    const candidates: Source[] = [];
    for (const source of view.nodes) {
      if (source.owner !== view.you || source.id === node.id) continue;
      if (homeAlert && source.id === view.homeNode && !view.adj[node.id].includes(view.homeNode)) {
        continue;
      }
      const dist = reach[source.id];
      if (!dist || dist[node.id] !== 1) continue;
      if ((threat.get(source.id) ?? 0) > 0) continue;
      if (source.id !== view.homeNode && adjacentEnemyTroops(view, source.id) > 0) continue;
      const avail = (source.troops ?? 0) - reserve[source.id] - spent[source.id];
      if (avail >= 1) candidates.push({ from: source.id, avail, turns: 0 });
    }
    candidates.sort((a, b) => b.avail - a.avail);

    const picks: Pick[] = [];
    for (const candidate of candidates) {
      if (deficit <= 0 || orders.length + picks.length >= maxOrders) break;
      const avail = (view.nodes[candidate.from].troops ?? 0) - reserve[candidate.from] - spent[candidate.from];
      if (avail < 1) continue;
      const key = `${candidate.from}>${node.id}`;
      if (usedPairs.has(key)) continue;
      const take = Math.min(avail, deficit);
      picks.push({ from: candidate.from, to: node.id, troops: take });
      deficit -= take;
    }
    if (deficit > 0) continue;

    for (const pick of picks) {
      spent[pick.from] += pick.troops;
      usedPairs.add(`${pick.from}>${pick.to}`);
      orders.push({ from: pick.from, to: pick.to, troops: pick.troops });
    }
    actions++;
  }
}

/** 后方多余兵力向边界节点前送，避免老家囤兵。 */
function shuttle(
  view: Observation,
  reserve: number[],
  spent: number[],
  orders: Order[],
  usedPairs: Set<string>,
  maxOrders: number,
  pressure: number,
  homeAlert: boolean,
): void {
  if (orders.length >= maxOrders) return;

  for (const source of view.nodes) {
    if (source.owner !== view.you) continue;
    const isHome = source.kind === 'home';
    const homeLocked = isHome && (homeAlert || pressure > 0 || adjacentEnemyTroops(view, source.id) > 0);
    const avail = (source.troops ?? 0) - reserve[source.id] - spent[source.id];
    if (avail < TUNING.shuttleThreshold) continue;

    let best: number | null = null;
    let bestScore = -Infinity;
    for (const neighborId of view.adj[source.id]) {
      const neighbor = view.nodes[neighborId];
      if (neighbor.owner !== view.you) continue;
      const key = `${source.id}>${neighborId}`;
      if (usedPairs.has(key)) continue;
      let score = 0;
      if (hasEnemyNeighbor(view, neighborId)) score += 20;
      for (const v of view.adj[neighborId]) {
        const owner = view.nodes[v].owner;
        if (owner >= 0 && owner !== view.you) score += 30;
        else if (owner === NEUTRAL) score += 5;
      }
      score -= (neighbor.troops ?? 0) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = neighborId;
      }
    }

    if (best === null || bestScore <= 0) continue;
    const send = avail - (homeLocked ? 2 : 1);
    if (send < 1) continue;
    spent[source.id] += send;
    orders.push({ from: source.id, to: best, troops: send });
    usedPairs.add(`${source.id}>${best}`);
    if (orders.length >= maxOrders) return;
  }
}

export function createLiekong(): Bot {
  return {
    name: '裂空',
    style: '经济滚雪球 · 视野预警 · 多源合击 · 终局斩首',
    decide(view: Observation): Order[] {
      const reach = buildReach(view);
      const threat = immediateThreat(view);
      const pressure = homePressure(view);
      const homeAdjacent = adjacentEnemyTroops(view, view.homeNode);
      const portalThreat = view.adj[view.homeNode].some((id) => {
        const node = view.nodes[id];
        return node.owner === view.you && (node.troops ?? 0) <= adjacentEnemyTroops(view, id);
      });
      const homeAlert = pressure >= 2 || homeAdjacent >= 1 || portalThreat;
      const reserve = view.nodes.map((node) => reserveFor(view, node, threat, pressure));
      const spent = new Array<number>(view.nodes.length).fill(0);
      const orders: Order[] = [];
      const usedPairs = new Set<string>();
      const counts = countsOf(view.nodes, view.you);
      const maxOrders = Math.min(view.maxOrders, view.ordersLeft);

      defend(view, reach, threat, reserve, spent, orders, usedPairs, maxOrders, homeAlert);
      prevent(view, reach, threat, reserve, spent, orders, usedPairs, maxOrders, homeAlert);

      const remaining = Math.max(1, view.maxTurns - view.turn + 1);
      const lastTurns = remaining <= 5;
      const planned = new Set<number>();

      while (orders.length < maxOrders) {
        const plans = buildPlans(view, reach, reserve, spent, counts, planned, homeAlert);
        if (plans.length === 0) break;
        let acted = false;
        for (const plan of plans) {
          const target = view.nodes[plan.target];
          if (lastTurns && !plan.homeKill && target.owner !== NEUTRAL) continue;
          const before = orders.length;
          executePlan(plan, view, reserve, spent, orders, usedPairs, maxOrders);
          if (orders.length > before) {
            counts[target.kind]++;
            planned.add(plan.target);
            acted = true;
            break;
          }
          planned.add(plan.target);
        }
        if (!acted) break;
      }

      if (!lastTurns && orders.length < maxOrders) {
        shuttle(view, reserve, spent, orders, usedPairs, maxOrders, pressure, homeAlert);
      }

      return orders;
    },
  };
}
