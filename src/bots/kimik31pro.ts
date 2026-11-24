/**
 * Kimi K3.1 投稿 bot（issue #6）：经济竞速 · 风险调度 · 同步合击 · 精准斩首。
 */

import type { Bot, NodeKind, Observation, ObsNode, Order } from '../engine/types.js';

interface Route {
  path: number[];
  arrival: number;
}

interface Contribution {
  from: number;
  usable: number;
  route: Route;
}

interface Mission {
  target: number;
  score: number;
  allocations: Array<{ from: number; to: number; troops: number }>;
}

const PRODUCTION: Record<NodeKind, number> = {
  home: 4,
  farm: 2,
  mine: 2,
  lab: 2,
  watchtower: 2,
  foundry: 5,
};

function routeTo(view: Observation, from: number, to: number): Route | null {
  if (from === to) return null;
  const previous = new Array<number>(view.nodes.length).fill(-1);
  previous[from] = from;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const current = queue[qi];
    for (const next of view.adj[current]) {
      if (previous[next] !== -1) continue;
      if (next !== to) {
        const owner = view.nodes[next].owner;
        if (owner !== -1 && owner !== view.you) continue;
      }
      previous[next] = current;
      if (next === to) {
        const path = [to];
        let cursor = to;
        while (cursor !== from) {
          cursor = previous[cursor];
          path.push(cursor);
        }
        path.reverse();
        return { path, arrival: view.turn + Math.max(0, path.length - 2) };
      }
      queue.push(next);
    }
  }
  return null;
}

function graphDistances(view: Observation, start: number): number[] {
  const distances = new Array<number>(view.nodes.length).fill(Infinity);
  distances[start] = 0;
  const queue = [start];
  for (let qi = 0; qi < queue.length; qi++) {
    for (const next of view.adj[queue[qi]]) {
      if (distances[next] !== Infinity) continue;
      distances[next] = distances[queue[qi]] + 1;
      queue.push(next);
    }
  }
  return distances;
}

function marginalProduction(view: Observation, kind: NodeKind): number {
  if (kind === 'home' || kind === 'foundry' || kind === 'watchtower') return PRODUCTION[kind];
  const count = view.nodes.filter((node) => node.owner === view.you && node.kind === kind).length;
  const before = count * (2 + Math.floor(count / 2));
  const after = (count + 1) * (2 + Math.floor((count + 1) / 2));
  return after - before;
}

function hiddenEstimate(node: ObsNode, view: Observation): number {
  if (node.kind === 'home') return Math.min(70, 14 + node.production * 3 + Math.floor(view.turn / 5));
  return Math.min(45, 5 + node.production * 2 + Math.floor(view.turn / 8));
}

function noise(seed: number, target: number, arrival: number): number {
  let value = Math.imul(seed ^ Math.imul(target + 1, 0x9e3779b1) ^ arrival, 0x85ebca6b);
  value ^= value >>> 13;
  return (value >>> 0) / 0xffffffff;
}

