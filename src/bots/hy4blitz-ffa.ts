/**
 * hy4blitz-ffa —— 四人混战专精 bot（极限扩产流）
 *
 * 设计原则（严格按六条规则，不预留防守兵力）：
 *  1. 每回合用满 5 条指令，优先把「能一回合打下」的节点全部拿下；
 *  2. 不防守：不留老家卫队、不回防、不因为怕被偷家而少派兵；
 *  3. 老家 3 跳内的敌方（非中立）节点最高优先级，越近越优先；
 *  4. 老家 4 跳内、与我方前线相邻、集结重兵的敌方节点，多源合击立即摧毁；
 *     兵工厂守军更硬，不适用本条（仍按普通高产出节点正常评估）；
 *  5. 敌方老家按普通「产 4 兵的节点」计价，本身没有特殊意义；
 *     仅当斩首后能顺势收割其大量节点时才给斩首加权；
 *  6. 剩余指令继续前置兵力 / 搬运溢出兵力，持续提高下回合产出。
 *
 * 纯函数：只读 view，不依赖外部状态。
 */

import type { Bot, Observation, ObsNode, Order } from '../engine/types.js';

const NEUTRAL = -1;
const TROOP_CAP = 100;
/** 多源围歼的判定距离与重兵阈值 */
const MASS_DIST = 4;
const MASS_THRESHOLD = 12;
/** 单次进攻允许的最远出发距离（跳），越远评分越低 */
const MAX_ATTACK_DIST = 3;
/** 一跳内敌方夺取优先级权重 */
const HOME_PRIORITY = [0, 140, 80, 50] as const;

interface Source {
  id: number;
  avail: number;
  dist: number;
}

interface Plan {
  target: number;
  need: number;
  legs: Array<{ from: number; troops: number }>;
  score: number;
}

interface Context {
  me: number;
  home: number;
  turn: number;
  mine: number[];
  /** 到己方老家的图距离（无视归属） */
  distHome: number[];
  /** 节点是否与己方领土相邻 */
  frontAdj: boolean[];
  /** 本回合到达该节点的敌方纵队总量（用于识别重兵集结） */
  incomingEnemy: number[];
  ownKindCount: Record<string, number>;
  endgame: boolean;
}

/** 中立节点的产出（Observation 里中立点 production 恒为 0，需按类型推断）。 */
function baseProduction(kind: ObsNode['kind']): number {
  switch (kind) {
    case 'foundry':
      return 5;
    case 'home':
      return 4;
    default:
      return 2;
  }
}

/**
 * 与引擎一致的最短路：可经己方与中立节点，不可穿越敌方节点，终点本身可以是敌方节点。
 */
function findPath(view: Observation, from: number, to: number): number[] | null {
  if (from === to) return null;
  const nodes = view.nodes;
  const mover = nodes[from].owner;
  if (mover === NEUTRAL) return null;

  const n = nodes.length;
  const prev = new Int32Array(n).fill(-1);
  prev[from] = from;
  const queue: number[] = [from];

  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of view.adj[u]) {
      if (prev[v] !== -1) continue;
      if (v !== to && nodes[v].owner !== NEUTRAL && nodes[v].owner !== mover) continue;
      prev[v] = u;
      if (v === to) {
        const path = [to];
        let cur = to;
        while (cur !== from) {
          cur = prev[cur];
          path.push(cur);
        }
        return path.reverse();
      }
      queue.push(v);
    }
  }
  return null;
}

/** 无视归属的图距离，用于「离老家 N 跳」的判定。 */
function graphDistance(adj: number[][], sources: number[]): number[] {
  const dist = new Array<number>(adj.length).fill(Infinity);
  const queue: number[] = [];
  for (const s of sources) {
    dist[s] = 0;
    queue.push(s);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of adj[u]) {
      if (dist[v] !== Infinity) continue;
      dist[v] = dist[u] + 1;
      queue.push(v);
    }
  }
  return dist;
}

/** 视野外敌军兵力未知，按产出粗略估计；不确定性在评分中另扣。 */
function estimateUnknown(target: ObsNode, turn: number): number {
  const production = target.production > 0 ? target.production : baseProduction(target.kind);
  return Math.min(45, 5 + production * Math.min(turn, 10));
}

/** 打下目标需要的净增兵力：最强非我方阵营 + 1，并扣除同回合到达的己方纵队。 */
function combatNeed(
  view: Observation,
  target: ObsNode,
): { need: number; uncertain: boolean; alreadyFalling: boolean } {
  const forces = new Map<number, number>();
  const uncertain = target.troops === null;
  forces.set(target.owner, target.troops ?? estimateUnknown(target, view.turn));

  let friendly = 0;
  for (const col of view.columns) {
    if (col.arriveTurn !== view.turn) continue;
    if (col.path[col.path.length - 1] !== target.id) continue;
    if (col.owner === view.you) friendly += col.troops;
    else forces.set(col.owner, (forces.get(col.owner) ?? 0) + col.troops);
  }

  let strongest = 0;
  for (const [owner, amount] of forces) {
    if (owner === view.you) continue;
    if (amount > strongest) strongest = amount;
  }
  const need = strongest - friendly + 1;
  return { need, uncertain, alreadyFalling: need <= 0 };
}

