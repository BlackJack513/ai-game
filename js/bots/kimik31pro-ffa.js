/**
 * 「kimik31pro-ffa」投稿 bot（issue #9）：混战专精 · 安全扩张 · 动态防御 · 终局抢点。
 * 只专注四人混战榜，不参与单挑榜。
 */
const HOME = 'home';
const NEUTRAL = -1;
function targetOf(column) {
    return column.path[column.path.length - 1];
}
function buildRoutes(view) {
    const n = view.nodes.length;
    const distance = Array.from({ length: n }, () => new Array(n).fill(Infinity));
    const previous = Array.from({ length: n }, () => new Array(n).fill(-1));
    for (const source of view.nodes) {
        if (source.owner !== view.you)
            continue;
        distance[source.id][source.id] = 0;
        previous[source.id][source.id] = source.id;
        const queue = [source.id];
        for (let qi = 0; qi < queue.length; qi++) {
            const from = queue[qi];
            for (const to of view.adj[from]) {
                if (previous[source.id][to] !== -1)
                    continue;
                previous[source.id][to] = from;
                distance[source.id][to] = distance[source.id][from] + 1;
                const owner = view.nodes[to].owner;
                if (owner === view.you || owner === NEUTRAL)
                    queue.push(to);
            }
        }
    }
    return { distance, previous };
}
function routeBetween(routes, from, to) {
    if (!Number.isFinite(routes.distance[from][to]) || from === to)
        return null;
    const path = [to];
    let current = to;
    while (current !== from) {
        current = routes.previous[from][current];
        path.push(current);
    }
    path.reverse();
    return path;
}
function productionGain(view, node) {
    if (node.kind === HOME)
        return 4;
    if (node.kind === 'foundry')
        return 5;
    if (node.kind === 'watchtower')
        return 2;
    const count = view.nodes.filter((other) => other.owner === view.you && other.kind === node.kind).length;
    const before = count * (2 + Math.floor(count / 2));
    const after = (count + 1) * (2 + Math.floor((count + 1) / 2));
    return after - before;
}
function estimatedGarrison(view, node) {
    if (node.troops !== null)
        return node.troops;
    const player = view.players[node.owner];
    if (!player)
        return 12;
    const turns = Math.min(view.turn, 12);
    const average = (20 + player.production * turns) / Math.max(1, player.nodes);
    const estimate = node.kind === HOME
        ? Math.max(6, Math.min(28, average * 0.55))
        : Math.max(5 + node.production * 2, average * 0.7);
    return Math.min(90, Math.ceil(estimate));
}
function directPressure(view, nodeId, owner) {
    let total = 0;
    let single = 0;
    for (const adjacent of view.adj[nodeId]) {
        const node = view.nodes[adjacent];
        if (node.owner !== owner || node.troops === null)
            continue;
        const amount = Math.max(0, node.troops - 1);
        total += amount;
        single = Math.max(single, amount);
    }
    return { total, single };
}
function computeReserves(view) {
    const reserves = new Array(view.nodes.length).fill(0);
    const opponents = view.players.filter((player) => player.alive && player.id !== view.you);
    for (const node of view.nodes) {
        if (node.owner !== view.you)
            continue;
        const incoming = view.columns.some((column) => column.owner !== view.you && targetOf(column) === node.id && column.arriveTurn <= view.turn + 1);
        if (incoming) {
            reserves[node.id] = node.troops ?? 0;
            continue;
        }
        const isHome = node.id === view.homeNode;
        let reserve = isHome ? 7 + (view.turn > 60 ? 3 : 0) + (opponents.length === 1 ? 4 : 0) : 1;
        if (!isHome && node.kind === 'foundry')
            reserve = 2;
        if (view.turn > 125 && !isHome)
            reserve = 0;
        let largestThreat = 0;
        let largestSingle = 0;
        for (const opponent of opponents) {
            const pressure = directPressure(view, node.id, opponent.id);
            largestThreat = Math.max(largestThreat, pressure.total);
            largestSingle = Math.max(largestSingle, pressure.single);
        }
        if (largestThreat > 0) {
            const reactive = isHome
                ? Math.ceil(largestThreat * 0.75 + largestSingle * 0.25) + 2
                : Math.ceil(largestThreat * 0.35 + largestSingle * 0.15) + 1;
            reserve = Math.max(reserve, reactive);
        }
        reserves[node.id] = reserve;
    }
    return reserves;
}
function strongestEnemyWave(view, target, arrival) {
    const waves = new Map();
    for (const column of view.columns) {
        if (column.owner === view.you || targetOf(column) !== target || column.arriveTurn !== arrival)
            continue;
        waves.set(column.owner, (waves.get(column.owner) ?? 0) + column.troops);
    }
    return Math.max(0, ...waves.values());
}
function ownWave(view, target, arrival, includeEarlier) {
    let troops = 0;
    for (const column of view.columns) {
        if (column.owner !== view.you || targetOf(column) !== target)
            continue;
        if (column.arriveTurn === arrival || (includeEarlier && column.arriveTurn < arrival))
            troops += column.troops;
    }
    return troops;
}
export function createKimik31proFfa() {
    return {
        name: 'kimik31pro-ffa',
        style: '混战专精 · 安全扩张 · 动态防御 · 终局抢点',
        decide(view) {
            if (view.mode !== 'ffa')
                return [];
            const n = view.nodes.length;
            const routes = buildRoutes(view);
            const reserves = computeReserves(view);
            const spent = new Array(n).fill(0);
            const orders = [];
            const usedPairs = new Set();
            const attackedTargets = new Set();
            const ownNodes = view.nodes.filter((node) => node.owner === view.you);
            const aliveOpponents = view.players.filter((player) => player.alive && player.id !== view.you);
            const strongestOpponent = Math.max(0, ...aliveOpponents.map((player) => player.production));
            const spare = (nodeId, emergency = false) => {
                const node = view.nodes[nodeId];
                return Math.max(0, (node.troops ?? 0) - spent[nodeId] - (emergency ? 0 : reserves[nodeId]));
            };
            const commit = (from, to, troops) => {
                if (orders.length >= view.maxOrders || troops < 1 || usedPairs.has(`${from}>${to}`))
                    return false;
                if (!routeBetween(routes, from, to))
                    return false;
                orders.push({ from, to, troops });
                spent[from] += troops;
                usedPairs.add(`${from}>${to}`);
                return true;
            };
            const defenseNeeds = [];
            for (const node of ownNodes) {
                const arrivals = [...new Set(view.columns
                        .filter((column) => column.owner !== view.you && targetOf(column) === node.id)
                        .map((column) => column.arriveTurn))]
                    .sort((a, b) => a - b);
                let found = false;
                for (const arrival of arrivals) {
                    const elapsed = Math.max(0, arrival - view.turn);
                    const friendly = (node.troops ?? 0) + node.production * elapsed + ownWave(view, node.id, arrival, true);
                    const needed = strongestEnemyWave(view, node.id, arrival) + 1 + (node.id === view.homeNode ? 2 : 0) - friendly;
                    if (needed > 0) {
                        defenseNeeds.push({
                            target: node.id,
                            arrival,
                            troops: needed,
                            emergency: node.id === view.homeNode,
                        });
                        found = true;
                        break;
                    }
                }
                if (!found && node.id === view.homeNode && (node.troops ?? 0) < reserves[node.id]) {
                    defenseNeeds.push({
                        target: node.id,
                        arrival: view.turn,
                        troops: reserves[node.id] - (node.troops ?? 0),
                        emergency: false,
                    });
                }
            }
            defenseNeeds.sort((a, b) => {
                const homeDifference = Number(b.target === view.homeNode) - Number(a.target === view.homeNode);
                return homeDifference || a.arrival - b.arrival || b.troops - a.troops;
            });
            for (const need of defenseNeeds) {
                if (orders.length >= view.maxOrders)
                    break;
                const latestTravel = Math.max(0, need.arrival - view.turn);
                const candidates = ownNodes
                    .filter((node) => node.id !== need.target)
                    .map((node) => ({
                    id: node.id,
                    travel: routes.distance[node.id][need.target] - 1,
                    available: spare(node.id, need.emergency),
                }))
                    .filter((candidate) => candidate.available > 0 && candidate.travel >= 0 && candidate.travel <= latestTravel)
                    .sort((a, b) => a.travel - b.travel || b.available - a.available || a.id - b.id);
                const total = candidates.reduce((sum, candidate) => sum + candidate.available, 0);
                if (!need.emergency && need.arrival > view.turn && total < need.troops)
                    continue;
                if (view.nodes[need.target].kind !== 'foundry' && need.target !== view.homeNode && need.troops > 30)
                    continue;
                let remaining = need.troops;
                for (const candidate of candidates) {
                    if (remaining <= 0 || orders.length >= view.maxOrders)
                        break;
                    const amount = Math.min(remaining, candidate.available);
                    if (commit(candidate.id, need.target, amount))
                        remaining -= amount;
                }
            }
            // Build synchronized attack plans. Sources with different travel times only join when their arrivals match.
            while (orders.length < view.maxOrders && attackedTargets.size < 4) {
                let best = null;
                for (const target of view.nodes) {
                    if (target.owner === view.you || attackedTargets.has(target.id))
                        continue;
                    const owner = target.owner;
                    const earliestOwnArrival = Math.min(Infinity, ...view.columns
                        .filter((column) => column.owner === view.you && targetOf(column) === target.id)
                        .map((column) => column.arriveTurn));
                    for (let travel = 0; travel <= 5; travel++) {
                        const arrival = view.turn + travel;
                        if (earliestOwnArrival < arrival)
                            continue;
                        const earlierEnemy = view.columns.some((column) => column.owner !== view.you && targetOf(column) === target.id && column.arriveTurn < arrival);
                        if (earlierEnemy)
                            continue;
                        if (owner === NEUTRAL && travel > (view.turn > 115 ? 5 : 3))
                            continue;
                        const existing = ownWave(view, target.id, arrival, false);
                        const defenders = owner === NEUTRAL
                            ? target.troops ?? 0
                            : Math.min(100, estimatedGarrison(view, target) + target.production * travel);
                        const friendlyColumns = owner === NEUTRAL ? 0 : view.columns
                            .filter((column) => column.owner === owner && targetOf(column) === target.id && column.arriveTurn <= arrival)
                            .reduce((sum, column) => sum + column.troops, 0);
                        const opposition = Math.max(defenders + friendlyColumns, strongestEnemyWave(view, target.id, arrival));
                        const margin = owner !== NEUTRAL && target.troops === null ? 3 : 0;
                        const required = opposition + 1 + margin;
                        if (existing >= required)
                            continue;
                        const sources = ownNodes
                            .map((node) => ({
                            id: node.id,
                            available: target.kind === HOME && owner !== NEUTRAL
                                ? Math.max(spare(node.id), (node.troops ?? 0) - spent[node.id] - (node.id === view.homeNode ? 3 : 0))
                                : spare(node.id),
                            travel: routes.distance[node.id][target.id] - 1,
                        }))
                            .filter((source) => source.available > 0 && source.travel === travel)
                            .sort((a, b) => b.available - a.available || a.id - b.id);
                        const selected = [];
                        let force = existing;
                        for (const source of sources) {
                            if (selected.length >= view.maxOrders - orders.length)
                                break;
                            selected.push({ from: source.id, troops: source.available });
                            force += source.available;
                            if (force >= required)
                                break;
                        }
                        if (force < required || selected.length === 0)
                            continue;
                        const gain = productionGain(view, target);
                        const lateBonus = view.turn > 110 ? 22 + (view.turn - 110) * 0.8 : 0;
                        const leaderBonus = owner !== NEUTRAL && (view.players[owner]?.production ?? 0) >= strongestOpponent ? 12 : 0;
                        const duelBonus = aliveOpponents.length === 1 ? 20 : 0;
                        let score;
                        if (target.kind === HOME && owner !== NEUTRAL) {
                            score = 260 + (view.players[owner]?.nodes ?? 0) * 9 + aliveOpponents.length * -12
                                + (aliveOpponents.length === 1 ? 140 : 0) - opposition * 0.75 - travel * 4 - force * 0.12;
                        }
                        else if (owner === NEUTRAL) {
                            score = 17 + gain * 7 + (target.kind === 'watchtower' ? 7 : 0) + lateBonus
                                - opposition * 1.35 - travel * 5 - force * 0.22;
                        }
                        else {
                            score = 18 + gain * 6 + target.production * 4 + leaderBonus + duelBonus + lateBonus
                                - opposition * 1.1 - travel * 5.5 - force * 0.25;
                        }
                        // Avoid buying a node that an adjacent visible army can immediately retake for free.
                        if (owner === NEUTRAL && target.kind !== HOME) {
                            const survivors = Math.max(1, force - opposition);
                            let retake = 0;
                            for (const opponent of aliveOpponents) {
                                retake = Math.max(retake, directPressure(view, target.id, opponent.id).single);
                            }
                            if (retake > survivors)
                                score -= (retake - survivors) * 0.8;
                        }
                        if (!best || score > best.score) {
                            best = { target: target.id, arrival, sources: selected, score };
                        }
                    }
                }
                if (!best || best.score <= 1)
                    break;
                let committed = 0;
                for (const source of best.sources) {
                    if (commit(source.from, best.target, source.troops))
                        committed++;
                }
                if (committed === 0)
                    break;
                attackedTargets.add(best.target);
            }
            // Use spare capacity to move back-line stacks toward the frontier instead of wasting production at the cap.
            if (orders.length < view.maxOrders) {
                const nonOwn = view.nodes.filter((node) => node.owner !== view.you);
                const frontierDistance = new Array(n).fill(Infinity);
                for (const node of ownNodes) {
                    for (const target of nonOwn) {
                        frontierDistance[node.id] = Math.min(frontierDistance[node.id], routes.distance[node.id][target.id]);
                    }
                }
                const transfers = ownNodes
                    .map((node) => ({ id: node.id, available: spare(node.id), troops: node.troops ?? 0 }))
                    .filter((source) => source.available >= 6 && (source.troops >= 82 || frontierDistance[source.id] > 1))
                    .sort((a, b) => b.available - a.available || a.id - b.id);
                for (const source of transfers) {
                    if (orders.length >= view.maxOrders)
                        break;
                    const destinations = ownNodes
                        .filter((node) => node.id !== source.id && (node.troops ?? 0) < 82)
                        .filter((node) => frontierDistance[node.id] <= 1 && frontierDistance[node.id] < frontierDistance[source.id])
                        .map((node) => ({
                        id: node.id,
                        distance: routes.distance[source.id][node.id],
                        room: 90 - (node.troops ?? 0),
                        openings: view.adj[node.id].filter((id) => view.nodes[id].owner !== view.you).length,
                    }))
                        .filter((destination) => Number.isFinite(destination.distance) && destination.room >= 4)
                        .sort((a, b) => b.openings - a.openings || a.distance - b.distance || a.id - b.id);
                    const destination = destinations[0];
                    if (!destination)
                        continue;
                    commit(source.id, destination.id, Math.min(source.available, destination.room));
                }
            }
            return orders;
        },
    };
}
