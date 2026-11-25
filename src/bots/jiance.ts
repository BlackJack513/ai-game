import type { Bot, NodeKind, Observation, Order } from '../engine/types.js';

const MAX_ORDERS = 5;

function emptyCounts(): Record<NodeKind, number> {
  return { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 };
}

function totalOf(kind: NodeKind, count: number): number {
  if (kind === 'home') return count * 4;
  if (kind === 'foundry') return count * 5;
  if (kind === 'watchtower') return count * 2;
  return count * (2 + Math.floor(count / 2));
}

function marginalOf(kind: NodeKind, count: number): number {
  return totalOf(kind, count + 1) - totalOf(kind, count);
}

function distancesFrom(view: Observation, from: number): number[] {
  const n = view.nodes.length;
  const base = new Array<number>(n).fill(Infinity);
  base[from] = 0;
  const queue = [from];

  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of view.adj[u]) {
      if (base[v] !== Infinity) continue;
      const owner = view.nodes[v].owner;
      if (owner !== -1 && owner !== view.you) continue;
      base[v] = base[u] + 1;
      queue.push(v);
    }
  }

  const dist = base.slice();
  for (let t = 0; t < n; t++) {
    const owner = view.nodes[t].owner;
    if (owner === -1 || owner === view.you) continue;
    for (const u of view.adj[t]) {
      if (base[u] !== Infinity && base[u] + 1 < dist[t]) dist[t] = base[u] + 1;
    }
  }

  return dist;
}