export function createKimik31pro(): Bot {
  return {
    name: 'Kimi K3.1',
    style: '经济竞速 · 风险调度 · 同步合击 · 精准斩首',
    decide(view: Observation): Order[] {
      const ownNodes = view.nodes.filter((node) => node.owner === view.you);
      if (ownNodes.length === 0) return [];

      const available = new Map<number, number>();
      for (const node of ownNodes) available.set(node.id, node.troops ?? 0);

      const orders: Order[] = [];
      const orderKeys = new Set<string>();
      const plannedTargets = new Set<number>();
      const ownIncomingNow = new Map<number, number>();
      const ownIncomingAll = new Map<number, number>();
      const enemyIncomingNow = new Map<number, number>();
      const enemyIncomingFuture = new Map<number, number>();

      for (const column of view.columns) {
        const target = column.path[column.path.length - 1];
        if (column.owner === view.you) {
          ownIncomingAll.set(target, (ownIncomingAll.get(target) ?? 0) + column.troops);
          if (column.arriveTurn <= view.turn) {
            ownIncomingNow.set(target, (ownIncomingNow.get(target) ?? 0) + column.troops);
          }
        } else if (column.arriveTurn <= view.turn) {
          enemyIncomingNow.set(target, (enemyIncomingNow.get(target) ?? 0) + column.troops);
        } else {
          enemyIncomingFuture.set(target, (enemyIncomingFuture.get(target) ?? 0) + column.troops);
        }
      }

      const desired = new Map<number, number>();
      for (const node of ownNodes) {
        let sum = 0;
        let largest = 0;
        let adjacentEnemies = 0;
        for (const neighborId of view.adj[node.id]) {
          const neighbor = view.nodes[neighborId];
          if (neighbor.owner === -1 || neighbor.owner === view.you || !view.players[neighbor.owner]?.alive) continue;
          const troops = neighbor.troops ?? hiddenEstimate(neighbor, view);
          sum += troops;
          largest = Math.max(largest, troops);
          adjacentEnemies++;
        }
        const incomingNow = enemyIncomingNow.get(node.id) ?? 0;
        const incomingSoon = enemyIncomingFuture.get(node.id) ?? 0;
        const reinforcement = ownIncomingNow.get(node.id) ?? 0;
        let garrison = 0;
        if (adjacentEnemies > 0 || incomingNow > 0 || incomingSoon > 0) {
          const direct = node.id === view.homeNode ? sum : largest + 0.3 * (sum - largest);
          const futureWeight = node.id === view.homeNode ? 1 : 0.65;
          garrison = Math.ceil(direct + incomingNow + futureWeight * incomingSoon + 1 - reinforcement);
        }
        desired.set(node.id, Math.max(0, Math.min(100, garrison)));
      }

      const addOrder = (from: number, to: number, troops: number): boolean => {
        const amount = Math.floor(troops);
        const key = `${from}>${to}`;
        if (amount < 1 || orders.length >= view.maxOrders || orderKeys.has(key)) return false;
        const left = available.get(from) ?? 0;
        if (left < amount || view.nodes[from].owner !== view.you) return false;
        available.set(from, left - amount);
        orderKeys.add(key);
        orders.push({ from, to, troops: amount });
        return true;
      };

      // Last-moment defense. The home gets every available adjacent reserve;
      // ordinary nodes are reinforced only when a visible arrival can be beaten.
      const defenseTargets = ownNodes
        .filter((node) => {
          const need = (desired.get(node.id) ?? 0) - (node.troops ?? 0);
          return need > 0 && (node.id === view.homeNode || (enemyIncomingNow.get(node.id) ?? 0) > 0);
        })
        .sort((a, b) => {
          if (a.id === view.homeNode) return -1;
          if (b.id === view.homeNode) return 1;
          return (enemyIncomingNow.get(b.id) ?? 0) - (enemyIncomingNow.get(a.id) ?? 0);
        });

      for (const target of defenseTargets) {
        if (orders.length >= view.maxOrders) break;
        const isHome = target.id === view.homeNode;
        const currentDefense = (target.troops ?? 0) + (ownIncomingNow.get(target.id) ?? 0);
        const required = isHome
          ? Math.max(0, (desired.get(target.id) ?? 0) - (target.troops ?? 0))
          : Math.max(0, (enemyIncomingNow.get(target.id) ?? 0) + 1 - currentDefense);
        if (required === 0) continue;

        const donors = view.adj[target.id]
          .map((id) => view.nodes[id])
          .filter((node) => node.owner === view.you)
          .map((node) => {
            const reserve = isHome ? 0 : desired.get(node.id) ?? 0;
            return { id: node.id, usable: Math.max(0, (available.get(node.id) ?? 0) - reserve) };
          })
          .filter((donor) => donor.usable > 0)
          .sort((a, b) => b.usable - a.usable);
        const possible = donors.reduce((sum, donor) => sum + donor.usable, 0);
        if (!isHome && possible < required) continue;

        let remaining = required;
        for (const donor of donors) {
          if (orders.length >= view.maxOrders) break;
          const amount = Math.min(donor.usable, remaining);
          if (addOrder(donor.id, target.id, amount)) remaining -= amount;
          if (remaining <= 0) break;
        }
      }

      const distanceCache = new Map<number, number[]>();
      const distancesFrom = (id: number): number[] => {
        const cached = distanceCache.get(id);
        if (cached) return cached;
        const distances = graphDistances(view, id);
        distanceCache.set(id, distances);
        return distances;
      };
      const enemyHomes = view.nodes.filter(
        (node) => node.kind === 'home' && node.owner !== -1 && node.owner !== view.you && view.players[node.owner]?.alive,
      );
      const nearestEnemyHomeDistance = (id: number): number => {
        let best = Infinity;
        for (const home of enemyHomes) best = Math.min(best, distancesFrom(home.id)[id]);
        return best;
      };

      const usableFor = (sourceId: number, target: ObsNode, allIn: boolean): number => {
        const left = available.get(sourceId) ?? 0;
        if (left <= 0) return 0;
        if (allIn) return left;
        let reserve = desired.get(sourceId) ?? 0;
        if (target.owner !== -1 && target.owner !== view.you && view.adj[sourceId].includes(target.id)) {
          reserve = Math.max(0, reserve - Math.floor((target.troops ?? 0) * 0.8));
        }
        const normal = Math.max(0, left - reserve);
        const overflow = Math.max(0, left - 96);
        return Math.max(normal, overflow);
      };

      // If an adjacent attack can take the enemy home now, it takes precedence
      // over economic play. A small overbid covers an unobserved reinforcement.
      for (const home of enemyHomes) {
        if (orders.length >= view.maxOrders) break;
        const homeTroops = home.troops ?? hiddenEstimate(home, view);
        const defense = homeTroops + (enemyIncomingNow.get(home.id) ?? 0);
        const contributors: Contribution[] = [];
        for (const sourceId of view.adj[home.id]) {
          if (view.nodes[sourceId].owner !== view.you) continue;
          const route = routeTo(view, sourceId, home.id);
          const usable = usableFor(sourceId, home, true);
          if (route && usable > 0) contributors.push({ from: sourceId, usable, route });
        }
        contributors.sort((a, b) => b.usable - a.usable);
        const total = contributors.reduce((sum, item) => sum + item.usable, 0);
        if (total <= defense || contributors.length > view.maxOrders - orders.length) continue;
        let amountToSend = Math.min(total, defense + 3);
        const needed = defense + 1;
        let sent = 0;
        for (const contributor of contributors) {
          if (orders.length >= view.maxOrders) break;
          const amount = Math.min(contributor.usable, amountToSend);
          if (addOrder(contributor.from, home.id, amount)) {
            amountToSend -= amount;
            sent += amount;
          }
          if (amountToSend <= 0) break;
        }
        if (sent >= needed) plannedTargets.add(home.id);
      }

      // Repeatedly select the best fully funded mission. Sources in one mission
      // always have the same arrival turn, avoiding piecemeal attacks.
      while (orders.length < view.maxOrders) {
        let best: Mission | null = null;
        for (const target of view.nodes) {
          if (target.owner === view.you || plannedTargets.has(target.id)) continue;
          if (target.owner !== -1 && !view.players[target.owner]?.alive) continue;

          const groups = new Map<number, Contribution[]>();
          for (const source of ownNodes) {
            const route = routeTo(view, source.id, target.id);
            if (!route || route.arrival > view.maxTurns) continue;
            const allIn = target.kind === 'home' && target.owner !== -1 && route.arrival === view.turn;
            const usable = usableFor(source.id, target, allIn);
            if (usable <= 0) continue;
            const group = groups.get(route.arrival) ?? [];
            group.push({ from: source.id, usable, route });
            groups.set(route.arrival, group);
          }

          const ownArrivals = view.columns.filter(
            (column) => column.owner === view.you && column.path[column.path.length - 1] === target.id,
          );
          const earliestOwnArrival = ownArrivals.length > 0 ? Math.min(...ownArrivals.map((column) => column.arriveTurn)) : -1;

          for (const [arrival, contributors] of groups) {
            if (earliestOwnArrival >= 0 && arrival !== earliestOwnArrival) continue;
            const delay = arrival - view.turn;
            const sameEnemy = view.columns.filter(
              (column) =>
                column.owner !== view.you &&
                column.path[column.path.length - 1] === target.id &&
                column.arriveTurn === arrival,
            );
            const earlierEnemy = view.columns.filter(
              (column) =>
                column.owner !== view.you &&
                column.path[column.path.length - 1] === target.id &&
                column.arriveTurn < arrival,
            );
            const committed = ownArrivals
              .filter((column) => column.arriveTurn === arrival)
              .reduce((sum, column) => sum + column.troops, 0);

            let defense = target.owner === -1 ? target.troops ?? 0 : target.troops ?? hiddenEstimate(target, view);
            if (target.owner !== -1) defense += target.production * delay;
            defense += earlierEnemy.reduce((sum, column) => sum + column.troops, 0);
            const enemySame = sameEnemy.reduce((sum, column) => sum + column.troops, 0);
            if (target.owner !== -1) defense += enemySame;

            const enemyAdjacent = view.adj[target.id].filter(
              (id) => view.nodes[id].owner !== -1 && view.nodes[id].owner !== view.you,
            ).length;
            let margin = 0;
            if (target.owner === -1 && enemyAdjacent > 0 && delay === 0) margin = 2;
            if (target.owner !== -1) margin = 1 + Math.min(3, enemyAdjacent);
            const required = Math.max(1, Math.ceil(Math.max(defense, enemySame) + 1 + margin - committed));

            const sorted = contributors.slice().sort((a, b) => b.usable - a.usable || a.from - b.from);
            const allocations: Mission['allocations'] = [];
            let funded = 0;
            for (const contributor of sorted) {
              if (allocations.length >= view.maxOrders - orders.length) break;
              const amount = Math.min(contributor.usable, required - funded);
              if (amount <= 0) break;
              allocations.push({ from: contributor.from, to: target.id, troops: amount });
              funded += amount;
              if (funded >= required) break;
            }
            if (funded < required) continue;

            const ownGain = marginalProduction(view, target.kind);
            let value: number;
            if (target.kind === 'home' && target.owner !== -1) {
              value = delay === 0 ? 1_000_000 : 12_000;
            } else if (target.owner === -1) {
              value = 52 + ownGain * 15 + view.adj[target.id].length * 2;
              if (target.kind === 'watchtower') value += 13;
              if (target.kind === 'foundry') value += 9;
              if (enemyAdjacent > 0) value += 11;
              const homeDistance = nearestEnemyHomeDistance(target.id);
              if (Number.isFinite(homeDistance)) value += Math.max(0, 7 - homeDistance) * 1.4;
            } else {
              value = 66 + (ownGain + target.production) * 13 + enemyAdjacent * 2;
              if (target.kind === 'watchtower') value += 12;
              if (target.kind === 'foundry') value += 10;
              if (!target.visible) value -= 24;
            }
            if (view.turn >= 110) value += 35;
            if (view.turn >= 140) value += 45;

            const score =
              value / Math.max(3, required) -
              delay * (target.kind === 'home' ? 1.2 : 3.1) -
              (allocations.length - 1) * 0.7 +
              noise(view.rngSeed, target.id, arrival) * 0.001;
            if (!best || score > best.score) best = { target: target.id, score, allocations };
          }
        }
        if (!best) break;
        let complete = true;
        for (const allocation of best.allocations) {
          if ((available.get(allocation.from) ?? 0) < allocation.troops || orderKeys.has(`${allocation.from}>${allocation.to}`)) {
            complete = false;
            break;
          }
        }
        if (!complete) {
          plannedTargets.add(best.target);
          continue;
        }
        for (const allocation of best.allocations) addOrder(allocation.from, allocation.to, allocation.troops);
        plannedTargets.add(best.target);
      }

      // Spend otherwise idle troops on logistics. This both prepares the next
      // attack and avoids the 100-troop production cap in safe rear nodes.
      const transferredFrom = new Set<number>();
      while (orders.length < view.maxOrders) {
        let bestTransfer: { from: number; to: number; troops: number; score: number } | null = null;
        for (const source of ownNodes) {
          if (transferredFrom.has(source.id)) continue;
          const left = available.get(source.id) ?? 0;
          const surplus = Math.max(0, left - (desired.get(source.id) ?? 0));
          if (surplus < 2) continue;

          for (const destination of ownNodes) {
            if (destination.id === source.id) continue;
            const route = routeTo(view, source.id, destination.id);
            if (!route || route.arrival > view.maxTurns || orderKeys.has(`${source.id}>${destination.id}`)) continue;
            const incoming = ownIncomingAll.get(destination.id) ?? 0;
            const space = Math.max(0, 100 - (destination.troops ?? 0) - incoming);
            if (space === 0) continue;
            const amount = Math.min(surplus, space);
            if (amount < 2) continue;

            let enemyDistance = Infinity;
            let neutralDistance = Infinity;
            const distances = distancesFrom(destination.id);
            for (const node of view.nodes) {
              if (node.owner !== -1 && node.owner !== view.you) enemyDistance = Math.min(enemyDistance, distances[node.id]);
              if (node.owner === -1) neutralDistance = Math.min(neutralDistance, distances[node.id]);
            }
            const defenseNeed = Math.max(0, (desired.get(destination.id) ?? 0) - (destination.troops ?? 0));
            let score = 22 + defenseNeed * 3 - route.path.length * 1.4;
            if (Number.isFinite(enemyDistance)) score += Math.max(0, 9 - enemyDistance * 3);
            if (Number.isFinite(neutralDistance)) score += Math.max(0, 5 - neutralDistance);
            if (destination.id === view.homeNode && defenseNeed > 0) score += 45;
            score -= (destination.troops ?? 0) * 0.035;
            if (!bestTransfer || score > bestTransfer.score) {
              bestTransfer = { from: source.id, to: destination.id, troops: amount, score };
            }
          }
        }
        if (!bestTransfer) break;
        if (addOrder(bestTransfer.from, bestTransfer.to, bestTransfer.troops)) transferredFrom.add(bestTransfer.from);
        else break;
      }

      return orders;
    },
  };
}
