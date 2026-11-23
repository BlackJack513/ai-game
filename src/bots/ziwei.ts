/**
 * 「紫微」—— 北极帝星，众星（天枢亦在其列）环之而转。
 *
 * 设计要点：
 *   1. 与引擎逐位一致的时间轴推演：在途纵队、产出增长、同刻合并结算、平局守方留点。
 *   2. 老家「可反应安全」约束：敌军任意节点 k 回合内能打到老家的兵力，必须 ≤ 老家守军 + k 回合产出
 *      + 能在看到来袭后（k−1 回合内）赶回的己方兵力。每一条出兵指令都要先过这道闸，
 *      既不白锁死兵力，也不会被零延迟偷家。
 *   3. 价值/代价统一打分的扩张与进攻：边际产出 × 剩余视野 + 剥夺敌方产出 + 特殊节点溢价 − 兵力代价 − 延迟代价；
 *      零延迟打击只需防同时增援，延迟打击按敌方可反应兵力加码。
 *   4. 斩首：敌老家可见时，按「敌老家守军 + 本回合可同时回援」精确计算必杀兵力，多源同刻合击。
 *   5. 锋线集结：后方富余兵力沿最短路流向离敌老家最近的锋点，为下一回合的零延迟打击蓄力。
 *
 * 纯函数：只读 view，不保存任何跨回合状态。
 */

import { NEUTRAL, type Bot, type NodeKind, type Observation, type Order } from '../engine/types.js';

const CAP = 100;

export interface ZiweiParams {
  homeK: number;
  homeMargin: number;
  keepFrac: number;
  keepCap: number;
  raceAhead: number;
  raceEqual: number;
  simReinf: number;
  reactFrac: number;
  holdFrac: number;
  horizon: number;
  costW: number;
  delayW: number;
  denyW: number;
  foundryBonus: number;
  towerBonus: number;
  killValue: number;
  killSim: number;
  homeThreatBonus: number;
  flowMin: number;
  unseenHomeBase: number;
  unseenHomeRate: number;
  unseenBase: number;
  unseenRate: number;
  extraDelay: number;
  rescueW: number;
  ffaThreatShare: number;
}

export const ZIWEI_DEFAULTS: ZiweiParams = {
  homeK: 3,
  homeMargin: 0,
  keepFrac: 0.5,
  keepCap: 14,
  raceAhead: 6,
  raceEqual: 4,
  simReinf: 0.25,
  reactFrac: 0.6,
  holdFrac: 0.3,
  horizon: 20,
  costW: 1.6,
  delayW: 10,
  denyW: 1.0,
  foundryBonus: 14,
  towerBonus: 10,
  killValue: 5000,
  killSim: 0.5,
  homeThreatBonus: 40,
  flowMin: 3,
  unseenHomeBase: 14,
  unseenHomeRate: 0.4,
  unseenBase: 5,
  unseenRate: 0.2,
  extraDelay: 1,
  rescueW: 1.2,
  ffaThreatShare: 1.0,
};

interface Arr {
  at: number;
  owner: number;
  troops: number;
}

interface St {
  owner: number;
  troops: number;
}

function resolve(defender: number, garrison: number, group: Arr[]): St {
  const sides = new Map<number, number>();
  sides.set(defender, garrison);
  for (const a of group) sides.set(a.owner, (sides.get(a.owner) ?? 0) + a.troops);
  let top = -1;
  let topOwner = defender;
  let second = 0;
  let ties = 0;
  for (const [o, t] of sides) {
    if (t > top) {
      second = top < 0 ? 0 : top;
      top = t;
      topOwner = o;
      ties = 1;
    } else if (t === top) {
      ties++;
      second = t;
    } else if (t > second) {
      second = t;
    }
  }
  if (ties > 1) return { owner: defender, troops: 0 };
  return { owner: topOwner, troops: Math.min(CAP, top - second) };
}

function bfsFree(adj: number[][], start: number): number[] {
  const dist = new Array<number>(adj.length).fill(Infinity);
  dist[start] = 0;
  const q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const u = q[qi];
    for (const v of adj[u]) {
      if (dist[v] === Infinity) {
        dist[v] = dist[u] + 1;
        q.push(v);
      }
    }
  }
  return dist;
}

