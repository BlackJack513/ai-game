/**
 * 鲸吞 —— 四人混战专精 · 极致产能 · 全兵上岗 · 以战养战
 *
 * 每回合按顺序跑七段，越靠前越优先花指令：
 *  0. 记牌：我方/敌方节点、每个我方节点出发的最短路、双方的「在途纵队」；
 *  1. 驻守下限：非老家留 1 兵（贴敌留 3），老家按 2 跳内敌军厚度留；
 *  2. 危墙不扶：离老家 3 跳以外、被几倍兵力压着的一侧，干脆不守，
 *     兵抽出来去别的方向抢地（离老家近的是承重墙，照常重点防守）；
 *  3. 防守锁兵：来袭纵队的终点必在我的视野里，按到达回合算清「要多少兵才守得住」，
 *     先补兵、再把补上的兵锁进 floor，保证进攻端抽不走；
 *  4. 进攻：同一到达回合的多源合击，按「价值 / (投入 + 行军代价)」排序贪心吃，
 *     凑不齐就整波放弃，绝不派半波兵去撞墙；
 *  5. 推兵：剩下的兵沿「到最近敌军的跳数」一路往小的地方流动，绝不囤在后方；
 *  6. 削峰（压轴）：实在没指令可花了，用对峙线上的余兵把对面门口的堆打薄，
 *     他没视野，只会看到自己变薄、我们还是那么厚。
 *
 * 价值 = 拿下来新增的每回合产出（含同类协同给老节点的加成）+ 削掉对面的产出，
 * 打敌方老家再加 6（斩首后对方领地立刻中立化，白捡一片）。
 *
 * 只依赖 Observation，不记任何跨回合私有状态。
 */

import type { Bot, NodeKind, Observation, Order } from '../engine/types.js';

/** 每回合指令上限（引擎规则）。 */
const MAX_ORDERS = 5;
/** 单节点兵力上限（引擎规则）。 */
const TROOP_CAP = 100;

/** 非老家节点的驻守：普通节点 1 兵，贴敌节点 3 兵（让对面偷一个点至少要付 4 兵）。 */
const REAR_KEEP = 1;
const FRONT_KEEP = 3;
/** 老家最低驻守。 */
const HOME_MIN = 2;
/** 老家 2 跳内出现超过这个数的敌军，才值得提前囤兵。 */
const HOME_ALERT = 14;
/** 非老家节点单波防守的投入上限：敌方愿意拿这么多兵换一个点，让他换，我们发育。 */
const DEFEND_MAX = 8;
/** 贴脸敌军是我方能守住的兵力的这么多倍时，这一侧就当守不住处理：不补兵，兵撤去别处。 */
const HOPELESS_RATIO = 3;
/** 贴脸敌方节点堆到这个兵力，就值得花一条指令把它先手打空。 */
const RAID_MAX = 1;
const RAID_MIN = 7;
/** 行军回合数在评分里的权重。 */
const TRAVEL_WEIGHT = 3;
/** 开局抢节奏：前 10 回合「当回合就能拿到」远比远距离奔袭值钱。 */
const EARLY_TRAVEL_WEIGHT = 10;

/** 同类节点总数 = count 时，单点每回合产出。 */
function perNode(kind: NodeKind, count: number): number {
  switch (kind) {
    case 'home':
      return 4;
    case 'foundry':
      return 5;
    case 'watchtower':
      return 2;
    default:
      return 2 + Math.floor(count / 2);
  }
}

/** 拿下这个节点后，我每回合总产出增加多少（含同类协同给老节点的加成）。 */
function captureValue(kind: NodeKind, owned: number): number {
  const next = perNode(kind, owned + 1);
  const now = perNode(kind, Math.max(owned, 1));
  return next + (next - now) * owned;
}