/** 占领后我方每回合新增的产出（农场/矿场/研究院含同类规模效应）。 */
function expectedGain(target: ObsNode, ctx: Context): number {
  switch (target.kind) {
    case 'home':
      return 4;
    case 'foundry':
      return 5;
    case 'watchtower':
      return 2;
    default:
      return 2 + Math.floor(((ctx.ownKindCount[target.kind] ?? 0) + 1) / 2);
  }
}

/** 还在活跃的敌方老家（死者旧家只是普通据点）。 */
function isLiveHome(node: ObsNode): boolean {
  return node.kind === 'home' && node.owner !== NEUTRAL && node.owner === node.id;
}

/** 斩首后可顺势收取的节点数：敌人家附近 2 跳内，或直接贴着我方前线的据点。 */
function sweepPotential(view: Observation, target: ObsNode, ctx: Context): number {
  const aroundHome = graphDistance(view.adj, [target.id]);
  let count = 0;
  for (const node of view.nodes) {
    if (node.owner !== target.owner || node.id === target.id) continue;
    if (aroundHome[node.id] <= 2 || ctx.frontAdj[node.id]) count++;
  }
  return count;
}

function scoreTarget(
  view: Observation,
  target: ObsNode,
  ctx: Context,
  need: number,
  dist: number,
  sourceCount: number,
  uncertain: boolean,
): number {
  let score = expectedGain(target, ctx) * 9 + 12; // 产出 + 节点数

  if (target.owner === NEUTRAL) {
    score += 4; // 中立守军公开、成本确定
  } else {
    const denied = target.production > 0 ? target.production : baseProduction(target.kind);
    score += denied * 2; // 混战是零和：削弱对手等价于抬高自己

    // 规则 3：老家 3 跳内的敌方节点，最高优先级，越近越高
    const d = ctx.distHome[target.id];
    if (d <= 3) score += HOME_PRIORITY[d];

    // 规则 4：4 跳内、贴前线、集结重兵 —— 多源围歼；兵工厂不适用
    const mass = (target.troops ?? 0) + ctx.incomingEnemy[target.id];
    if (
      target.kind !== 'foundry' &&
      d <= MASS_DIST &&
      ctx.frontAdj[target.id] &&
      mass >= MASS_THRESHOLD
    ) {
      score += 70 + Math.min(30, mass);
    }

    // 规则 5：敌方老家只是产 4 兵的节点；只有能顺势收割时才额外加权
    if (isLiveHome(target)) {
      const sweep = sweepPotential(view, target, ctx);
      if (sweep >= 3) score += 20 + 4 * sweep;
      else score -= 10; // 没有收割价值就不为「老家」二字付溢价
    }
  }

  score -= need * 0.9;
  score -= dist * 12;
  score -= (sourceCount - 1) * 9;
  if (uncertain) score -= 22; // 视野外兵力不确定，降低优先级
  if (ctx.endgame) score += 20; // 150 回合后按节点数决胜
  return score;
}

/** 在当前兵力分配下，为某个目标找一份「同一回合到达、刚好够赢」的合击方案。 */
function makePlan(
  view: Observation,
  target: ObsNode,
  ctx: Context,
  slots: number,
  usedFrom: number[],
): Plan | null {
  const { need, uncertain, alreadyFalling } = combatNeed(view, target);
  if (alreadyFalling || need > TROOP_CAP * 4) return null;

  const byDist = new Map<number, Source[]>();
  for (const s of ctx.mine) {
    const avail = (view.nodes[s].troops ?? 0) - usedFrom[s];
    if (avail < 1) continue;
    const path = findPath(view, s, target.id);
    if (!path) continue;
    const dist = path.length - 2;
    if (dist > MAX_ATTACK_DIST) continue;
    const list = byDist.get(dist) ?? [];
    list.push({ id: s, avail, dist });
    byDist.set(dist, list);
  }

  let chosen: Source[] = [];
  let chosenDist = -1;
  for (const dist of [...byDist.keys()].sort((a, b) => a - b)) {
    const group = byDist.get(dist)!.sort((a, b) => b.avail - a.avail);
    const candidates = group.slice(0, slots);
    let sum = 0;
    const pick: Source[] = [];
    for (const src of candidates) {
      if (sum >= need) break;
      pick.push(src);
      sum += src.avail;
    }
    if (sum < need) continue;
    chosen = pick;
    chosenDist = dist;
    break;
  }
  if (chosen.length === 0) return null;

  const legs: Plan['legs'] = [];
  let remaining = need;
  for (const src of chosen) {
    const send = Math.min(src.avail, remaining);
    if (send < 1) continue;
    legs.push({ from: src.id, troops: send });
    remaining -= send;
  }
  if (remaining > 0) return null;

  const score = scoreTarget(view, target, ctx, need, chosenDist, legs.length, uncertain);
  return { target: target.id, need, legs, score };
}

