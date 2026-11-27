/**
 * 凯哥astra1 —— 分兵试探 · 精确留守 · 前沿集结。
 */
import type { Bot, Observation, Order } from '../engine/types.js';

export function createAstra1(): Bot {
  return {
    name: '凯哥astra1',
    style: '分兵试探 · 精确留守 · 前沿集结',
    decide(v: Observation): Order[] {
      const { nodes, adj, you, homeNode: home } = v;
      const mine = nodes.filter((n) => n.owner === you);
      const enemies = nodes.filter((n) => n.owner >= 0 && n.owner !== you);
      const dist = nodes.map((s) => {
        const d = nodes.map(() => 99);
        const q = [s.id];
        d[s.id] = 0;
        for (let i = 0; i < q.length; i++)
          for (const j of adj[q[i]]) {
            if (d[j] !== 99) continue;
            d[j] = d[q[i]] + 1;
            if (nodes[j].owner < 0 || nodes[j].owner === s.owner) q.push(j);
          }
        return d;
      });
      const edge = nodes.map((t) => Math.min(99, ...enemies.map((s) => dist[s.id][t.id])));
      const fronts = nodes.map((t) => adj[t.id].filter((j) => nodes[j].owner !== you).length);
      const balance = nodes.map(() => Array(9).fill(0));
      for (const c of v.columns) {
        const k = c.arriveTurn - v.turn;
        if (k >= 0 && k < 9) balance[c.path[c.path.length - 1]][k] += (c.owner === you ? 1 : -1) * c.troops;
      }
      const free = nodes.map((n) => (n.owner === you ? (n.troops ?? 0) : 0));
      const result: Order[] = [];
      const used = new Set<number>();
      function send(from: number, to: number, troops: number): void {
        result.push({ from, to, troops });
        free[from] -= troops;
        balance[to][dist[from][to] - 1] += troops;
      }

      // 守方平局不失地。按到达时刻检查缺口，先用最晚仍赶得上的援兵。
      let reserve = 0;
      let incoming = 0;
      for (let k = 0; k < 6; k++) {
        incoming += balance[home][k];
        const instant = enemies
          .filter((e) => dist[e.id][home] === 1)
          .reduce((a, e) => a + (e.troops ?? 0), 0);
        const danger = Math.max(0, (k === 0 ? instant : 0) - incoming - 4 * k);
        let gap = danger - free[home];
        for (const s of mine
          .filter((s) => s.id !== home && dist[s.id][home] <= k + 1)
          .sort((a, b) => free[b.id] - free[a.id])) {
          if (gap <= 0 || result.length >= v.ordersLeft) break;
          if (!free[s.id] || result.some((o) => o.from === s.id && o.to === home)) continue;
          const n = Math.min(gap, free[s.id]);
          send(s.id, home, n);
          incoming += n;
          gap -= n;
        }
        reserve = Math.max(reserve, Math.min(Math.max(0, free[home] + gap), free[home]));
      }
      free[home] = Math.max(0, free[home] - reserve);

      // 预先按目标和行军时间分组；分兵后只需检查剩余兵力，不再重复搜索路线。
      const groups = nodes.map((t) =>
        Array.from({ length: 8 }, (_, d) => mine.filter((s) => dist[s.id][t.id] === d)),
      );
      const enemyHomes = enemies.filter((e) => e.kind === 'home');
      const forward = nodes.map((t) => Math.min(9, ...enemyHomes.map((e) => dist[t.id][e.id])));
      while (result.length < v.ordersLeft) {
        let best = 0;
        let plan: Order[] = [];
        for (const t of nodes) {
          if (t.owner === you || used.has(t.id)) continue;
          const enemy = t.owner >= 0;
          const crown = enemy && t.kind === 'home';
          const gain =
            t.kind === 'foundry'
              ? 5
              : t.kind === 'watchtower'
                ? 2.5
                : 2.5 + mine.filter((n) => n.kind === t.kind).length * 0.7;
          for (let d = 1; d <= Math.min(7, v.maxTurns - v.turn + 1); d++) {
            const src = groups[t.id][d]
              .filter((s) => free[s.id] > 0)
              .sort((a, b) => free[b.id] - free[a.id])
              .slice(0, v.ordersLeft - result.length);
            if (!src.length) continue;
            const total = src.reduce((a, s) => a + free[s.id], 0);
            let guard = (t.troops ?? (crown ? 15 : 8)) + (enemy ? (d - 1) * t.production : 0);
            for (let k = 0; k < d; k++) guard -= balance[t.id][k];
            if (guard < 0) continue;
            // 普通敌点常在同时出兵后变空；用小队试占，敌方老家仍按足额守援估算。
            if (enemy && !crown) guard *= 0.35;
            const support = enemies
              .filter((e) => e.id !== t.id && dist[e.id][t.id] <= d)
              .reduce((a, e) => a + (e.troops ?? 5), 0);
            const need = Math.max(1, Math.ceil(guard + 1 + (crown ? support : 0)));
            if (total < need) continue;
            // 争夺中的中立点需要击败同回合最大的竞争纵队，而非依次打两仗。
            const contest =
              !enemy && edge[t.id] <= d
                ? Math.min(total, Math.max(need, Math.ceil(support * 0.65) + 1))
                : need;
            const amount = crown ? total : enemy ? Math.min(total, need + 3) : contest;
            let left = amount;
            const p: Order[] = [];
            for (const s of src) {
              const n = Math.min(left, free[s.id]);
              p.push({ from: s.id, to: t.id, troops: n });
              left -= n;
              if (!left) break;
            }
            const value =
              crown
                ? 10000
                : gain * (enemy ? 4 : 1) * (1 + 0.07 * fronts[t.id]) * (edge[t.id] <= 2 ? 1.18 : 1);
            const foothold = forward[t.id] === 1 ? 2.1 : forward[t.id] === 2 ? 1.45 : 1;
            const score =
              (value * foothold) /
              ((2 + need + support * 0.21) ** 0.9 *
                (0.4 + d) ** 2.5 *
                (0.8 + p.length * 0.2));
            if (score > best) {
              best = score;
              plan = p;
            }
          }
        }

        // 无法直接斩首时，让同一批次抵达的后援先集结到敌家相邻据点。
        for (const e of enemyHomes) {
          const support = enemies
            .filter((s) => s.id !== e.id && dist[s.id][e.id] <= 1)
            .reduce((a, s) => a + (s.troops ?? 5), 0);
          for (const t of mine) {
            if (dist[t.id][e.id] !== 1 || t.id === home) continue;
            for (let d = 1; d <= 3; d++) {
              const src = groups[t.id][d]
                .filter((s) => free[s.id] > 0 && !result.some((o) => o.from === s.id && o.to === t.id))
                .sort((a, b) => free[b.id] - free[a.id])
                .slice(0, v.ordersLeft - result.length);
              const force = src.reduce((a, s) => a + free[s.id], 0);
              if (force < 5) continue;
              const defense = (e.troops ?? 15) + d * e.production + support;
              const held =
                free[t.id] + t.production * d + balance[t.id].slice(0, d).reduce((a, b) => a + b, 0);
              if (held > defense || held + force < defense * 0.6) continue;
              const score = (3 * force) / ((defense + 1) * d * d);
              if (score > best) {
                best = score;
                plan = src.map((s) => ({ from: s.id, to: t.id, troops: free[s.id] }));
              }
            }
          }
        }
        if (!plan.length) break;
        used.add(plan[0].to);
        for (const o of plan) send(o.from, o.to, o.troops);
      }

      // 分配完各路小队后，把余兵并入已有纵队；侧向夺点也可以承接余兵。
      for (const s of mine) {
        const order = result
          .filter((o) => o.from === s.id && o.to !== home)
          .sort(
            (a, b) =>
              forward[a.to] - forward[b.to] || dist[s.id][a.to] - dist[s.id][b.to],
          )[0];
        if (order) {
          order.troops += free[s.id];
          free[s.id] = 0;
        }
      }

      // 闲置兵力向敌方老家方向集结，优先选能在下一回合直接出击的节点。
      const depth = nodes.map((n) =>
        Math.min(99, ...enemies.filter((e) => e.kind === 'home').map((e) => dist[n.id][e.id])),
      );
      for (const s of mine.slice().sort((a, b) => free[b.id] - free[a.id])) {
        if (result.length >= v.ordersLeft || free[s.id] < 3) continue;
        const next = mine
          .filter(
            (t) =>
              depth[t.id] < depth[s.id] &&
              dist[s.id][t.id] < 8 &&
              !result.some((o) => o.from === s.id && o.to === t.id),
          )
          .sort(
            (a, b) =>
              depth[a.id] +
              0.45 * dist[s.id][a.id] +
              Math.max(0, (a.troops ?? 0) - 65) * 0.06 -
              (depth[b.id] +
                0.45 * dist[s.id][b.id] +
                Math.max(0, (b.troops ?? 0) - 65) * 0.06),
          )[0];
        if (next) send(s.id, next.id, free[s.id]);
      }
      return result;
    },
  };
}