export function createJingtun(): Bot {
  return {
    name: '鲸吞',
    style: '极致产能 · 全兵上岗 · 以战养战',
    decide(view: Observation): Order[] {
      const me = view.you;
      const nodes = view.nodes;
      const adj = view.adj;
      const n = nodes.length;
      const turn = view.turn;
      const home = view.homeNode;
      const maxOrders = Math.min(MAX_ORDERS, view.maxOrders);

      // ---------- 0. 自己的地、可动用的兵、敌我划分 ----------
      const mine: number[] = [];
      for (let i = 0; i < n; i++) if (nodes[i].owner === me) mine.push(i);

      const avail = new Array<number>(n).fill(0);
      for (const i of mine) avail[i] = nodes[i].troops ?? 0;

      const foe = new Array<boolean>(n).fill(false);
      for (let i = 0; i < n; i++) foe[i] = nodes[i].owner >= 0 && nodes[i].owner !== me;

      const counts: Record<NodeKind, number> = {
        home: 0,
        farm: 0,
        mine: 0,
        lab: 0,
        watchtower: 0,
        foundry: 0,
      };
      for (const i of mine) counts[nodes[i].kind]++;

      // ---------- 1. 每个我方节点出发的最短路（可穿中立，不可穿敌方） ----------
      // 行军回合 = 跳数 - 1，到达回合 = turn + 跳数 - 1。
      const distOf = new Map<number, number[]>();
      for (const s of mine) {
        const d = new Array<number>(n).fill(Infinity);
        d[s] = 0;
        const q: number[] = [s];
        for (let qi = 0; qi < q.length; qi++) {
          const u = q[qi];
          for (const v of adj[u]) {
            if (d[v] !== Infinity) continue;
            d[v] = d[u] + 1;
            if (!foe[v]) q.push(v);
          }
        }
        distOf.set(s, d);
      }

      // ---------- 2. 在途纵队：我方增援 / 敌方来袭 ----------
      type WaveMap = Map<number, Map<number, number>>;
      const ownIn: WaveMap = new Map();
      const foeIn: WaveMap = new Map();
      const attackers = new Set<number>();
      const bump = (bag: WaveMap, target: number, at: number, troops: number): void => {
        let inner = bag.get(target);
        if (!inner) {
          inner = new Map();
          bag.set(target, inner);
        }
        inner.set(at, (inner.get(at) ?? 0) + troops);
      };
      for (const col of view.columns) {
        const target = col.path[col.path.length - 1];
        if (col.owner === me) {
          bump(ownIn, target, col.arriveTurn, col.troops);
        } else {
          bump(foeIn, target, col.arriveTurn, col.troops);
          if (nodes[target].owner === me) attackers.add(col.owner);
        }
      }
      const atTurn = (bag: WaveMap, target: number, at: number): number => bag.get(target)?.get(at) ?? 0;
      const byTurn = (bag: WaveMap, target: number, at: number): number => {
        const inner = bag.get(target);
        if (!inner) return 0;
        let total = 0;
        for (const [when, troops] of inner) if (when <= at) total += troops;
        return total;
      };

      // ---------- 3. 各节点驻守下限 ----------
      const foeNextTo = new Array<number>(n).fill(0);
      for (const i of mine) {
        let strongest = 0;
        for (const j of adj[i]) if (foe[j]) strongest = Math.max(strongest, nodes[j].troops ?? 0);
        foeNextTo[i] = strongest;
      }

      const floor = new Array<number>(n).fill(0);
      for (const i of mine) {
        if (i === home) continue;
        floor[i] = Math.min(avail[i], foeNextTo[i] > 0 ? FRONT_KEEP : REAR_KEEP);
      }
      {
        // 老家：视野 2 跳，正好能看见所有"下一回合能打到老家"的敌军。
        let near = 0;
        const seen = new Set<number>([home]);
        for (const a of adj[home]) {
          if (seen.has(a)) continue;
          seen.add(a);
          if (foe[a]) near = Math.max(near, nodes[a].troops ?? 0);
          for (const b of adj[a]) {
            if (seen.has(b)) continue;
            seen.add(b);
            if (foe[b]) near = Math.max(near, nodes[b].troops ?? 0);
          }
        }
        let keep = Math.max(HOME_MIN, foeNextTo[home] + 1);
        if (near > HOME_ALERT) keep = Math.max(keep, Math.min(34, near + 2));
        if (turn > 60) keep = Math.max(keep, 6);
        floor[home] = Math.min(avail[home], keep);
      }

      // ---------- 3.5 危墙不扶：一眼守不住的一侧，别往里填兵 ----------
      // 混战里总有一侧顺、一侧被人堆。对面在你门口堆了几倍的兵，补兵就是白送；
      // 把这一侧的兵抽出来，去别的方向抢地，才算把兵用在刀口上。
      const threat = new Array<number>(n).fill(0);
      for (const i of mine) {
        let t = 0;
        for (const j of adj[i]) if (foe[j]) t += nodes[j].troops ?? 0;
        t += atTurn(foeIn, i, turn + 2);
        threat[i] = t;
      }
      const hopeless = new Set<number>();
      for (const i of mine) {
        if (i === home) continue;
        if (distOf.get(i)![home] <= 2) continue; // 承重墙：离老家这么近，塌了家就没了，必须守
        const hold = (nodes[i].troops ?? 0) + 1;
        if (threat[i] >= hold * HOPELESS_RATIO) hopeless.add(i);
      }
      for (const i of hopeless) floor[i] = 1; // 这里只留 1，剩下的兵全部拿去干别的

      // ---------- 指令收集器 ----------
      const orders: Order[] = [];
      const usedPair = new Set<string>();
      const send = (from: number, to: number, troops: number): void => {
        if (orders.length >= maxOrders || from === to || troops < 1) return;
        const amount = Math.min(troops, avail[from]);
        if (amount < 1) return;
        const key = `${from}>${to}`;
        if (usedPair.has(key)) return;
        usedPair.add(key);
        orders.push({ from, to, troops: amount });
        avail[from] -= amount;
      };

      // ---------- 4. 防守：算出每个受威胁节点必须常驻的兵力，先补兵再锁进 floor ----------
      const doomed = new Set<number>();
      interface Guard {
        need: number; // 交锋时该节点必须有的兵力
        window: number; // 还有几回合敌人就到（0 = 当回合被贴脸）
      }
      const guard = new Map<number, Guard>();

      // 老家：贴脸堆（零预警）+ 下一步会被推平的邻居残兵 + 直扑老家的纵队
      {
        let need = Math.max(HOME_MIN, foeNextTo[home] + 2);
        let window = foeNextTo[home] > 0 ? 0 : Number.POSITIVE_INFINITY;
        let colTotal = 0;
        for (const [at, troops] of foeIn.get(home) ?? []) {
          if (at > turn + 1) continue;
          colTotal += troops;
          window = Math.min(window, at - turn);
        }
        if (colTotal > 0) need = Math.max(need, colTotal + 2);
        for (const a of adj[home]) {
          if (nodes[a].owner !== me) continue;
          const inc = foeIn.get(a);
          if (!inc) continue;
          let wave = 0;
          for (const [at, troops] of inc) if (at <= turn + 1) wave += troops;
          if (wave <= 0) continue;
          const hold = (nodes[a].troops ?? 0) + byTurn(ownIn, a, turn + 1);
          if (wave <= hold + 1) continue; // 那个点守得住
          need = Math.max(need, wave - hold + 3); // 残兵贴着门口，必须预先把老家垫厚
          window = Math.min(window, 1);
        }
        guard.set(home, { need, window: Math.max(0, window) });
      }

      // 其他节点：未来两回合内的来袭纵队
      for (const id of mine) {
        if (id === home) continue;
        const inc = foeIn.get(id);
        if (!inc) continue;
        let enemy = 0;
        let window = Number.POSITIVE_INFINITY;
        for (const [at, troops] of inc) {
          if (at > turn + 2) continue;
          enemy += troops;
          window = Math.min(window, at - turn);
        }
        if (enemy <= 0) continue;
        const own = byTurn(ownIn, id, turn + 2);
        const need = enemy - own + 1;
        if (need <= 0) continue;
        guard.set(id, { need, window: Math.max(0, window) });
      }

      const defendRank = (id: number): number => (id === home ? 1e6 : 0) + nodes[id].production;
      const guardOrder = [...guard.keys()].sort((a, b) => defendRank(b) - defendRank(a) || a - b);
      for (const id of guardOrder) {
        if (hopeless.has(id)) continue; // 危墙不扶
        const g = guard.get(id)!;
        const have = avail[id];
        let gap = g.need - have;
        if (gap > 0) {
          const sources = mine
            .filter((s) => s !== id && avail[s] > floor[s] && distOf.get(s)![id] - 1 <= g.window)
            .sort((a, b) => {
              const da = distOf.get(a)![id];
              const db = distOf.get(b)![id];
              return da - db || avail[b] - floor[b] - (avail[a] - floor[a]) || a - b;
            });
          let pool = 0;
          for (const s of sources) pool += avail[s] - floor[s];
          // 舍远求近：要花的兵超过上限、且不是老家，就让对面换，我们把兵留在进攻端
          if (id !== home && gap > DEFEND_MAX && pool < gap) {
            doomed.add(id);
            continue;
          }
          for (const s of sources) {
            if (gap <= 0) break;
            const spare = avail[s] - floor[s];
            if (spare <= 0) continue;
            const amount = Math.min(spare, gap);
            send(s, id, amount);
            gap -= amount;
          }
        }
        // 守家的兵不许被进攻端抽走
        floor[id] = Math.max(floor[id], Math.min(avail[id], g.need));
      }

      // ---------- 5. 进攻：同回合多源合击，只打算得赢的 ----------
      interface Plan {
        target: number;
        mustSend: number;
        sources: number[];
        score: number;
      }
      const plans: Plan[] = [];

      for (let t = 0; t < n; t++) {
        const nd = nodes[t];
        if (nd.owner === me || doomed.has(t)) continue;
        const known = nd.troops;
        if (known === null) continue; // 视野外的敌人，不赌
        const isFoe = nd.owner >= 0;

        const byTravel = new Map<number, number[]>();
        for (const s of mine) {
          const d = distOf.get(s)![t];
          if (!Number.isFinite(d) || d < 1) continue;
          if (avail[s] - floor[s] <= 0) continue;
          const travel = d - 1;
          const list = byTravel.get(travel);
          if (list) list.push(s);
          else byTravel.set(travel, [s]);
        }
        if (byTravel.size === 0) continue;

        // 价值 = 我拿到后的产出增量 + 削掉对面的产出
        let value = captureValue(nd.kind, counts[nd.kind]);
        if (isFoe) {
          value += nd.production;
          if (nd.kind === 'home') value += 6; // 斩首：对方领地立刻中立化
          if (attackers.has(nd.owner)) value *= 1.3; // 谁打我我打谁
        }

        for (const travel of [...byTravel.keys()].sort((a, b) => a - b)) {
          const at = turn + travel;
          const enemyReinf = atTurn(foeIn, t, at);
          // 敌方节点在路上还在产出，守军会变厚；中立节点不产出。
          const grown = isFoe ? known + travel * nd.production + enemyReinf : Math.max(known, enemyReinf);
          const need = grown + 1 + (isFoe ? 1 : 0);
          const inflight = atTurn(ownIn, t, at);
          if (inflight >= need) break;

          const src = byTravel.get(travel)!.slice().sort((a, b) => {
            const sa = avail[a] - floor[a];
            const sb = avail[b] - floor[b];
            return sb - sa || a - b;
          });
          let pool = inflight;
          for (const s of src) pool += avail[s] - floor[s];
          if (pool < need) continue;

          const chosen: number[] = [];
          let rest = need - inflight;
          for (const s of src) {
            if (rest <= 0) break;
            const spare = avail[s] - floor[s];
            if (spare <= 0) continue;
            const amount = Math.min(spare, rest);
            chosen.push(s);
            rest -= amount;
          }
          if (rest > 0) continue;

          const spend = need - inflight;
          const score = (value * 10) / (spend + (turn < 10 ? EARLY_TRAVEL_WEIGHT : TRAVEL_WEIGHT) * travel + 2);
          plans.push({ target: t, mustSend: spend, sources: chosen, score });
          break;
        }
      }

      plans.sort((a, b) => b.score - a.score || a.target - b.target);
      for (const plan of plans) {
        if (orders.length >= maxOrders) break;
        let pool = 0;
        for (const s of plan.sources) pool += Math.max(0, avail[s] - floor[s]);
        if (pool < plan.mustSend) continue;

        let rest = plan.mustSend;
        for (const s of plan.sources) {
          if (rest <= 0) break;
          const spare = avail[s] - floor[s];
          if (spare <= 0) continue;
          const amount = Math.min(spare, rest);
          send(s, plan.target, amount);
          rest -= amount;
        }
      }

      // ---------- 5.6 剩下的兵全部朝前线流动 ----------
      // pressure = 到最近敌方节点的跳数，沿中立/我方领土扩散，越小越靠前线。
      const pressure = new Array<number>(n).fill(Infinity);
      {
        const q: number[] = [];
        for (let i = 0; i < n; i++) {
          if (foe[i]) {
            pressure[i] = 0;
            q.push(i);
          }
        }
        for (let qi = 0; qi < q.length; qi++) {
          const u = q[qi];
          for (const v of adj[u]) {
            if (pressure[v] !== Infinity || foe[v]) continue;
            pressure[v] = pressure[u] + 1;
            q.push(v);
          }
        }
      }

      // 目标节点预计兵力：现有 + 我方在途 + 本回合已派，避免撞 100 上限
      const projected = new Array<number>(n).fill(0);
      for (const i of mine) projected[i] = nodes[i].troops ?? 0;
      for (const col of view.columns) {
        if (col.owner === me) projected[col.path[col.path.length - 1]] += col.troops;
      }
      for (const o of orders) if (nodes[o.to].owner === me) projected[o.to] += o.troops;

      const pushers = mine.filter((s) => avail[s] - floor[s] > 0);
      pushers.sort((a, b) => avail[b] - floor[b] - (avail[a] - floor[a]) || a - b);

      for (const s of pushers) {
        if (orders.length >= maxOrders) break;
        const spare = avail[s] - floor[s];
        if (spare <= 0) continue;
        const here = pressure[s];
        if (!Number.isFinite(here)) continue;

        let best = -1;
        let bestP = Infinity;
        let bestRoom = 0;
        const flee = hopeless.has(s); // 这一侧要塌了，兵往最安全的方向撤
        for (const v of adj[s]) {
          if (nodes[v].owner !== me) continue;
          const room = TROOP_CAP - projected[v];
          if (room <= 0) continue;
          if (flee) {
            const key = threat[v] + (hopeless.has(v) ? 1e6 : 0);
            if (key < bestP || (key === bestP && room > bestRoom)) {
              best = v;
              bestP = key;
              bestRoom = room;
            }
            continue;
          }
          if (pressure[v] >= here) continue;
          if (pressure[v] < bestP || (pressure[v] === bestP && room > bestRoom)) {
            best = v;
            bestP = pressure[v];
            bestRoom = room;
          }
        }
        if (best < 0) continue;

        const amount = Math.min(spare, bestRoom);
        if (amount < 1) continue;
        send(s, best, amount);
        projected[best] += amount;
      }

      // ---------- 5.7 先手削峰（压轴：进攻和流动把指令用完了，才轮到它） ----------
      // 自己这个点的驻军（floor）一个不动，多出来的兵反正闲着，正好把对面门口的堆打薄：
      // 他没视野，只会看到「我方还是那么厚、他自己变薄了」，多半就不敢先动手。
      if (RAID_MAX > 0 && orders.length < maxOrders) {
        let raidTarget = -1;
        let raidSend = 0;
        for (let f = 0; f < n; f++) {
          if (!foe[f]) continue;
          if (nodes[f].kind === 'foundry') continue; // 兵工厂守军更硬，打不动
          const known = nodes[f].troops;
          if (known === null || known < RAID_MIN) continue;
          let spare = 0;
          for (const s of mine) {
            if (distOf.get(s)![f] !== 1) continue; // 贴着我们前线的才叫对峙
            spare += Math.max(0, avail[s] - floor[s]);
          }
          if (spare < 3) continue;
          const sendVolume = spare > known + 1 ? known + 1 : Math.min(spare, known); // 够斩就斩，不够就打薄
          if (sendVolume > raidSend) {
            raidSend = sendVolume;
            raidTarget = f;
          }
        }
        if (raidTarget >= 0) {
          const f = raidTarget;
          const src = mine
            .filter((s) => distOf.get(s)![f] === 1 && avail[s] - floor[s] > 0)
            .sort((a, b) => avail[b] - floor[b] - (avail[a] - floor[a]) || a - b);
          let rest = Math.min(raidSend, 20);
          for (const s of src) {
            if (rest <= 0) break;
            const amount = Math.min(avail[s] - floor[s], rest);
            send(s, f, amount);
            rest -= amount;
          }
        }
      }

      return orders;
    },
  };
}
