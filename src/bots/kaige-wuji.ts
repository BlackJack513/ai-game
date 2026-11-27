/**
 * 凯哥无极 —— 全盘推演 · 收益排序 · 同步合击
 *
 * 只依赖 Observation，从规则出发独立设计：
 * 1. 内部确定性推演器：按规则复制一份「我方视角」的局面，模拟一条指令执行后的结算与产出。
 * 2. 收益排序：对每个候选指令（单源 / 多源合击 / 接力 / 回防）做一回合推演，按局面价值增量排序。
 * 3. 同步合击：与目标相邻的多个己方节点按需合并兵力，一回合内打穿守军。
 * 4. 动态留守：老家按最近敌情留兵，前线节点按相邻敌军规模留兵，其余全部投入扩张或接力。
 */
import { NEUTRAL, type Bot, type NodeKind, type Observation, type Order } from '../engine/types.js';

interface Arrival {
  owner: number;
  troops: number;
}

interface Candidate {
  plan: Order[];
  target: number;
  bonus: number;
  far: boolean;
  relay: boolean;
}

interface ScoredPlan {
  plan: Order[];
  target: number;
  delta: number;
}

export function createZhanluOmega(): Bot {
  const seen = new Map<number, { turn: number; troops: number }>();
  return {
    name: '凯哥无极',
    style: '全盘推演 · 收益排序 · 同步合击',
    decide(view: Observation): Order[] {
      const nodes = view.nodes;
      const n = nodes.length;
      const me = view.you;
      const home = view.homeNode;
      const turn = view.turn;
      const maxOrders = view.maxOrders;
      const adj = view.adj;
      const kinds = nodes.map((node) => node.kind);

      // ---------------------------------------------------------------- 记忆
      for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (node.owner !== me && node.owner !== NEUTRAL && node.troops !== null) {
          const prev = seen.get(i);
          if (!prev || prev.turn < turn) seen.set(i, { turn, troops: node.troops });
        }
      }

      const estTroops = (id: number): number => {
        const node = nodes[id];
        if (node.troops !== null) return node.troops;
        const rec = seen.get(id);
        if (!rec) return Math.min(100, 10 + 3 * Math.min(turn, 12));
        const dt = Math.max(0, turn - rec.turn);
        return Math.min(100, rec.troops + node.production * dt + 2);
      };

      const isMine = (id: number) => nodes[id].owner === me;
      const isNeutral = (id: number) => nodes[id].owner === NEUTRAL;
      const isEnemy = (id: number) => nodes[id].owner !== me && nodes[id].owner !== NEUTRAL;

      const prodOf = (kind: NodeKind, count: number): number => {
        if (kind === 'home') return 4;
        if (kind === 'foundry') return 5;
        if (kind === 'watchtower') return 2;
        return 2 + Math.floor(count / 2);
      };

      // ------------------------------------------------------------ 行军距离
      const ownIds: number[] = [];
      const dists = new Map<number, Int32Array>();
      for (let s = 0; s < n; s++) {
        if (!isMine(s)) continue;
        ownIds.push(s);
        const dist = new Int32Array(n).fill(-1);
        dist[s] = 0;
        const queue = [s];
        for (let qi = 0; qi < queue.length; qi++) {
          const u = queue[qi];
          for (const v of adj[u]) {
            if (dist[v] !== -1) continue;
            dist[v] = dist[u] + 1;
            if (isNeutral(v) || isMine(v)) queue.push(v);
          }
        }
        dists.set(s, dist);
      }

      /** 无视归属的图上最短路。 */
      const graphDist = (source: number): Int32Array => {
        const dist = new Int32Array(n).fill(1_000_000);
        dist[source] = 0;
        const queue = [source];
        for (let qi = 0; qi < queue.length; qi++) {
          const u = queue[qi];
          for (const v of adj[u]) {
            if (dist[v] > dist[u] + 1) {
              dist[v] = dist[u] + 1;
              queue.push(v);
            }
          }
        }
        return dist;
      };

      // ------------------------------------------------------------ 敌方情报
      const enemyHomes: number[] = [];
      for (let i = 0; i < n; i++) if (kinds[i] === 'home' && isEnemy(i)) enemyHomes.push(i);

      const toEnemyHome = new Int32Array(n).fill(1_000_000);
      {
        const queue: number[] = [];
        for (const h of enemyHomes) {
          if (toEnemyHome[h] === 0) continue;
          toEnemyHome[h] = 0;
          queue.push(h);
        }
        for (let qi = 0; qi < queue.length; qi++) {
          const u = queue[qi];
          for (const v of adj[u]) {
            if (toEnemyHome[v] > toEnemyHome[u] + 1) {
              toEnemyHome[v] = toEnemyHome[u] + 1;
              queue.push(v);
            }
          }
        }
      }

      const homeDist = graphDist(home);
      let nearestEnemy = 1_000_000;
      for (let i = 0; i < n; i++) {
        if (!isEnemy(i)) continue;
        if (homeDist[i] < nearestEnemy) nearestEnemy = homeDist[i];
      }

      const adjMax = new Int32Array(n);
      const adjSum = new Int32Array(n);
      for (const t of ownIds) {
        for (const nb of adj[t]) {
          if (!isEnemy(nb)) continue;
          const value = estTroops(nb);
          if (value > adjMax[t]) adjMax[t] = value;
          adjSum[t] += value;
        }
      }

      let incomingHome = 0;
      const incomingByNode = new Int32Array(n);
      for (const column of view.columns) {
        if (column.owner === me) continue;
        const target = column.path[column.path.length - 1];
        incomingByNode[target] += column.troops;
        if (target === home) incomingHome += column.troops;
      }

      const avail = new Int32Array(n);
      for (const id of ownIds) avail[id] = nodes[id].troops ?? 0;
      const left = Int32Array.from(avail);

      const homeKeep = (): number => {
        if (nearestEnemy <= 1) return adjMax[home] + adjSum[home] * 0.5 + incomingHome + 8;
        if (nearestEnemy === 2) return 4;
        return 0;
      };
      const keepFor = (s: number): number => {
        if (s === home) return homeKeep();
        if (adjMax[s] > 0) return Math.min(100, Math.round(adjMax[s] + adjSum[s] * 0.2));
        return 0;
      };
      const usable = (s: number): number => Math.max(0, left[s] - keepFor(s));

      // ------------------------------------------------------------ 局面基准
      const owner0 = Int8Array.from(nodes.map((node) => node.owner));
      const troops0 = Int16Array.from(
        nodes.map((node) => (node.troops === null ? estTroops(node.id) : node.troops)),
      );
      const baseColumns = view.columns.map((column) => ({
        owner: column.owner,
        troops: column.troops,
        path: column.path.slice(),
        arriveTurn: column.arriveTurn,
      }));

      const pathCache = new Map<string, number[] | null>();
      const pathOf = (from: number, to: number): number[] | null => {
        const key = `${from}>${to}`;
        if (pathCache.has(key)) return pathCache.get(key) ?? null;
        const prev = new Int32Array(n).fill(-2);
        prev[from] = -1;
        const queue = [from];
        let found: number[] | null = null;
        for (let qi = 0; qi < queue.length && !found; qi++) {
          const u = queue[qi];
          for (const v of adj[u]) {
            if (prev[v] !== -2) continue;
            if (v !== to) {
              const own = owner0[v];
              if (own !== NEUTRAL && own !== me) continue;
            }
            prev[v] = u;
            if (v === to) {
              const path = [to];
              let cur = to;
              while (cur !== from) {
                cur = prev[cur];
                path.push(cur);
              }
              path.reverse();
              found = path;
              break;
            }
            queue.push(v);
          }
        }
        pathCache.set(key, found);
        return found;
      };

      const resolve = (owner: Int8Array, troops: Int16Array, target: number, arrivals: Arrival[]): void => {
        const defender = owner[target];
        const sides = new Map<number, number>();
        sides.set(defender, troops[target]);
        for (const arrival of arrivals) {
          sides.set(arrival.owner, (sides.get(arrival.owner) ?? 0) + arrival.troops);
        }
        const entries = [...sides.entries()].sort((a, b) => b[1] - a[1]);
        const best = entries[0][1];
        if (entries.filter((entry) => entry[1] === best).length > 1) {
          owner[target] = defender;
          troops[target] = 0;
          return;
        }
        const second = entries.length > 1 ? entries[1][1] : 0;
        owner[target] = entries[0][0];
        troops[target] = Math.min(100, Math.max(0, best - second));
      };

      const simulate = (plan: Order[]) => {
        const owner = Int8Array.from(owner0);
        const troops = Int16Array.from(troops0);
        const columns = baseColumns.map((column) => ({
          owner: column.owner,
          troops: column.troops,
          path: column.path,
          arriveTurn: column.arriveTurn,
        }));
        for (const order of plan) {
          if (owner[order.from] !== me) continue;
          if (troops[order.from] < order.troops) continue;
          const path = pathOf(order.from, order.to);
          if (!path) continue;
          troops[order.from] -= order.troops;
          columns.push({
            owner: me,
            troops: order.troops,
            path,
            arriveTurn: turn + path.length - 2,
          });
        }
        const byTarget = new Map<number, Arrival[]>();
        const rest: typeof columns = [];
        for (const column of columns) {
          if (column.arriveTurn > turn) {
            rest.push(column);
            continue;
          }
          const target = column.path[column.path.length - 1];
          const list = byTarget.get(target) ?? [];
          list.push({ owner: column.owner, troops: column.troops });
          byTarget.set(target, list);
        }
        for (const [target, arrivals] of byTarget) resolve(owner, troops, target, arrivals);

        const counts = new Map<number, Map<NodeKind, number>>();
        for (let i = 0; i < n; i++) {
          const own = owner[i];
          if (own === NEUTRAL) continue;
          let map = counts.get(own);
          if (!map) {
            map = new Map<NodeKind, number>();
            counts.set(own, map);
          }
          map.set(kinds[i], (map.get(kinds[i]) ?? 0) + 1);
        }
        for (let i = 0; i < n; i++) {
          const own = owner[i];
          if (own === NEUTRAL) continue;
          const count = counts.get(own)?.get(kinds[i]) ?? 0;
          troops[i] = Math.min(100, troops[i] + prodOf(kinds[i], count));
        }
        return { owner, troops, columns: rest };
      };

      // ------------------------------------------------------------ 位置价值
      // 节点的战略价值 = 邻接目标的开发价值 + 离敌方老家的接近度。
      const positionBonus = new Float64Array(n);
      {
        let maxPotential = 1;
        for (const id of ownIds) {
          let sum = 0;
          for (const t of adj[id]) {
            if (owner0[t] === me) continue;
            sum += 600 + nodes[t].production * 60;
          }
          const d = toEnemyHome[id];
          const reach = d < 1_000_000 ? Math.max(0, 8 - d) * 90 : 0;
          positionBonus[id] = sum + reach;
          if (positionBonus[id] > maxPotential) maxPotential = positionBonus[id];
        }
        for (const id of ownIds) positionBonus[id] /= maxPotential;
      }

      const evaluate = (state: { owner: Int8Array; troops: Int16Array }): number => {
        const { owner, troops } = state;
        let value = 0;
        const counts = new Map<number, Map<NodeKind, number>>();
        for (let i = 0; i < n; i++) {
          const own = owner[i];
          if (own === NEUTRAL) continue;
          let map = counts.get(own);
          if (!map) {
            map = new Map<NodeKind, number>();
            counts.set(own, map);
          }
          map.set(kinds[i], (map.get(kinds[i]) ?? 0) + 1);
        }
        for (let i = 0; i < n; i++) {
          const own = owner[i];
          if (own === me) {
            const count = counts.get(me)?.get(kinds[i]) ?? 0;
            value += 700 + prodOf(kinds[i], count) * 150 + troops[i] * 1.6;
            value += troops[i] * positionBonus[i] * 0.9;
          } else if (own !== NEUTRAL) {
            value -= 260 + nodes[i].production * 70 + troops[i] * 0.25;
          } else {
            value -= troops[i] * 0.5;
          }
        }
        if (owner[home] !== me) value -= 10_000_000;
        for (const id of ownIds) {
          if (owner[id] !== me) continue;
          const threat = adjMax[id] + adjSum[id] * 0.3 + incomingByNode[id];
          if (troops[id] >= threat) continue;
          const weight = id === home ? 160 : 90;
          value -= (threat - troops[id]) * weight;
        }
        return value;
      };

      const candidates: Candidate[] = [];
      const addCandidate = (plan: Order[], target: number, bonus = 0, far = false, relay = false): void => {
        candidates.push({ plan, target, bonus, far, relay });
      };

      for (let t = 0; t < n; t++) {
        if (owner0[t] === me) continue;
        const neutral = owner0[t] === NEUTRAL;
        const need = neutral ? troops0[t] + 1 : estTroops(t) + 1;
        if (need > 100) continue;
        const near: Array<{ s: number; d: number; spare: number }> = [];
        const far: Array<{ s: number; d: number; spare: number }> = [];
        for (const s of ownIds) {
          const d = dists.get(s)?.[t] ?? -1;
          if (d !== 1 && d !== 2 && d !== 3) continue;
          const spare = usable(s);
          if (spare < 1) continue;
          if (d === 1) near.push({ s, d, spare });
          else far.push({ s, d, spare });
        }
        if (near.length === 0 && far.length === 0) continue;

        for (const src of near) {
          if (src.spare < need) continue;
          addCandidate([{ from: src.s, to: t, troops: need }], t);
        }

        if (near.length >= 2) {
          const group = near.slice().sort((a, b) => a.spare - b.spare);
          let pool = 0;
          const combo: Order[] = [];
          for (const src of group) {
            const take = Math.min(src.spare, need - pool);
            if (take < 1) continue;
            combo.push({ from: src.s, to: t, troops: take });
            pool += take;
            if (pool >= need) break;
          }
          if (combo.length >= 2 && pool >= need) addCandidate(combo, t);
        }

        if (neutral && need >= 2) {
          const guard = need - 1;
          const totalSpare = near.reduce((sum, src) => sum + src.spare, 0);
          if (totalSpare === guard) {
            let pool = 0;
            const combo: Order[] = [];
            for (const src of near.slice().sort((a, b) => b.spare - a.spare)) {
              const take = Math.min(src.spare, guard - pool);
              if (take < 1) continue;
              combo.push({ from: src.s, to: t, troops: take });
              pool += take;
              if (pool >= guard) break;
            }
            if (pool >= guard) addCandidate(combo, t, 320);
          }
        }

        for (const src of far) {
          if (src.spare >= need) {
            addCandidate([{ from: src.s, to: t, troops: need }], t, 0, true);
          } else if (neutral && need >= 2 && src.spare === need - 1) {
            addCandidate([{ from: src.s, to: t, troops: need - 1 }], t, 300, true);
          }
        }

        if (far.length >= 2) {
          const group = far.slice().sort((a, b) => a.spare - b.spare);
          let pool = 0;
          const combo: Order[] = [];
          for (const src of group) {
            const take = Math.min(src.spare, need - pool);
            if (take < 1) continue;
            combo.push({ from: src.s, to: t, troops: take });
            pool += take;
            if (pool >= need) break;
          }
          if (combo.length >= 2 && pool >= need) addCandidate(combo, t, 0, true);
        }
      }

      for (const s of ownIds) {
        const spare = usable(s);
        if (spare < 2) continue;
        let best = -1;
        let bestBonus = positionBonus[s];
        for (const nb of adj[s]) {
          if (owner0[nb] !== me) continue;
          if (positionBonus[nb] > bestBonus) {
            bestBonus = positionBonus[nb];
            best = nb;
          }
        }
        if (best >= 0) addCandidate([{ from: s, to: best, troops: spare }], best, 0, false, true);
      }

      // 受威胁的己方节点（含老家）回防
      for (const t of ownIds) {
        const threat = adjMax[t] + adjSum[t] * 0.3 + incomingByNode[t];
        if (threat <= avail[t]) continue;
        const deficit = Math.min(36, threat - avail[t] + 4);
        for (const s of adj[t]) {
          if (owner0[s] !== me || s === t) continue;
          const take = Math.min(usable(s), deficit);
          if (take < 1) continue;
          addCandidate([{ from: s, to: t, troops: take }], t);
        }
      }

      // ------------------------------------------------------------ 选最优组合
      const baseline = evaluate(simulate([]));
      const nearScored: ScoredPlan[] = [];
      const farScored: ScoredPlan[] = [];
      for (const candidate of candidates) {
        let delta: number;
        if (candidate.far) {
          const target = candidate.target;
          const gain = owner0[target] === NEUTRAL ? 1150 : 1400;
          const cost = candidate.plan.reduce((sum, order) => sum + order.troops, 0);
          delta = gain - cost * 1.25 + candidate.bonus;
        } else {
          delta = evaluate(simulate(candidate.plan)) - baseline + candidate.bonus;
        }
        if (delta <= 0) continue;
        const item = { plan: candidate.plan, target: candidate.target, delta };
        if (candidate.far) farScored.push(item);
        else nearScored.push(item);
      }
      nearScored.sort((a, b) => b.delta - a.delta);
      farScored.sort((a, b) => b.delta - a.delta);
      const scored = [...nearScored, ...farScored];

      const chosen: Order[][] = [];
      const used = new Map<number, number>();
      const usedTargets = new Set<number>();
      let orderCount = 0;
      for (const item of scored) {
        if (orderCount >= maxOrders) break;
        if (usedTargets.has(item.target)) continue;
        if (orderCount + item.plan.length > maxOrders) continue;
        const local = new Map<number, number>();
        let ok = true;
        for (const order of item.plan) {
          const already = (used.get(order.from) ?? 0) + (local.get(order.from) ?? 0);
          if (already + order.troops > left[order.from]) {
            ok = false;
            break;
          }
          if (order.from === order.to) {
            ok = false;
            break;
          }
          local.set(order.from, (local.get(order.from) ?? 0) + order.troops);
        }
        if (!ok) continue;
        chosen.push(item.plan);
        orderCount += item.plan.length;
        for (const [from, value] of local) used.set(from, (used.get(from) ?? 0) + value);
        usedTargets.add(item.target);
      }

      const orders: Order[] = [];
      const dedupe = new Set<string>();
      for (const plan of chosen) {
        for (const order of plan) {
          const key = `${order.from}>${order.to}`;
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          orders.push(order);
          if (orders.length >= maxOrders) break;
        }
        if (orders.length >= maxOrders) break;
      }
      return orders;
    },
  };
}