/** 剩余指令用来把兵力推向前线 / 搬走顶格节点的溢出产出，不留在家里空转。 */
function bestReinforcement(
  view: Observation,
  ctx: Context,
  usedFrom: number[],
  usedTo: Set<number>,
): { from: number; to: number; troops: number; score: number } | null {
  let best: { from: number; to: number; troops: number; score: number } | null = null;

  for (const from of ctx.mine) {
    const avail = (view.nodes[from].troops ?? 0) - usedFrom[from];
    if (avail < 3) continue;
    for (const to of ctx.mine) {
      if (to === from || usedTo.has(to)) continue;
      const path = findPath(view, from, to);
      if (!path) continue;
      const dist = path.length - 2;
      if (dist > 3) continue;

      const room = TROOP_CAP - (view.nodes[to].troops ?? 0);
      if (room < 3) continue;
      const troops = Math.min(avail, room, 35);
      if (troops < 3) continue;

      let score = 10 + troops * 0.1 - dist * 3;
      if ((view.nodes[from].troops ?? 0) >= 85) score += 25; // 快顶格的节点产出会浪费
      if (ctx.frontAdj[to]) score += 12;
      if (view.nodes[to].kind === 'foundry') score += 6;
      if ((view.nodes[to].troops ?? 0) === 0) score += 5;
      if (to === ctx.home) score -= 8;
      if (!best || score > best.score) best = { from, to, troops, score };
    }
  }
  return best;
}

export function createHy4BlitzFfa(): Bot {
  return {
    name: 'hy4blitz-ffa',
    style: '混战专精 · 极限扩产 · 近家清剿 · 重兵围歼 · 条件斩首',

    decide(view: Observation): Order[] {
      const budget = Math.min(view.ordersLeft, view.maxOrders, 5);
      if (budget <= 0) return [];

      const me = view.you;
      const nodes = view.nodes;
      const n = nodes.length;
      const mine = nodes.filter((node) => node.owner === me).map((node) => node.id);
      if (mine.length === 0) return [];

      const ownKindCount: Record<string, number> = {};
      for (const node of nodes) {
        if (node.owner === me) ownKindCount[node.kind] = (ownKindCount[node.kind] ?? 0) + 1;
      }

      const incomingEnemy = new Array<number>(n).fill(0);
      for (const col of view.columns) {
        if (col.owner === me || col.arriveTurn !== view.turn) continue;
        incomingEnemy[col.path[col.path.length - 1]] += col.troops;
      }

      const ctx: Context = {
        me,
        home: view.homeNode,
        turn: view.turn,
        mine,
        distHome: graphDistance(view.adj, [view.homeNode]),
        frontAdj: nodes.map((node) => view.adj[node.id].some((nb) => nodes[nb].owner === me)),
        incomingEnemy,
        ownKindCount,
        endgame: view.turn >= view.maxTurns - 8,
      };

      const orders: Order[] = [];
      const usedFrom = new Array<number>(n).fill(0);
      const usedTo = new Set<number>();

      // ---- 阶段 1：按评分贪心拿下尽量多的目标 ----
      while (orders.length < budget) {
        const slots = budget - orders.length;
        let best: Plan | null = null;
        for (const target of nodes) {
          if (target.owner === me || usedTo.has(target.id)) continue;
          const plan = makePlan(view, target, ctx, slots, usedFrom);
          if (!plan || plan.score <= 0) continue;
          if (!best || plan.score > best.score) best = plan;
        }
        if (!best) break;

        for (const leg of best.legs) {
          orders.push({ from: leg.from, to: best.target, troops: leg.troops });
          usedFrom[leg.from] += leg.troops;
        }
        usedTo.add(best.target);
      }

      // ---- 阶段 2：指令没用满就继续搬运兵力，提升下一回合的产出与打击半径 ----
      while (orders.length < budget) {
        const best = bestReinforcement(view, ctx, usedFrom, usedTo);
        if (!best) break;
        orders.push({ from: best.from, to: best.to, troops: best.troops });
        usedFrom[best.from] += best.troops;
        usedTo.add(best.to);
      }

      return orders;
    },
  };
}

export default createHy4BlitzFfa;
