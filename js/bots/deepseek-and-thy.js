import { NEUTRAL } from '../engine/types.js';
const CAP = 100;
const MAX_STRIKE_HOPS = 4;
function estimateOf(node) {
    if (node.troops !== null)
        return node.troops;
    if (node.kind === 'home')
        return 12;
    if (node.kind === 'foundry')
        return 10;
    if (node.kind === 'watchtower')
        return 8;
    return 7;
}
function combat(defender, garrison, arrivals) {
    const sides = new Map([[defender, garrison]]);
    for (const arrival of arrivals) {
        sides.set(arrival.owner, (sides.get(arrival.owner) ?? 0) + arrival.troops);
    }
    const entries = [...sides.entries()].sort((a, b) => b[1] - a[1]);
    const max = entries[0][1];
    if (entries.filter((entry) => entry[1] === max).length > 1) {
        return { owner: defender, troops: 0 };
    }
    const second = entries.length > 1 ? entries[1][1] : 0;
    return { owner: entries[0][0], troops: Math.min(CAP, entries[0][1] - second) };
}
function bfsBlocked(view, from) {
    const n = view.nodes.length;
    const dist = new Array(n).fill(Infinity);
    dist[from] = 0;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        if (u !== from) {
            const owner = view.nodes[u].owner;
            if (owner !== NEUTRAL && owner !== view.you)
                continue;
        }
        for (const v of view.adj[u]) {
            if (dist[v] !== Infinity)
                continue;
            dist[v] = dist[u] + 1;
            queue.push(v);
        }
    }
    return dist;
}
function bfsFree(view, sources) {
    const dist = new Array(view.nodes.length).fill(Infinity);
    const queue = [];
    for (const source of sources) {
        dist[source] = 0;
        queue.push(source);
    }
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (dist[v] !== Infinity)
                continue;
            dist[v] = dist[u] + 1;
            queue.push(v);
        }
    }
    return dist;
}
function productionOf(view, owner, id, counts) {
    const kind = view.nodes[id].kind;
    if (kind === 'home')
        return 4;
    if (kind === 'foundry')
        return 5;
    if (kind === 'watchtower')
        return 2;
    if (owner === view.you)
        return 2 + Math.floor((counts[kind] ?? 0) / 2);
    return view.nodes[id].production > 0 ? view.nodes[id].production : 2;
}
function targetValue(view, id, counts) {
    const node = view.nodes[id];
    const exposed = node.troops !== null ? Math.max(0, 10 - node.troops) * 6 : 0;
    if (node.kind === 'home')
        return 1000;
    if (node.kind === 'foundry')
        return 140 + exposed;
    if (node.kind === 'watchtower')
        return 110 + exposed;
    return 40 + (counts[node.kind] ?? 0) * 8 + node.production * 5 + exposed;
}
function fallback(view) {
    const orders = [];
    for (const node of view.nodes) {
        if (orders.length >= view.maxOrders)
            break;
        if (node.owner !== view.you)
            continue;
        const spare = (node.troops ?? 0) - 1;
        if (spare < 1)
            continue;
        let best = null;
        for (const id of view.adj[node.id]) {
            const target = view.nodes[id];
            if (target.owner !== NEUTRAL)
                continue;
            const need = estimateOf(target) + 1;
            if (need > spare)
                continue;
            if (!best || target.production > best.production)
                best = target;
        }
        if (best)
            orders.push({ from: node.id, to: best.id, troops: estimateOf(best) + 1 });
    }
    return orders;
}
function plan(view) {
    const n = view.nodes.length;
    const me = view.you;
    const now = view.turn;
    const home = view.homeNode;
    const myIds = [];
    for (const node of view.nodes)
        if (node.owner === me)
            myIds.push(node.id);
    if (myIds.length === 0)
        return [];
    const hopsFrom = new Map();
    for (const id of myIds)
        hopsFrom.set(id, bfsBlocked(view, id));
    const hop = (from, to) => {
        const dist = hopsFrom.get(from)?.[to];
        if (dist === undefined || !Number.isFinite(dist) || dist <= 0)
            return Infinity;
        return dist - 1;
    };
    const minHop = (to) => {
        let best = Infinity;
        for (const id of myIds)
            best = Math.min(best, hop(id, to));
        return best;
    };
    const counts = { farm: 0, mine: 0, lab: 0 };
    for (const id of myIds) {
        const kind = view.nodes[id].kind;
        if (counts[kind] !== undefined)
            counts[kind]++;
    }
    const used = new Array(n).fill(0);
    const orders = [];
    const troopsOf = (id) => view.nodes[id].owner === me ? view.nodes[id].troops ?? 0 : 0;
    const capacity = (id, keep) => Math.max(0, troopsOf(id) - used[id] - keep);
    const enemyAdjMax = (id) => {
        let max = 0;
        for (const v of view.adj[id]) {
            const node = view.nodes[v];
            if (node.owner >= 0 && node.owner !== me)
                max = Math.max(max, estimateOf(node));
        }
        return max;
    };
    const isFront = (id) => view.adj[id].some((v) => {
        const owner = view.nodes[v].owner;
        return owner >= 0 && owner !== me;
    });
    const isGate = (id) => view.adj[id].includes(home);
    const homeDist = bfsFree(view, [home]);
    const isNearTower = (id) => view.nodes[id].kind === 'watchtower' && homeDist[id] <= 2;
    const incomingHome = view.columns
        .filter((column) => column.owner !== me && column.path[column.path.length - 1] === home)
        .reduce((sum, column) => sum + column.troops, 0);
    const keepOf = (id) => {
        const adj = enemyAdjMax(id);
        const quiet = now <= 12 && adj === 0 && incomingHome === 0;
        let base;
        if (id === home) {
            base = quiet ? 3 : Math.max(8, Math.min(20, 8 + adj * 0.5));
        }
        else if (quiet) {
            base = 1;
        }
        else if (isNearTower(id)) {
            base = Math.max(3, Math.min(12, 3 + adj * 0.4));
        }
        else if (isGate(id)) {
            base = Math.max(3, Math.min(14, 3 + adj * 0.6));
        }
        else if (isFront(id)) {
            base = Math.max(3, Math.min(10, 3 + adj * 0.4));
        }
        else {
            base = 1;
        }
        const incoming = view.columns.some((column) => column.owner !== me && column.path[column.path.length - 1] === id);
        return incoming ? Math.max(base, troopsOf(id)) : base;
    };
    const inboundOwn = new Array(n).fill(0);
    for (const column of view.columns) {
        if (column.owner === me) {
            inboundOwn[column.path[column.path.length - 1]] += column.troops;
        }
    }
    const usedIncoming = new Array(n).fill(0);
    const targetRoom = (id) => Math.max(0, CAP - (view.nodes[id].troops ?? 0) - inboundOwn[id] - usedIncoming[id]);
    const send = (from, to, amount, keep) => {
        if (orders.length >= view.maxOrders)
            return false;
        if (from === to || view.nodes[from].owner !== me)
            return false;
        if (orders.some((order) => order.from === from && order.to === to))
            return false;
        if (!Number.isFinite(hop(from, to)))
            return false;
        let value = Math.min(Math.floor(amount), capacity(from, keep));
        if (view.nodes[to].owner === me)
            value = Math.min(value, targetRoom(to));
        if (value < 1)
            return false;
        orders.push({ from, to, troops: value });
        used[from] += value;
        if (view.nodes[to].owner === me)
            usedIncoming[to] += value;
        return true;
    };
    const enemyIds = [];
    for (const node of view.nodes) {
        if (node.owner >= 0 && node.owner !== me)
            enemyIds.push(node.id);
    }
    const myPlayer = view.players[me];
    const enemyPlayer = view.players.find((player) => player.id !== me && player.alive);
    const enemyEconomyLead = enemyPlayer !== undefined &&
        (enemyPlayer.nodes >= myPlayer.nodes + 2 ||
            enemyPlayer.production >= myPlayer.production + 6);
    const enemyHomes = view.nodes
        .filter((node) => node.kind === 'home' && node.owner >= 0 && node.owner !== me)
        .map((node) => node.id);
    const enemyHome = enemyHomes.length > 0 ? enemyHomes[0] : -1;
    let axisFoe = -1;
    if (enemyEconomyLead && enemyHome >= 0) {
        const freeDist = new Array(n).fill(Infinity);
        const freeNext = new Array(n).fill(-1);
        freeDist[enemyHome] = 0;
        const queue = [enemyHome];
        for (let qi = 0; qi < queue.length; qi++) {
            const u = queue[qi];
            for (const v of view.adj[u]) {
                if (freeDist[v] !== Infinity)
                    continue;
                freeDist[v] = freeDist[u] + 1;
                freeNext[v] = u;
                queue.push(v);
            }
        }
        let axisFoeCount = Infinity;
        let axisDist = Infinity;
        for (const source of myIds) {
            if (!Number.isFinite(freeDist[source]))
                continue;
            let cur = source;
            const foes = [];
            let guard = 0;
            while (cur !== enemyHome && guard++ < n) {
                cur = freeNext[cur];
                if (cur < 0)
                    break;
                if (cur !== enemyHome && view.nodes[cur].owner >= 0 && view.nodes[cur].owner !== me) {
                    foes.push(cur);
                }
            }
            if (cur !== enemyHome)
                continue;
            if (foes.length < axisFoeCount ||
                (foes.length === axisFoeCount && freeDist[source] < axisDist)) {
                axisFoe = foes.length > 0 ? foes[0] : enemyHome;
                axisFoeCount = foes.length;
                axisDist = freeDist[source];
            }
        }
    }
    const distFromEnemies = enemyIds.length > 0 ? bfsFree(view, enemyIds) : new Array(n).fill(Infinity);
    const threat = new Array(n).fill(0);
    const threatDelay = new Array(n).fill(Infinity);
    for (const column of view.columns) {
        if (column.owner === me)
            continue;
        const target = column.path[column.path.length - 1];
        if (view.nodes[target].owner !== me)
            continue;
        threat[target] += column.troops;
        threatDelay[target] = Math.min(threatDelay[target], column.arriveTurn - now);
    }
    const predictAt = (target, until, extra) => {
        let owner = view.nodes[target].owner;
        let troops = estimateOf(view.nodes[target]);
        const events = [];
        for (const column of view.columns) {
            if (column.path[column.path.length - 1] !== target)
                continue;
            if (column.arriveTurn > until || column.arriveTurn < now)
                continue;
            events.push({ arrive: column.arriveTurn, owner: column.owner, troops: column.troops });
        }
        for (const event of extra) {
            if (event.arrive <= until && event.arrive >= now)
                events.push(event);
        }
        events.sort((a, b) => a.arrive - b.arrive);
        let last = now;
        let index = 0;
        while (index < events.length) {
            const arrive = events[index].arrive;
            if (arrive > last && owner !== NEUTRAL) {
                troops = Math.min(CAP, troops + productionOf(view, owner, target, counts) * (arrive - last));
            }
            const group = [];
            while (index < events.length && events[index].arrive === arrive) {
                group.push({ owner: events[index].owner, troops: events[index].troops });
                index++;
            }
            const result = combat(owner, troops, group);
            owner = result.owner;
            troops = result.troops;
            last = arrive;
        }
        if (until > last && owner !== NEUTRAL) {
            troops = Math.min(CAP, troops + productionOf(view, owner, target, counts) * (until - last));
        }
        return { owner, troops };
    };
    const deficits = [];
    for (const id of myIds) {
        const need = Math.max(0, Math.max(threat[id] + 1, enemyAdjMax(id) + 1) - troopsOf(id));
        if (need > 0)
            deficits.push({ id, need, urgent: id === home, gate: isGate(id) });
    }
    deficits.sort((a, b) => {
        const rank = (item) => item.urgent ? 2 : item.gate ? 1 : 0;
        return rank(b) - rank(a) || b.need - a.need;
    });
    for (const deficit of deficits) {
        if (orders.length >= 2)
            break;
        if (!deficit.urgent && !deficit.gate && deficit.need > 12)
            continue;
        if (deficit.gate && deficit.need > 24)
            continue;
        const sources = myIds
            .filter((source) => source !== deficit.id && hop(source, deficit.id) <= (deficit.urgent ? 2 : 1))
            .sort((a, b) => hop(a, deficit.id) - hop(b, deficit.id) ||
            capacity(b, keepOf(b)) - capacity(a, keepOf(a)));
        let remaining = deficit.need + 1;
        for (const source of sources) {
            if (remaining <= 0 || orders.length >= view.maxOrders)
                break;
            const keep = deficit.urgent
                ? Math.min(keepOf(source), 2)
                : deficit.gate
                    ? Math.min(keepOf(source), source === home ? 6 : 2)
                    : keepOf(source);
            const amount = Math.min(remaining, capacity(source, keep));
            if (amount >= 1 && send(source, deficit.id, amount, keep))
                remaining -= amount;
        }
    }
    const inFlight = new Map();
    for (const column of view.columns) {
        if (column.owner !== me)
            continue;
        const target = column.path[column.path.length - 1];
        const list = inFlight.get(target) ?? [];
        let wave = list.find((entry) => entry.arriveTurn === column.arriveTurn);
        if (!wave) {
            wave = { arriveTurn: column.arriveTurn, troops: 0, sources: new Set() };
            list.push(wave);
        }
        wave.troops += column.troops;
        wave.sources.add(column.path[0]);
        inFlight.set(target, list);
    }
    for (const list of inFlight.values())
        list.sort((a, b) => a.arriveTurn - b.arriveTurn);
    const enemyTargets = view.nodes
        .filter((node) => node.owner >= 0 && node.owner !== me && node.troops !== null)
        .map((node) => ({
        id: node.id,
        value: targetValue(view, node.id, counts),
        sources: myIds
            .map((source) => ({
            id: source,
            h: hop(source, node.id),
            cap: capacity(source, keepOf(source)),
        }))
            .filter((entry) => Number.isFinite(entry.h) && entry.h <= MAX_STRIKE_HOPS && entry.cap > 0),
    }))
        .filter((entry) => entry.sources.length > 0)
        .sort((a, b) => b.value - a.value);
    let strikePlans = 0;
    const counterTargets = view.nodes
        .filter((node) => node.owner >= 0 &&
        node.owner !== me &&
        node.troops !== null &&
        node.troops <= 5)
        .map((node) => ({
        node,
        sources: myIds
            .map((source) => ({
            id: source,
            h: hop(source, node.id),
            cap: capacity(source, keepOf(source)),
        }))
            .filter((entry) => Number.isFinite(entry.h) && entry.h <= 2 && entry.cap > 0)
            .sort((a, b) => a.h - b.h || b.cap - a.cap),
    }))
        .filter((entry) => entry.sources.length > 0)
        .sort((a, b) => (a.node.troops ?? 0) - (b.node.troops ?? 0) ||
        targetValue(view, b.node.id, counts) - targetValue(view, a.node.id, counts));
    for (const target of counterTargets) {
        if (orders.length >= view.maxOrders)
            break;
        if (strikePlans >= 3)
            break;
        const garrison = target.node.troops ?? 0;
        const need = garrison + 1 + Math.min(2, enemyAdjMax(target.node.id) * 0.2);
        const minH = target.sources[0].h;
        const due = target.sources.filter((entry) => entry.h === minH);
        const dueCap = due.reduce((sum, entry) => sum + entry.cap, 0);
        if (dueCap < need)
            continue;
        let missing = need;
        let sent = 0;
        for (const entry of due) {
            if (missing <= 0 || orders.length >= view.maxOrders)
                break;
            const keep = keepOf(entry.id);
            const amount = Math.min(missing, capacity(entry.id, keep));
            if (amount >= 1 && send(entry.id, target.node.id, amount, keep)) {
                missing -= amount;
                sent += amount;
            }
        }
        if (sent > 0)
            strikePlans++;
    }
    if (axisFoe >= 0 &&
        axisFoe !== enemyHome &&
        strikePlans < 3 &&
        !deficits.some((deficit) => deficit.urgent) &&
        view.nodes[axisFoe].troops !== null) {
        const garrison = view.nodes[axisFoe].troops ?? 0;
        const required = garrison + 1 + Math.min(6, 2 + enemyAdjMax(axisFoe) * 0.3);
        if (required <= 40) {
            const sources = myIds
                .map((source) => ({
                id: source,
                h: hop(source, axisFoe),
                cap: capacity(source, keepOf(source)),
            }))
                .filter((entry) => Number.isFinite(entry.h) && entry.h <= 2 && entry.cap > 0)
                .sort((a, b) => a.h - b.h || b.cap - a.cap);
            if (sources.length > 0) {
                const minH = sources[0].h;
                const due = sources.filter((entry) => entry.h === minH);
                const dueCap = due.reduce((sum, entry) => sum + entry.cap, 0);
                if (dueCap >= required) {
                    let missing = required;
                    let sent = 0;
                    for (const entry of due) {
                        if (missing <= 0 || orders.length >= view.maxOrders)
                            break;
                        const keep = keepOf(entry.id);
                        const amount = Math.min(missing, capacity(entry.id, keep));
                        if (amount >= 1 && send(entry.id, axisFoe, amount, keep)) {
                            missing -= amount;
                            sent += amount;
                        }
                    }
                    if (sent > 0)
                        strikePlans++;
                }
            }
        }
    }
    for (const target of enemyTargets) {
        if (orders.length >= view.maxOrders)
            break;
        if (strikePlans >= 2)
            break;
        if (now <= 5 || target.value < 55)
            continue;
        if (myIds.length < enemyIds.length * 0.8 && target.value < 150)
            continue;
        const waves = inFlight.get(target.id) ?? [];
        const active = waves.find((entry) => entry.arriveTurn >= now);
        const known = active?.sources ?? new Set();
        const minH = Math.min(...target.sources.map((entry) => entry.h));
        const maxH = Math.max(...target.sources.map((entry) => entry.h));
        let arriveTurn = active ? active.arriveTurn : now + maxH;
        if (!active && minH < maxH) {
            const fastTurn = now + minH;
            const fastPrediction = predictAt(target.id, fastTurn, []);
            const fastPotential = target.sources
                .filter((entry) => entry.h <= minH)
                .reduce((sum, entry) => sum + entry.cap, 0);
            if (fastPrediction.owner !== me && fastPrediction.troops + 1 + 3 <= fastPotential) {
                arriveTurn = fastTurn;
            }
        }
        if (arriveTurn < now)
            continue;
        const prediction = predictAt(target.id, arriveTurn, []);
        if (prediction.owner === me)
            continue;
        const targetKind = view.nodes[target.id].kind;
        const due = target.sources
            .filter((entry) => !known.has(entry.id) &&
            arriveTurn - entry.h === now &&
            capacity(entry.id, keepOf(entry.id)) > 0)
            .sort((a, b) => b.cap - a.cap);
        const dueCap = due.reduce((sum, entry) => sum + entry.cap, 0);
        const margin = Math.min(8, 2 + enemyAdjMax(target.id) * 0.3);
        const required = prediction.troops + 1 + margin + (targetKind === 'home' ? 5 : 0);
        if (targetKind !== 'home' && required > 40)
            continue;
        if (dueCap < required)
            continue;
        let missing = required;
        let sent = 0;
        for (const entry of due) {
            if (missing <= 0 || orders.length >= view.maxOrders)
                break;
            const keep = keepOf(entry.id);
            const amount = Math.min(missing, capacity(entry.id, keep));
            if (amount >= 1 && send(entry.id, target.id, amount, keep)) {
                missing -= amount;
                sent += amount;
            }
        }
        if (sent > 0)
            strikePlans++;
    }
    const neutralTargets = view.nodes
        .filter((node) => node.owner === NEUTRAL)
        .map((node) => ({ node, h: minHop(node.id) }))
        .filter((entry) => Number.isFinite(entry.h) && entry.h <= (now <= 8 ? 2 : 3))
        .map((entry) => {
        const need = (() => {
            let value = estimateOf(entry.node) + 1;
            const near = distFromEnemies[entry.node.id];
            if (near <= entry.h)
                value += 4;
            else if (near <= entry.h + 1)
                value += 1;
            return value;
        })();
        const cluster = counts[entry.node.kind] !== undefined ? counts[entry.node.kind] * 6 : 0;
        const kindBonus = entry.node.kind === 'foundry' ? 35 : entry.node.kind === 'watchtower' ? 32 : 0;
        const danger = distFromEnemies[entry.node.id] <= 2 && kindBonus === 0 ? -12 : 0;
        const score = entry.node.production * 8 +
            kindBonus +
            cluster +
            (entry.h === 0 ? 12 : 0) -
            entry.h * 8 -
            need * 1.5 +
            danger;
        return { id: entry.node.id, h: entry.h, need, score };
    })
        .sort((a, b) => b.score - a.score);
    for (const target of neutralTargets) {
        if (orders.length >= view.maxOrders)
            break;
        const sources = myIds
            .filter((source) => hop(source, target.id) === target.h && capacity(source, keepOf(source)) > 0)
            .sort((a, b) => capacity(b, keepOf(b)) - capacity(a, keepOf(a)));
        if (sources.length === 0)
            continue;
        const single = sources.find((source) => capacity(source, keepOf(source)) >= target.need);
        if (single !== undefined) {
            send(single, target.id, target.need, keepOf(single));
            continue;
        }
        const total = sources.reduce((sum, source) => sum + capacity(source, keepOf(source)), 0);
        if (total < target.need)
            continue;
        let gathered = 0;
        for (const source of sources) {
            if (gathered >= target.need || orders.length >= view.maxOrders)
                break;
            const keep = keepOf(source);
            const amount = Math.min(target.need - gathered, capacity(source, keep));
            if (amount >= 1 && send(source, target.id, amount, keep))
                gathered += amount;
        }
    }
    if (orders.length < view.maxOrders) {
        const gateIds = myIds.filter((id) => id !== home && isGate(id));
        const frontIds = myIds.filter((id) => id !== home && isFront(id));
        const anchorIds = [...new Set([...gateIds, ...frontIds])];
        const anchors = anchorIds
            .map((id) => ({
            id,
            need: Math.max(0, keepOf(id) - troopsOf(id) - inboundOwn[id]) *
                (isGate(id) ? 1.5 : 1),
            room: targetRoom(id),
        }))
            .filter((entry) => entry.room > 0 && entry.need > 0)
            .sort((a, b) => b.need - a.need);
        if (anchors.length === 0 && enemyIds.length > 0) {
            let best = -1;
            let bestDist = Infinity;
            for (const id of myIds) {
                if (id === home)
                    continue;
                if (targetRoom(id) > 0 && distFromEnemies[id] < bestDist) {
                    bestDist = distFromEnemies[id];
                    best = id;
                }
            }
            if (best >= 0)
                anchors.push({ id: best, need: 1, room: targetRoom(best) });
        }
        if (anchors.length > 0) {
            const rear = myIds
                .filter((id) => id !== home &&
                !isFront(id) &&
                capacity(id, keepOf(id)) >= 3)
                .sort((a, b) => capacity(b, keepOf(b)) - capacity(a, keepOf(a)));
            for (const id of rear) {
                if (orders.length >= view.maxOrders)
                    break;
                let bestAnchor = -1;
                let bestScore = Infinity;
                for (const anchor of anchors) {
                    if (anchor.id === id || anchor.room <= 0)
                        continue;
                    const h = hop(id, anchor.id);
                    if (!Number.isFinite(h))
                        continue;
                    const score = h * 12 - anchor.need;
                    if (score < bestScore) {
                        bestScore = score;
                        bestAnchor = anchor.id;
                    }
                }
                if (bestAnchor < 0)
                    continue;
                const keep = keepOf(id);
                const amount = capacity(id, keep);
                if (amount >= 1 && send(id, bestAnchor, amount, keep))
                    break;
            }
        }
    }
    return orders;
}
export function createDeepseekAndThy() {
    return {
        name: 'deepseekAndThy',
        style: '经济冲刺 · 跨回合合击',
        decide(view) {
            if (view.mode !== 'duel')
                return fallback(view);
            try {
                return plan(view);
            }
            catch {
                return [];
            }
        },
    };
}
