/**
 * 湛卢混战：经济压制 · 控图视野 · 多源合击 · 蓄势斩首
 * 投稿来源：GitHub issue #7
 */
const NEUTRAL = -1;
export function createZhanluDeepseekFfa() {
    return {
        name: '湛卢混战',
        style: '经济压制 · 控图视野 · 多源合击 · 蓄势斩首',
        decide(view) {
            const me = view.you;
            const nodes = view.nodes;
            const adj = view.adj;
            const orders = [];
            const own = new Set();
            const ownIds = [];
            for (const node of nodes) {
                if (node.owner !== me)
                    continue;
                own.add(node.id);
                ownIds.push(node.id);
            }
            if (ownIds.length === 0)
                return orders;
            const maxOrders = view.maxOrders;
            const spent = new Map();
            const seenPairs = new Set();
            const current = (id) => (nodes[id].troops ?? 0) - (spent.get(id) ?? 0);
            const homeDistance = new Array(nodes.length).fill(Infinity);
            homeDistance[view.homeNode] = 0;
            const homeQueue = [view.homeNode];
            for (let qi = 0; qi < homeQueue.length; qi++) {
                const u = homeQueue[qi];
                for (const v of adj[u]) {
                    if (homeDistance[v] === Infinity) {
                        homeDistance[v] = homeDistance[u] + 1;
                        homeQueue.push(v);
                    }
                }
            }
            let homePressure = 0;
            for (const node of nodes) {
                if (node.owner === me || node.owner === NEUTRAL || node.troops === null)
                    continue;
                if (homeDistance[node.id] > 3)
                    continue;
                homePressure = Math.max(homePressure, node.troops);
            }
            const reserve = (id) => {
                if (id !== view.homeNode) {
                    const border = adj[id].some((to) => nodes[to].owner !== me && nodes[to].owner !== NEUTRAL);
                    return border ? 2 : 1;
                }
                let base;
                if (view.turn <= 3)
                    base = 1;
                else if (view.turn < 7)
                    base = 2;
                else if (view.turn < 13)
                    base = 5;
                else if (view.turn < 31)
                    base = 10;
                else if (view.turn < 51)
                    base = 12;
                else if (view.turn < 100)
                    base = 15;
                else
                    base = 18;
                return base + Math.min(15, Math.max(0, homePressure - 15));
            };
            const free = (id) => Math.max(0, current(id) - reserve(id));
            const push = (from, to, troops) => {
                const amount = Math.floor(troops);
                if (amount < 1 || orders.length >= maxOrders)
                    return false;
                if (current(from) < amount)
                    return false;
                const key = `${from}>${to}`;
                if (seenPairs.has(key))
                    return false;
                seenPairs.add(key);
                orders.push({ from, to, troops: amount });
                spent.set(from, (spent.get(from) ?? 0) + amount);
                return true;
            };
            const urgent = new Set();
            const waves = new Map();
            for (const column of view.columns) {
                if (column.owner === me)
                    continue;
                const target = column.path[column.path.length - 1];
                if (!own.has(target))
                    continue;
                if (column.arriveTurn < view.turn)
                    continue;
                let byArrival = waves.get(target);
                if (!byArrival) {
                    byArrival = new Map();
                    waves.set(target, byArrival);
                }
                let byOwner = byArrival.get(column.arriveTurn);
                if (!byOwner) {
                    byOwner = new Map();
                    byArrival.set(column.arriveTurn, byOwner);
                }
                byOwner.set(column.owner, (byOwner.get(column.owner) ?? 0) + column.troops);
            }
            const threatList = [];
            for (const [target, byArrival] of waves) {
                for (const [arrival, byOwner] of byArrival) {
                    if (arrival > view.turn + 2)
                        continue;
                    let maxEnemy = 0;
                    for (const troops of byOwner.values())
                        maxEnemy = Math.max(maxEnemy, troops);
                    const delay = Math.max(0, arrival - view.turn);
                    const projected = (nodes[target].troops ?? 0) + nodes[target].production * delay;
                    const gap = maxEnemy + 2 - projected;
                    if (gap > 0)
                        threatList.push({ target, arrival, gap });
                }
            }
            threatList.sort((a, b) => a.arrival - b.arrival ||
                (b.target === view.homeNode ? 1 : 0) - (a.target === view.homeNode ? 1 : 0));
            for (const threat of threatList)
                urgent.add(threat.target);
            for (const threat of threatList) {
                let gap = threat.gap;
                if (gap <= 0)
                    continue;
                const dist = new Array(nodes.length).fill(Infinity);
                dist[threat.target] = 0;
                const queue = [threat.target];
                for (let qi = 0; qi < queue.length; qi++) {
                    const u = queue[qi];
                    for (const v of adj[u]) {
                        if (dist[v] !== Infinity)
                            continue;
                        if (nodes[v].owner !== me && nodes[v].owner !== NEUTRAL)
                            continue;
                        dist[v] = dist[u] + 1;
                        queue.push(v);
                    }
                }
                const sources = ownIds
                    .filter((id) => id !== threat.target &&
                    dist[id] !== Infinity &&
                    view.turn + Math.max(0, dist[id] - 1) <= threat.arrival &&
                    !urgent.has(id))
                    .sort((a, b) => dist[a] - dist[b] || free(b) - free(a));
                for (const source of sources) {
                    if (gap <= 0 || orders.length >= maxOrders)
                        break;
                    if (source === view.homeNode && threat.target !== view.homeNode)
                        continue;
                    const can = current(source) - reserve(source);
                    if (can <= 0)
                        continue;
                    const send = Math.min(gap, can);
                    if (push(source, threat.target, send))
                        gap -= send;
                }
            }
            const counts = new Map();
            for (const id of ownIds) {
                const kind = nodes[id].kind;
                counts.set(kind, (counts.get(kind) ?? 0) + 1);
            }
            const estimateProduction = (kind) => {
                if (kind === 'home')
                    return 4;
                if (kind === 'foundry')
                    return 5;
                if (kind === 'watchtower')
                    return 2;
                return 2 + Math.floor(((counts.get(kind) ?? 0) + 1) / 2);
            };
            let weakest = -1;
            let weakestNodes = Infinity;
            let leader = -1;
            let leaderNodes = -1;
            for (const player of view.players) {
                if (player.id === me || !player.alive)
                    continue;
                if (player.nodes < weakestNodes) {
                    weakestNodes = player.nodes;
                    weakest = player.id;
                }
                if (player.nodes > leaderNodes) {
                    leaderNodes = player.nodes;
                    leader = player.id;
                }
            }
            const neutralBias = view.turn <= 25 ? 1.25 : 1;
            const enemyBias = view.turn <= 25 ? 0.75 : view.turn <= 80 ? 1 : 1.2;
            const pendingOwn = new Map();
            const pendingEnemy = new Map();
            for (const column of view.columns) {
                if (column.arriveTurn > view.turn)
                    continue;
                const target = column.path[column.path.length - 1];
                const map = column.owner === me ? pendingOwn : pendingEnemy;
                map.set(target, (map.get(target) ?? 0) + column.troops);
            }
            const targetSources = new Map();
            for (const id of ownIds) {
                for (const to of adj[id]) {
                    if (nodes[to].owner === me)
                        continue;
                    const list = targetSources.get(to);
                    if (list) {
                        if (!urgent.has(id))
                            list.push(id);
                    }
                    else {
                        targetSources.set(to, urgent.has(id) ? [] : [id]);
                    }
                }
            }
            const candidates = [];
            for (const [to, sources] of targetSources) {
                const node = nodes[to];
                if (node.owner !== NEUTRAL && node.troops === null)
                    continue;
                const defenders = node.troops ?? 0;
                const contested = adj[to].some((id) => nodes[id].owner !== me && nodes[id].owner !== NEUTRAL);
                const baseNeed = node.owner === NEUTRAL
                    ? defenders + (contested ? 3 : 2)
                    : node.kind === 'home'
                        ? defenders + 3
                        : defenders + 3;
                const ownAdd = pendingOwn.get(to) ?? 0;
                if (ownAdd >= baseNeed)
                    continue;
                const enemyAdd = pendingEnemy.get(to) ?? 0;
                const need = Math.max(1, baseNeed + enemyAdd - ownAdd);
                const available = sources.reduce((sum, id) => sum + free(id), 0);
                if (available < need)
                    continue;
                let value;
                if (node.kind === 'home') {
                    value = 360;
                }
                else {
                    value = estimateProduction(node.kind) * 3;
                    if (node.kind === 'foundry')
                        value += 8;
                    if (node.kind === 'watchtower')
                        value += 8;
                    value += adj[to].length * 0.5;
                    if (node.owner !== NEUTRAL)
                        value += 4;
                }
                value *= node.owner === NEUTRAL ? neutralBias : enemyBias;
                if (node.owner === weakest)
                    value *= 1.4;
                else if (node.owner === leader)
                    value *= 0.85;
                let score = (value * 10) / need;
                if (sources.length > 1)
                    score *= 1.05;
                candidates.push({ to, need, score, sources });
            }
            if (view.turn >= 90 && weakest >= 0) {
                for (const node of nodes) {
                    if (node.kind !== 'home' || node.owner !== weakest || node.troops !== null)
                        continue;
                    const sources = adj[node.id].filter((id) => own.has(id) && !urgent.has(id) && free(id) > 0);
                    const total = sources.reduce((sum, id) => sum + free(id), 0);
                    if (total < 25)
                        continue;
                    candidates.push({ to: node.id, need: 25, score: 180, sources });
                }
            }
            candidates.sort((a, b) => b.score - a.score);
            const used = new Set();
            for (const candidate of candidates) {
                if (orders.length >= maxOrders)
                    break;
                if (used.has(candidate.to))
                    continue;
                let need = candidate.need;
                const sources = candidate.sources
                    .map((id) => ({ id, free: free(id) }))
                    .filter((item) => item.free > 0)
                    .sort((a, b) => b.free - a.free);
                const total = sources.reduce((sum, item) => sum + item.free, 0);
                if (total < need)
                    continue;
                for (const source of sources) {
                    if (need <= 0 || orders.length >= maxOrders)
                        break;
                    const send = Math.min(need, free(source.id));
                    if (send < 1)
                        continue;
                    if (push(source.id, candidate.to, send))
                        need -= send;
                }
                if (need <= 0)
                    used.add(candidate.to);
            }
            if (orders.length < maxOrders && view.turn > 6) {
                const enemyDist = new Array(nodes.length).fill(Infinity);
                const queue = [];
                for (const node of nodes) {
                    if (node.owner === me || node.owner === NEUTRAL)
                        continue;
                    enemyDist[node.id] = 0;
                    queue.push(node.id);
                }
                for (let qi = 0; qi < queue.length; qi++) {
                    const u = queue[qi];
                    for (const v of adj[u]) {
                        if (enemyDist[v] === Infinity) {
                            enemyDist[v] = enemyDist[u] + 1;
                            queue.push(v);
                        }
                    }
                }
                const movers = ownIds
                    .map((id) => ({ id, extra: free(id) }))
                    .filter((item) => item.extra >= 4)
                    .sort((a, b) => b.extra - a.extra);
                for (const mover of movers) {
                    if (orders.length >= maxOrders)
                        break;
                    if (urgent.has(mover.id))
                        continue;
                    const targets = adj[mover.id]
                        .filter((id) => own.has(id) && !urgent.has(id) && enemyDist[id] < enemyDist[mover.id])
                        .sort((a, b) => enemyDist[a] - enemyDist[b]);
                    const best = targets[0];
                    if (best === undefined)
                        continue;
                    if (free(mover.id) >= 2)
                        push(mover.id, best, free(mover.id));
                }
            }
            return orders;
        },
    };
}