function hopDistances(view: Observation, from: number): number[] {
  const dist = new Array<number>(view.nodes.length).fill(Infinity);
  dist[from] = 0;
  const queue = [from];
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

function enemyDistances(view: Observation): number[] {
  const dist = new Array<number>(view.nodes.length).fill(Infinity);
  const queue: number[] = [];
  for (const node of view.nodes) {
    if (node.owner >= 0 && node.owner !== view.you) {
      dist[node.id] = 0;
      queue.push(node.id);
    }
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

function guardNeed(view: Observation, nodeId: number, troops: number, isHome: boolean): number {
  let need = 0;

  for (const column of view.columns) {
    if (column.owner === view.you) continue;
    if (column.path[column.path.length - 1] !== nodeId) continue;
    if (column.arriveTurn > view.turn + 2) continue;
    need = Math.max(need, column.troops + 1);
  }

  if (isHome && view.turn > 2) {
    need = Math.max(need, view.turn < 15 ? 6 : view.turn < 30 ? 8 : 10);
  }

  return Math.min(troops, need);
}

interface Candidate {
  target: number;
  kind: NodeKind;
  need: number;
  turns: number;
  score: number;
  sources: number[];
}

export function createZhanluSilkworm(): Bot {
  return {
    name: '简策',
    style: '分兵扩产 · 抢产优先 · 见缝蚕食',
    decide(view: Observation): Order[] {
      const own = view.nodes.filter((node) => node.owner === view.you);
      if (own.length === 0) return [];

      const homeHop = hopDistances(view, view.homeNode);

      const counts = emptyCounts();
      for (const node of own) counts[node.kind]++;

      const ownerCounts = new Map<number, Record<NodeKind, number>>();
      for (const node of view.nodes) {
        if (node.owner < 0) continue;
        let row = ownerCounts.get(node.owner);
        if (!row) {
          row = emptyCounts();
          ownerCounts.set(node.owner, row);
        }
        row[node.kind]++;
      }

      const rivalsAlive = view.players.filter((player) => player.alive && player.id !== view.you);
      let weakest: number | null = null;
      for (const player of rivalsAlive) {
        if (weakest === null) {
          weakest = player.id;
          continue;
        }
        const current = rivalsAlive.find((row) => row.id === weakest);
        if (!current || player.nodes < current.nodes || (player.nodes === current.nodes && player.production < current.production)) {
          weakest = player.id;
        }
      }

      const available = new Map<number, number>();
      for (const node of own) {
        const troops = node.troops ?? 0;
        available.set(node.id, troops - guardNeed(view, node.id, troops, node.id === view.homeNode));
      }

      const distCache = new Map<number, number[]>();
      const distTo = (from: number): number[] => {
        let dist = distCache.get(from);
        if (!dist) {
          dist = distancesFrom(view, from);
          distCache.set(from, dist);
        }
        return dist;
      };

      const planned = emptyCounts();
      const incoming = view.columns.filter((column) => column.owner !== view.you);
      const candidates: Candidate[] = [];

      for (const target of view.nodes) {
        if (target.owner === view.you) continue;
        if (target.troops === null) continue;

        let reachable = false;
        const layers = new Map<number, Array<{ id: number; power: number }>>();

        for (const source of own) {
          const dist = distTo(source.id)[target.id];
          if (!Number.isFinite(dist)) continue;
          reachable = true;
          const power = available.get(source.id) ?? 0;
          if (power <= 0) continue;
          const turns = Math.max(0, dist - 1);
          const layer = layers.get(turns) ?? [];
          layer.push({ id: source.id, power });
          layers.set(turns, layer);
        }

        if (!reachable) continue;

        const rivals = view.adj[target.id]
          .map((id) => view.nodes[id])
          .filter((n) => n.owner >= 0 && n.owner !== view.you);

        let contest = 0;
        if (target.owner === -1 && (target.troops ?? 0) > 0 && rivals.length > 0) {
          let rivalPower = 0;
          for (const rival of rivals) rivalPower += rival.troops ?? 6;
          contest = Math.min(30, rivalPower) + 2;
        }

        const need = target.troops + 1 + (target.owner >= 0 ? 1 : 0) + contest;
        let bestTurns = -1;
        let wave: Array<{ id: number; power: number }> = [];

        for (const turns of [...layers.keys()].sort((a, b) => a - b)) {
          const layer = layers.get(turns)!;
          const power = layer.reduce((sum, source) => sum + source.power, 0);
          if (power < need) continue;
          bestTurns = turns;
          wave = layer.sort((a, b) => b.power - a.power);
          break;
        }

        if (bestTurns < 0) continue;

        const contested = incoming.some(
          (column) =>
            column.path[column.path.length - 1] === target.id &&
            column.arriveTurn <= view.turn + bestTurns,
        );
        if (contested) continue;

        const kindCount = counts[target.kind] + planned[target.kind];
        let perTurn = marginalOf(target.kind, kindCount);
        if (target.kind === 'watchtower') perTurn += counts.watchtower === 0 ? 4 : 2;
        if (target.owner >= 0) {
          const rivalCounts = ownerCounts.get(target.owner);
          const before = rivalCounts ? rivalCounts[target.kind] : 1;
          const loss = totalOf(target.kind, before) - totalOf(target.kind, Math.max(0, before - 1));
          perTurn += loss * 0.6;
          if (target.kind === 'home') perTurn += 2;
        }

        const homeGap = homeHop[target.id];
        if (homeGap <= 3) perTurn += (4 - homeGap) * 0.8;
        if (target.owner >= 0 && homeGap <= 2) perTurn += 1.5;

        const horizon = Math.max(1, view.maxTurns - view.turn - bestTurns);
        let value = perTurn * horizon;
        const endgame = Math.max(0, 30 - (view.maxTurns - view.turn)) / 30;
        value += endgame * 3 * horizon;

        if (target.owner >= 0 && weakest !== null && rivalsAlive.length >= 2 && target.owner !== weakest) {
          value *= 0.7;
        }

        candidates.push({
          target: target.id,
          kind: target.kind,
          need,
          turns: bestTurns,
          score: value / (need + bestTurns * 1.5 + 1),
          sources: wave.map((source) => source.id),
        });
      }

      candidates.sort((a, b) => b.score - a.score);

      const orders: Order[] = [];
      const limit = Math.min(view.maxOrders, MAX_ORDERS);

      const threats = new Map<number, number>();
      for (const column of incoming) {
        if (column.arriveTurn > view.turn + 2) continue;
        const goal = column.path[column.path.length - 1];
        if (view.nodes[goal].owner !== view.you) continue;
        threats.set(goal, (threats.get(goal) ?? 0) + column.troops);
      }

      for (const [goal, threat] of [...threats.entries()].sort((a, b) => b[1] - a[1])) {
        if (orders.length >= limit) break;
        let need = threat + 1 - (view.nodes[goal].troops ?? 0);
        if (need <= 0) continue;
        const helpers = own
          .filter((node) => node.id !== goal && view.adj[node.id].includes(goal))
          .map((node) => ({ id: node.id, power: available.get(node.id) ?? 0 }))
          .filter((node) => node.power > 0)
          .sort((a, b) => b.power - a.power);
        for (const helper of helpers) {
          if (orders.length >= limit || need <= 0) break;
          const troops = Math.min(helper.power, need);
          orders.push({ from: helper.id, to: goal, troops });
          available.set(helper.id, helper.power - troops);
          need -= troops;
        }
      }

      for (const candidate of candidates) {
        if (orders.length >= limit) break;

        let need = candidate.need;
        const picks: Order[] = [];

        for (const source of candidate.sources) {
          if (orders.length + picks.length >= limit) break;
          const pool = available.get(source) ?? 0;
          if (pool <= 0) continue;
          const troops = Math.min(pool, need);
          if (troops <= 0) continue;
          picks.push({ from: source, to: candidate.target, troops });
          need -= troops;
          if (need <= 0) break;
        }

        if (need > 0) continue;

        for (const pick of picks) {
          available.set(pick.from, (available.get(pick.from) ?? 0) - pick.troops);
          orders.push(pick);
        }
        planned[candidate.kind]++;
      }

      if (orders.length < limit) {
        const enemyDist = enemyDistances(view);
        const used = new Set(orders.map((order) => order.from));
        const fronts = own
          .filter((node) => Number.isFinite(enemyDist[node.id]))
          .sort((a, b) => enemyDist[a.id] - enemyDist[b.id]);

        for (const source of own) {
          if (orders.length >= limit) break;
          if (used.has(source.id)) continue;
          const power = available.get(source.id) ?? 0;
          if (power < 3) continue;

          let best: number | null = null;
          let bestScore = Infinity;

          for (const front of fronts) {
            if (front.id === source.id) continue;
            if (enemyDist[front.id] > enemyDist[source.id]) continue;
            if (enemyDist[front.id] === enemyDist[source.id] && homeHop[front.id] <= homeHop[source.id]) continue;
            const steps = distTo(source.id)[front.id];
            if (!Number.isFinite(steps)) continue;
            const guarded = incoming.some(
              (column) =>
                column.path[column.path.length - 1] === front.id && column.arriveTurn <= view.turn + 2,
            );
            if (guarded) continue;
            const score = steps * 10 + enemyDist[front.id];
            if (score < bestScore) {
              bestScore = score;
              best = front.id;
            }
          }

          if (best === null) continue;
          orders.push({ from: source.id, to: best, troops: power });
          available.set(source.id, 0);
          used.add(source.id);
        }
      }

      return orders;
    },
  };
}
