/**
 * 凯哥astra —— 按占领收益分兵，以前沿兵站压缩增援距离。
 */
import type { Bot, Observation, Order } from '../engine/types.js';

export function createAstra(): Bot {
  return {
    name: '凯哥astra',
    style: '按占领收益分兵 · 以前沿兵站压缩增援距离',
    decide(v: Observation): Order[] {
      const { nodes, adj, you, homeNode: home } = v;
      const mine = nodes.filter((n) => n.owner === you);
      const hostile = nodes.filter((n) => n.owner >= 0 && n.owner !== you);
      const unknown = (id: number): number => nodes[id].troops ?? (nodes[id].kind === 'home' ? 20 : 12);

      const dist = nodes.map((s) => {
        const d = nodes.map(() => 999);
        const q = [s.id];
        d[s.id] = 0;
        for (let i = 0; i < q.length; i++)
          for (const j of adj[q[i]]) {
            if (d[j] !== 999) continue;
            d[j] = d[q[i]] + 1;
            if (nodes[j].owner < 0 || nodes[j].owner === s.owner) q.push(j);
          }
        return d;
      });

      const front = nodes.map((n) => Math.min(99, ...hostile.map((e) => dist[e.id][n.id])));
      const limit = Math.min(v.ordersLeft, v.maxOrders);
      const maxDelay = Math.min(6, v.maxTurns - v.turn);
      const incoming = nodes.map((n) => v.columns.filter((c) => c.path[c.path.length - 1] === n.id));
      const remaining = nodes.map((n) => n.troops ?? 0);
      const out: Order[] = [];
      const claimed = new Set<number>();

      const reserve = nodes.map((n) => {
        if (n.owner !== you) return 0;
        let keep = 0;
        for (let t = 0; t <= Math.min(maxDelay, 3); t++) {
          const byOwner = v.players.map(() => 0);
          let help = 0;
          for (const c of incoming[n.id])
            if (c.arriveTurn <= v.turn + t) {
              if (c.owner === you) help += c.troops;
              else byOwner[c.owner] += c.troops;
            }
          if (n.id === home)
            for (const e of hostile) {
              const d = dist[e.id][home];
              if (d <= t + 1) byOwner[e.owner] += unknown(e.id) * (t === 0 ? 1 : t === 1 ? 0.75 : 0.35);
            }
          keep = Math.max(keep, ...byOwner.map((b) => b - help - n.production * t));
        }
        return Math.ceil(keep);
      });

      // 对每个目的地按抵达时间聚合兵力；多路部队只在同回合进攻时合算。
      while (out.length < limit) {
        let best = 0;
        let wave: Order[] = [];
        for (const n of nodes) {
          if (claimed.has(n.id)) continue;
          const defend = n.owner === you;
          if (defend && reserve[n.id] <= remaining[n.id]) continue;
          const econ =
            n.kind === 'foundry'
              ? 5
              : ['farm', 'mine', 'lab'].includes(n.kind)
                ? 2 + Math.ceil(mine.filter((a) => a.kind === n.kind).length / 2)
                : 2;
          for (let t = 0; t <= maxDelay; t++) {
            if (defend && t > 0) break;
            const supply = mine
              .filter((s) => dist[s.id][n.id] === t + 1 && remaining[s.id] > reserve[s.id])
              .sort(
                (a, b) =>
                  remaining[b.id] - reserve[b.id] - (remaining[a.id] - reserve[a.id]),
              );
            if (!supply.length) continue;
            const forces = v.players.map(() => 0);
            let friendly = 0;
            for (const c of incoming[n.id])
              if (c.arriveTurn <= v.turn + t) {
                if (c.owner === you) friendly += c.troops;
                else forces[c.owner] += c.troops;
              }
            if (n.owner >= 0) forces[n.owner] += Math.min(100, unknown(n.id) + t * n.production);
            const guard = Math.max(n.owner < 0 ? unknown(n.id) : 0, ...forces);
            if (!defend && friendly > guard) continue;
            const capital = n.kind === 'home' && !defend;
            let support = 0;
            for (const e of hostile)
              if (e.id !== n.id && dist[e.id][n.id] <= t + 1) support += unknown(e.id);
            const required = defend ? reserve[n.id] - remaining[n.id] : Math.max(1, guard + 1 - friendly);
            const available = supply
              .slice(0, limit - out.length)
              .reduce((a, s) => a + remaining[s.id] - reserve[s.id], 0);
            if (available < required && !defend) continue;
            const margin = defend
              ? 0
              : capital
                ? support
                : Math.max(0, support * (n.owner < 0 ? 0.55 : 0.45) - (n.owner < 0 ? guard : 0));
            let ask = Math.min(available, Math.ceil(required + margin));
            const move: Order[] = [];
            for (const s of supply.slice(0, limit - out.length)) {
              const troops = Math.min(ask, remaining[s.id] - reserve[s.id]);
              move.push({ from: s.id, to: n.id, troops });
              ask -= troops;
              if (!ask) break;
            }
            const unresolved = Math.max(0, required + margin - available);
            const utility = defend
              ? n.id === home
                ? 10000
                : 50
              : capital
                ? 250
                : 13 +
                  econ * 5 +
                  (n.owner >= 0 ? 16 : 0) +
                  Math.min(6, adj[n.id].length) +
                  (front[n.id] <= 1 ? 4 : 0);
            const score =
              utility /
              ((1 + t * 0.4) *
                (1 + required * (n.owner < 0 ? 0.08 : 0.023)) *
                (1 + unresolved * (capital ? 0.2 : 0.07)) *
                (1 + 0.22 * (move.length - 1)));
            if (score > best) {
              best = score;
              wave = move;
            }
          }
        }
        if (!wave.length) break;
        claimed.add(wave[0].to);
        for (const o of wave) {
          remaining[o.from] -= o.troops;
          out.push(o);
        }
      }

      // 无可行占领时，把后方兵力送往最接近对手、且仍有容量的己方节点。
      const transfers: Array<{ o: Order; score: number }> = [];
      for (const s of mine)
        for (const n of mine) {
          const d = dist[s.id][n.id];
          if (front[n.id] >= front[s.id] || d > 3 || d > maxDelay + 1 || claimed.has(n.id)) continue;
          const room =
            100 -
            remaining[n.id] -
            incoming[n.id].filter((c) => c.owner === you).reduce((a, c) => a + c.troops, 0) -
            d * n.production;
          const troops = Math.min(remaining[s.id] - reserve[s.id], room);
          if (troops >= 9)
            transfers.push({
              o: { from: s.id, to: n.id, troops },
              score: (troops * (front[s.id] - front[n.id])) / d,
            });
        }
      const spent = new Set<number>();
      for (const { o } of transfers.sort((a, b) => b.score - a.score)) {
        if (out.length >= limit) break;
        if (spent.has(o.from) || claimed.has(o.to)) continue;
        spent.add(o.from);
        claimed.add(o.to);
        out.push(o);
      }
      return out;
    },
  };
}