/** 仅穿过 {pass, 中立} 节点的到达延迟（相邻 = 0），终点可为任意归属。 */
function openHops(adj: number[][], own: number[], start: number, pass: number): number[] {
  const n = adj.length;
  const dist = new Array<number>(n).fill(Infinity);
  dist[start] = 0;
  const q = [start];
  for (let qi = 0; qi < q.length; qi++) {
    const u = q[qi];
    for (const v of adj[u]) {
      if (dist[v] !== Infinity) continue;
      dist[v] = dist[u] + 1;
      if (own[v] === NEUTRAL || own[v] === pass) q.push(v);
    }
  }
  const hops = new Array<number>(n).fill(Infinity);
  for (let i = 0; i < n; i++) if (i !== start && Number.isFinite(dist[i])) hops[i] = dist[i] - 1;
  return hops;
}

function prodFor(kind: NodeKind, count: number): number {
  if (kind === 'home') return 4;
  if (kind === 'foundry') return 5;
  if (kind === 'watchtower') return 2;
  return 2 + Math.floor(count / 2);
}

function totalKind(kind: NodeKind, c: number): number {
  return c <= 0 ? 0 : c * prodFor(kind, c);
}

function plan(view: Observation, P: ZiweiParams): Order[] {
  const n = view.nodes.length;
  const me = view.you;
  const now = view.turn;
  const remain = Math.max(1, view.maxTurns - now + 1);
  const home = view.homeNode;
  const duel = view.mode === 'duel';
  const adj = view.adj;
  const own = view.nodes.map((x) => x.owner);
  const kinds = view.nodes.map((x) => x.kind);

  const mine: number[] = [];
  const enemyNodes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (own[i] === me) mine.push(i);
    else if (own[i] >= 0) enemyNodes.push(i);
  }
  if (mine.length === 0 || own[home] !== me) return [];
  const foes = view.players.filter((p) => p.alive && p.id !== me).map((p) => p.id);

  // ---- 计数与产出 ----
  const counts = new Map<number, Record<NodeKind, number>>();
  for (const p of view.players) {
    counts.set(p.id, { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 });
  }
  for (let i = 0; i < n; i++) if (own[i] >= 0) counts.get(own[i])![kinds[i]]++;
  const myCounts = counts.get(me)!;

  const prodAs = (i: number, o: number): number => {
    if (o < 0) return 0;
    if (own[i] === o) return view.nodes[i].production;
    return prodFor(kinds[i], (counts.get(o)?.[kinds[i]] ?? 0) + 1);
  };
  const gainFor = (o: number, k: NodeKind): number => {
    const c = counts.get(o)?.[k] ?? 0;
    return totalKind(k, c + 1) - totalKind(k, c);
  };
  const lossFor = (o: number, k: NodeKind): number => {
    const c = counts.get(o)?.[k] ?? 0;
    return c <= 0 ? 0 : totalKind(k, c) - totalKind(k, c - 1);
  };

  // ---- 兵力估计 ----
  const est = view.nodes.map((nd) => {
    if (nd.troops !== null) return nd.troops;
    if (nd.kind === 'home') return Math.min(CAP, Math.round(P.unseenHomeBase + P.unseenHomeRate * now));
    return Math.min(CAP, Math.round(P.unseenBase + P.unseenRate * now * (nd.production / 2.5)));
  });

  // ---- 距离 ----
  const free: number[][] = [];
  for (let i = 0; i < n; i++) free.push(bfsFree(adj, i));
  const myHop: number[][] = new Array(n);
  for (const s of mine) myHop[s] = openHops(adj, own, s, me);
  const eHop: number[][] = new Array(n);
  for (const e of enemyNodes) eHop[e] = openHops(adj, own, e, own[e]);
  const hop = (s: number, t: number): number => (myHop[s] ? myHop[s][t] : Infinity);

  // 敌方各节点到某目标的最小延迟（任一敌人）
  const enemyMinHop = new Array<number>(n).fill(Infinity);
  for (const e of enemyNodes) {
    for (let t = 0; t < n; t++) if (eHop[e][t] < enemyMinHop[t]) enemyMinHop[t] = eHop[e][t];
  }

  // ---- 在途纵队 ----
  const arrivals: Arr[][] = Array.from({ length: n }, () => []);
  for (const col of view.columns) {
    const at = col.arriveTurn - now;
    if (at < 0) continue;
    arrivals[col.path[col.path.length - 1]].push({ at, owner: col.owner, troops: col.troops });
  }
  const planned: Arr[][] = Array.from({ length: n }, () => []);

  const grow = (tr: number, o: number, t: number, turns: number): number =>
    o < 0 || turns <= 0 ? tr : Math.min(CAP, tr + prodAs(t, o) * turns);

  /** 推演节点 t 到偏移 h（含 h 时刻结算，不含 h 时刻产出）。 */
  const simulate = (t: number, h: number, extra: Arr[] = []): St => {
    let o = own[t];
    let tr = est[t];
    const list: Arr[] = [];
    for (const a of arrivals[t]) if (a.at <= h) list.push(a);
    for (const a of planned[t]) if (a.at <= h) list.push(a);
    for (const a of extra) if (a.at <= h) list.push(a);
    list.sort((a, b) => a.at - b.at);
    let cur = 0;
    let i = 0;
    while (i < list.length) {
      const at = list[i].at;
      tr = grow(tr, o, t, at - cur);
      cur = at;
      const group: Arr[] = [];
      while (i < list.length && list[i].at === at) group.push(list[i++]);
      const r = resolve(o, tr, group);
      o = r.owner;
      tr = r.troops;
    }
    tr = grow(tr, o, t, h - cur);
    return { owner: o, troops: tr };
  };

  const lastArrival = (t: number): number => {
    let m = 0;
    for (const a of arrivals[t]) if (a.at > m) m = a.at;
    for (const a of planned[t]) if (a.at > m) m = a.at;
    return m;
  };

  /** 在偏移 d 抵达并且一直守到已知最后一支纵队结算后所需的最少兵力。 */
  const needAt = (t: number, d: number, margin: number): number => {
    const hz = Math.max(d, Math.min(d + 4, lastArrival(t)));
    const ok = (x: number): boolean => {
      const extra = [{ at: d, owner: me, troops: x }];
      if (simulate(t, d, extra).owner !== me) return false;
      if (hz > d && simulate(t, hz, extra).owner !== me) return false;
      return true;
    };
    if (!ok(400)) return Infinity;
    let lo = 1;
    let hi = 400;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ok(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo + margin;
  };

  // ---- 指令缓冲 ----
  const orders: Order[] = [];
  const used = new Array<number>(n).fill(0);
  const evac = new Array<boolean>(n).fill(false);
  const troopsOf = (s: number): number => (own[s] === me ? (view.nodes[s].troops ?? 0) - used[s] : 0);

  // ---- 老家安全 ----
  const K = P.homeK;
  // 每个敌方势力到老家的「穿透延迟」：途经我方/他方节点需额外 1 回合（先攻占再出发）
  const thr = new Array<number>(K + 1).fill(0);
  {
    const perFoe: number[][] = [];
    for (const o of foes) {
      const D = new Array<number>(n).fill(Infinity);
      D[home] = 0;
      const done = new Array<boolean>(n).fill(false);
      for (;;) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!done[i] && D[i] < Infinity && (u < 0 || D[i] < D[u])) u = i;
        if (u < 0) break;
        done[u] = true;
        const pen = u === home ? 0 : own[u] === NEUTRAL || own[u] === o ? 0 : 1;
        for (const v of adj[u]) {
          const c = D[u] + 1 + pen;
          if (c < D[v]) D[v] = c;
        }
      }
      const t = new Array<number>(K + 1).fill(0);
      for (let k = 0; k <= K; k++) {
        let s = 0;
        for (const e of enemyNodes) {
          if (own[e] !== o) continue;
          const off = D[e] - 1;
          if (off <= k) s += Math.min(CAP, est[e] + view.nodes[e].production * (k - off));
        }
        for (let tgt = 0; tgt < n; tgt++) {
          for (const a of arrivals[tgt]) {
            if (a.owner !== o) continue;
            if (tgt === home) {
              if (a.at <= k) s += a.troops;
            } else if (own[tgt] !== o && a.at + D[tgt] <= k) {
              s += a.troops;
            }
          }
        }
        t[k] = s;
      }
      perFoe.push(t);
    }
    for (let k = 0; k <= K; k++) {
      let mx = 0;
      let sum = 0;
      for (const t of perFoe) {
        mx = Math.max(mx, t[k]);
        sum += t[k];
      }
      thr[k] = duel ? mx : Math.max(mx, Math.round(sum * P.ffaThreatShare * 0.5));
    }
  }

  const friendlyAt = (t: number, k: number): number => {
    let s = 0;
    for (const a of arrivals[t]) if (a.owner === me && a.at <= k) s += a.troops;
    for (const a of planned[t]) if (a.at <= k) s += a.troops;
    return s;
  };

  // 计划中的占领（伪节点）也能回援
  const pseudo: Array<{ t: number; at: number; left: number }> = [];

  const slack = (): number[] => {
    const out = new Array<number>(K + 1);
    for (let k = 0; k <= K; k++) {
      let d = troopsOf(home) + 4 * k + friendlyAt(home, k);
      if (k >= 1) {
        for (const s of mine) {
          if (s === home) continue;
          const h = hop(s, home);
          if (h <= k - 1) d += Math.max(0, troopsOf(s)) + view.nodes[s].production * (k - 1 - h);
        }
        for (const p of pseudo) {
          const h = free[p.t][home] - 1;
          if (p.at + 1 + h <= k) d += p.left;
        }
      }
      out[k] = d - thr[k] - (k === 0 ? P.homeMargin : 0);
    }
    return out;
  };

  const homeMaxSend = (s: number, relaxed = false): number => {
    const sl = slack();
    let m = Infinity;
    const h0 = s === home ? -1 : hop(s, home);
    for (let k = 0; k <= (relaxed ? 0 : K); k++) {
      if (s === home || h0 <= k - 1) m = Math.min(m, sl[k]);
    }
    return Math.max(0, m);
  };

  // ---- 非老家留守 ----
  const adjEnemyMax = (s: number, exclude = -1): number => {
    let m = 0;
    for (const e of enemyNodes) {
      if (e === exclude) continue;
      if (eHop[e][s] === 0) m = Math.max(m, est[e]);
    }
    return m;
  };
  const keepOf = (s: number, exclude = -1): number => {
    if (s === home || evac[s]) return 0;
    const m = adjEnemyMax(s, exclude);
    if (m <= 0) return 0;
    return Math.min(P.keepCap, Math.ceil(m * P.keepFrac));
  };

  const capOf = (s: number, opts: { exclude?: number; relaxed?: boolean } = {}): number => {
    if (own[s] !== me) return 0;
    const raw = troopsOf(s) - keepOf(s, opts.exclude ?? -1);
    if (raw <= 0) return 0;
    return Math.max(0, Math.min(raw, Math.floor(homeMaxSend(s, opts.relaxed))));
  };

  const send = (from: number, to: number, troops: number, at: number): number => {
    if (orders.length >= view.maxOrders) return 0;
    if (from === to || own[from] !== me) return 0;
    if (!Number.isFinite(hop(from, to))) return 0;
    if (orders.some((o) => o.from === from && o.to === to)) return 0;
    const amt = Math.min(Math.floor(troops), troopsOf(from));
    if (amt < 1) return 0;
    orders.push({ from, to, troops: amt });
    used[from] += amt;
    planned[to].push({ at, owner: me, troops: amt });
    return amt;
  };

  // ======================================================================
  // 阶段 1：老家补防（可反应约束被打破时立即回援）
  // ======================================================================
  {
    const sl = slack();
    for (let k = 0; k <= K && orders.length < view.maxOrders; k++) {
      let deficit = -slack()[k];
      if (deficit <= 0) continue;
      // 只有恰好 k 延迟的节点必须现在出发；更近的节点会在下一回合被计入
      const donors = mine
        .filter((s) => s !== home && hop(s, home) === k && troopsOf(s) > 0)
        .sort((a, b) => troopsOf(b) - troopsOf(a));
      for (const s of donors) {
        if (deficit <= 0 || orders.length >= view.maxOrders) break;
        const g = send(s, home, Math.min(deficit, troopsOf(s)), k);
        deficit -= g;
      }
    }
    void sl;
  }

  // ======================================================================
  // 阶段 2：受袭节点救援 / 撤离
  // ======================================================================
  for (const s of mine) {
    if (s === home || orders.length >= view.maxOrders) continue;
    const enemyIn = arrivals[s].some((a) => a.owner !== me);
    if (!enemyIn) continue;
    // 找到第一次失守的时刻
    const last = lastArrival(s);
    let lostAt = -1;
    for (let a = 0; a <= last; a++) {
      if (simulate(s, a).owner !== me) {
        lostAt = a;
        break;
      }
    }
    if (lostAt < 0) continue;
    const worth = (view.nodes[s].production * Math.min(remain, P.horizon)) / 3 + (kinds[s] === 'foundry' ? 10 : 0);
    let deficit = needAt(s, lostAt, 0);
    const donors = mine
      .filter((d) => d !== s && !evac[d] && hop(d, s) <= lostAt)
      .sort((a, b) => hop(a, s) - hop(b, s) || capOf(b) - capOf(a));
    const pool = donors.reduce((x, d) => x + capOf(d), 0);
    if (Number.isFinite(deficit) && deficit <= pool && deficit * P.rescueW <= worth) {
      for (const d of donors) {
        if (deficit <= 0 || orders.length >= view.maxOrders) break;
        const g = send(d, s, Math.min(deficit, capOf(d)), hop(d, s));
        deficit -= g;
      }
    } else if (lostAt === 0) {
      evac[s] = true;
    }
  }

  // ======================================================================
  // 阶段 3：扩张 / 进攻 / 斩首 统一打分
  // ======================================================================
  interface Cand {
    t: number;
    d: number;
    need: number;
    score: number;
    kill: boolean;
  }
  const cands: Cand[] = [];
  const myNodeCount = mine.length;
  let maxFoeNodes = 0;
  for (const o of foes) maxFoeNodes = Math.max(maxFoeNodes, view.players[o]?.nodes ?? 0);

  for (let t = 0; t < n; t++) {
    if (own[t] === me) continue;
    const isEnemy = own[t] >= 0;
    if (isEnemy && view.nodes[t].troops === null) continue;
    let dmin = Infinity;
    for (const s of mine) {
      if (troopsOf(s) < 1) continue;
      const h = hop(s, t);
      if (h < dmin) dmin = h;
    }
    if (!Number.isFinite(dmin) || dmin >= remain) continue;
    const dmax = Math.min(remain - 1, dmin + (isEnemy ? 0 : P.extraDelay));
    for (let d = dmin; d <= dmax; d++) {
      const pre = simulate(t, d);
      if (pre.owner === me) break;
      const tgtOwner = pre.owner;
      const enemyTgt = tgtOwner >= 0;
      if (enemyTgt && !isEnemy && view.nodes[t].troops === null) continue;
      const kill = enemyTgt && kinds[t] === 'home';

      let margin = 0;
      if (enemyTgt) {
        let reinf = 0;
        for (const e of enemyNodes) {
          if (e === t || own[e] !== tgtOwner) continue;
          const h = eHop[e][t];
          if (d === 0 ? h === 0 : h <= d - 1) reinf += est[e];
        }
        if (kill) margin = Math.ceil(reinf * (d === 0 ? P.killSim : 1.0));
        else margin = Math.ceil(reinf * (d === 0 ? P.simReinf : P.reactFrac));
      } else {
        const eh = enemyMinHop[t];
        if (eh <= d) {
          let near = 0;
          for (const e of enemyNodes) if (eHop[e][t] <= d) near = Math.max(near, est[e]);
          margin = Math.min(near, eh < d ? P.raceAhead : P.raceEqual);
        }
      }
      // 占领后能否守住（敌方相邻兵力）
      const hold = Math.min(P.keepCap, Math.ceil(adjEnemyMax(t, t) * P.holdFrac));
      const need = needAt(t, d, margin + (kill ? 0 : hold));
      if (!Number.isFinite(need)) continue;

      const H = Math.max(0, Math.min(remain - d, P.horizon));
      let value = gainFor(me, kinds[t]) * H;
      if (enemyTgt) value += lossFor(tgtOwner, kinds[t]) * H * P.denyW;
      if (kinds[t] === 'foundry') value += P.foundryBonus;
      if (kinds[t] === 'watchtower') value += myCounts.watchtower === 0 ? P.towerBonus * 2 : P.towerBonus;
      if (kill) value += duel ? P.killValue : P.killValue * 0.5;
      if (enemyTgt && free[t][home] <= 2) value += P.homeThreatBonus / free[t][home];
      if (remain <= 12) value += 30 + (myNodeCount <= maxFoeNodes + 1 ? 40 : 0);
      const score = value - P.costW * need - P.delayW * d;
      if (score > 0) cands.push({ t, d, need, score, kill });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.d - b.d || a.t - b.t);

  const taken = new Set<number>();
  const staged: number[] = [];
  for (const c of cands) {
    if (orders.length >= view.maxOrders) break;
    if (taken.has(c.t)) continue;
    // 重新计算需求（之前的指令可能改变了局面）
    const enemyAdjTarget = own[c.t] >= 0 && c.d === 0;
    const capFor = (s: number): number =>
      capOf(s, { exclude: enemyAdjTarget ? c.t : -1, relaxed: c.kill && duel });
    const pool = mine
      .filter((s) => hop(s, c.t) === c.d && capFor(s) >= 1)
      .sort((a, b) => (evac[b] ? 1 : 0) - (evac[a] ? 1 : 0) || capFor(b) - capFor(a));
    if (pool.length === 0) continue;
    const total = pool.slice(0, view.maxOrders - orders.length).reduce((x, s) => x + capFor(s), 0);
    if (total < c.need) {
      staged.push(c.t);
      continue;
    }
    let rem = c.need;
    const single = pool.find((s) => capFor(s) >= rem);
    if (single !== undefined) {
      send(single, c.t, rem, c.d);
      taken.add(c.t);
      if (c.kill && duel) return orders;
      continue;
    }
    for (const s of pool) {
      if (rem <= 0 || orders.length >= view.maxOrders) break;
      rem -= send(s, c.t, Math.min(rem, capFor(s)), c.d);
    }
    taken.add(c.t);
    if (c.kill && duel && rem <= 0) return orders;
  }

  // ======================================================================
  // 阶段 4：撤离残兵 + 锋线集结
  // ======================================================================
  const enemyHomes = enemyNodes.filter((e) => kinds[e] === 'home');
  const focus = enemyHomes.length > 0 ? enemyHomes : enemyNodes;
  const focusDist = (id: number): number => {
    let m = Infinity;
    for (const f of focus) m = Math.min(m, free[id][f]);
    if (!Number.isFinite(m)) {
      // 没有敌人可见：朝中立目标
      for (let t = 0; t < n; t++) if (own[t] === NEUTRAL) m = Math.min(m, free[id][t]);
    }
    return Number.isFinite(m) ? m : 0;
  };
  const stagedBonus = (id: number): number => {
    let b = 0;
    for (const t of staged.slice(0, 3)) {
      const h = hop(id, t);
      if (h === 0) b += 1.5;
    }
    return b;
  };
  const anchorScore = (id: number): number => -focusDist(id) + stagedBonus(id);

  for (const s of mine) {
    if (!evac[s] || orders.length >= view.maxOrders) continue;
    const amt = troopsOf(s);
    if (amt < 1) continue;
    let best = -1;
    let bestScore = -Infinity;
    for (const f of mine) {
      if (f === s || evac[f] || !Number.isFinite(hop(s, f))) continue;
      const sc = -hop(s, f) * 2 + anchorScore(f);
      if (sc > bestScore) {
        bestScore = sc;
        best = f;
      }
    }
    if (best >= 0) send(s, best, amt, hop(s, best));
  }

  const incoming = new Array<number>(n).fill(0);
  for (let t = 0; t < n; t++) incoming[t] = friendlyAt(t, 3);
  const shippers = mine
    .filter((s) => !evac[s])
    .map((s) => ({ s, cap: capOf(s) }))
    .filter((x) => x.cap >= P.flowMin)
    .sort((a, b) => b.cap - a.cap);
  for (const { s } of shippers) {
    if (orders.length >= view.maxOrders) break;
    const cap = capOf(s);
    if (cap < P.flowMin) continue;
    const here = anchorScore(s);
    let best = -1;
    let bestScore = -Infinity;
    for (const f of mine) {
      if (f === s) continue;
      const h = hop(s, f);
      if (!Number.isFinite(h)) continue;
      const load = troopsOf(f) + incoming[f];
      if (load >= 90) continue;
      const gainPos = anchorScore(f) - here;
      if (gainPos <= 0) continue;
      const sc = gainPos * 3 - h * 1.2 - load * 0.02;
      if (sc > bestScore) {
        bestScore = sc;
        best = f;
      }
    }
    if (best < 0) continue;
    const room = Math.max(0, 95 - troopsOf(best) - incoming[best]);
    const amt = Math.min(cap, room);
    if (amt >= P.flowMin) {
      const g = send(s, best, amt, hop(s, best));
      incoming[best] += g;
    }
  }

  return orders;
}

export function createZiweiWith(params: Partial<ZiweiParams> = {}): Bot {
  const P = { ...ZIWEI_DEFAULTS, ...params };
  return {
    name: '紫微',
    style: '可反应安全 · 精确斩首',
    decide(view: Observation): Order[] {
      try {
        return plan(view, P);
      } catch {
        return [];
      }
    },
  };
}

export function createZiwei(): Bot {
  return createZiweiWith();
}