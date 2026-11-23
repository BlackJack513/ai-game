import { NEUTRAL } from '../engine/types.js';
export const PARAMS = {
    horizon: 14,
    homeKeepMin: 2,
    homeKeepMax: 35,
    homeRampBase: 2,
    homeRampRate: 0.25,
    nearHomeFoeWeight: 0.8,
    earlyThreatFree: 6,
    homeDeter: 1.0,
    homeBuffer: 1,
    homeNearWeight: 0.5,
    frontierKeep: 1,
    frontierKeepMax: 20,
    frontierDeter: 0,
    interiorKeep: 1,
    maxMissions: 4,
    captureTravel: 2,
    missionMinScore: -6,
    travelValue: 1.5,
    ffaTravelValue: 12,
    posWeight: 3,
    foeProdWeight: 0.8,
    costWeight: 0.5,
    denyBonus: 24,
    killMargin: 4,
    flowMin: 4,
    mateValue: 0,
    contestBonus: 20,
    bidDecay: 0,
    contestRange: 3,
    cheapBonus: 0,
    foundryBid: 8,
    towerBid: 8,
    cheapBid: 8,
    hoardTurn: 125,
    unseenGrowth: 3,
    earlyHomeKeep: 3,
};
const KINDS = ['home', 'watchtower', 'foundry', 'farm', 'mine', 'lab'];
function bfsDist(adj, sources) {
    const n = adj.length;
    const d = new Array(n).fill(99);
    const q = [];
    for (const s of sources) {
        if (s < 0 || d[s] === 0)
            continue;
        d[s] = 0;
        q.push(s);
    }
    for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        for (const v of adj[u]) {
            if (d[v] > d[u] + 1) {
                d[v] = d[u] + 1;
                q.push(v);
            }
        }
    }
    return d;
}
function openDist(adj, source, passable) {
    const n = adj.length;
    const d = new Array(n).fill(99);
    d[source] = 0;
    const q = [source];
    for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        for (const v of adj[u]) {
            if (d[v] <= d[u] + 1)
                continue;
            if (!passable(v))
                continue;
            d[v] = d[u] + 1;
            q.push(v);
        }
    }
    return d;
}
export function createDshDeepseek() {
    const memory = { seen: new Map(), seenTurn: new Map(), lastTurn: -1, prevMine: new Set() };
    return {
        name: 'DSH DeepSeek',
        style: '贪婪征服 · 精简高效',
        decide(view) {
            return decideTurn(view, memory);
        },
    };
}
function decideTurn(view, memory) {
    const P = PARAMS;
    const n = view.nodes.length;
    const adj = view.adj;
    const you = view.you;
    const home = view.homeNode;
    const turn = view.turn;
    const owner = new Array(n).fill(NEUTRAL);
    const kind = new Array(n).fill('farm');
    const troops = new Array(n).fill(4);
    for (let i = 0; i < n; i++) {
        const nd = view.nodes[i];
        owner[i] = nd.owner;
        kind[i] = nd.kind;
        if (nd.troops !== null && nd.visible) {
            troops[i] = nd.troops;
            memory.seen.set(i, nd.troops);
            memory.seenTurn.set(i, turn);
        }
        else if (memory.seen.has(i)) {
            const last = memory.seen.get(i);
            const since = Math.max(0, turn - (memory.seenTurn.get(i) ?? turn));
            troops[i] = Math.min(60, last + P.unseenGrowth * since);
        }
        else {
            troops[i] = Math.min(60, 4 + P.unseenGrowth * turn);
        }
    }
    memory.lastTurn = turn;
    const mine = [];
    const foes = [];
    const neutrals = [];
    for (let i = 0; i < n; i++) {
        if (owner[i] === you)
            mine.push(i);
        else if (owner[i] === NEUTRAL)
            neutrals.push(i);
        else
            foes.push(i);
    }
    memory.prevMine = new Set(mine);
    const homeDist = bfsDist(adj, [home]);
    const foeHomes = [];
    for (let i = 0; i < n; i++)
        if (kind[i] === 'home' && owner[i] !== you && owner[i] !== NEUTRAL)
            foeHomes.push(i);
    let foeHomeId = foeHomes.length > 0 ? foeHomes[0] : -1;
    if (view.mode === 'ffa' && foeHomes.length > 1) {
        const scored = foeHomes.map((h) => ({ h, s: homeDist[h] * 1.2 + troops[h] * 0.7 })).sort((a, b) => a.s - b.s);
        foeHomeId = scored[0].h;
    }
    const countsMine = new Map();
    const countsFoe = new Map();
    for (const k of KINDS) {
        countsMine.set(k, 0);
        countsFoe.set(k, 0);
    }
    for (let i = 0; i < n; i++) {
        if (owner[i] === you)
            countsMine.set(kind[i], countsMine.get(kind[i]) + 1);
        else if (owner[i] !== NEUTRAL)
            countsFoe.set(kind[i], countsFoe.get(kind[i]) + 1);
    }
    const totalKind = (k, c) => {
        if (k === 'home')
            return 4 * c;
        if (k === 'foundry')
            return 5 * c;
        if (k === 'watchtower')
            return 2 * c;
        return c * (2 + Math.floor(c / 2));
    };
    const gainIfMine = (i) => {
        const k = kind[i];
        return totalKind(k, countsMine.get(k) + 1) - totalKind(k, countsMine.get(k));
    };
    const lossIfFoe = (i) => {
        const k = kind[i];
        const c = countsFoe.get(k);
        if (c <= 0)
            return 0;
        return totalKind(k, c) - totalKind(k, c - 1);
    };
    const kindBonus = (i) => {
        const k = kind[i];
        if (k === 'foundry')
            return 8;
        if (k === 'watchtower')
            return 4;
        return 0;
    };
    const structuralFoe = foeHomeId >= 0 ? bfsDist(adj, [foeHomeId]) : bfsDist(adj, foes);
    const distHome = homeDist;
    const foeReach = bfsDist(adj, foes);
    const maxAdv = Math.max(0, ...mine.map((i) => (structuralFoe[i] < 99 ? structuralFoe[i] : 0)));
    const adjFoeCnt = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        if (owner[i] !== you)
            continue;
        let c = 0;
        for (const j of adj[i])
            if (owner[j] !== you && owner[j] !== NEUTRAL)
                c++;
        adjFoeCnt[i] = c;
    }
    const enemyNow = new Array(n).fill(0);
    const enemyNext = new Array(n).fill(0);
    for (const col of view.columns) {
        if (col.owner === you)
            continue;
        const dest = col.path[col.path.length - 1];
        if (col.arriveTurn === turn)
            enemyNow[dest] += col.troops;
        else if (col.arriveTurn === turn + 1)
            enemyNext[dest] += col.troops;
    }
    // ---- 守备 ----
    let threatHome = enemyNow[home] + enemyNext[home];
    for (const col of view.columns) {
        if (col.owner === you)
            continue;
        const dest = col.path[col.path.length - 1];
        if (dest !== home)
            continue;
        const eta = col.arriveTurn - turn;
        if (eta <= 1)
            continue;
        threatHome += col.troops * (eta <= 3 ? 1 : 0.6);
    }
    for (let i = 0; i < n; i++) {
        if (owner[i] === you || owner[i] === NEUTRAL)
            continue;
        const d = distHome[i];
        if (d === 1)
            threatHome += troops[i];
        else if (d === 2)
            threatHome += troops[i] * P.homeNearWeight;
    }
    if (foeHomeId >= 0 && distHome[foeHomeId] <= 2)
        threatHome += troops[foeHomeId] * P.nearHomeFoeWeight;
    const homeKeepRaw = Math.ceil(threatHome * P.homeDeter) + P.homeBuffer;
    const homeKeep = Math.min(turn <= 8 && threatHome <= P.earlyThreatFree ? P.earlyHomeKeep : Number.MAX_SAFE_INTEGER, Math.max(P.homeKeepMin, Math.min(P.homeKeepMax, Math.max(0, homeKeepRaw)), Math.min(P.homeKeepMax, P.homeRampBase + turn * P.homeRampRate)));
    const adjFoeMax2 = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        if (owner[i] !== you)
            continue;
        let mx = 0;
        for (const j of adj[i])
            if (owner[j] !== you && owner[j] !== NEUTRAL && troops[j] > mx)
                mx = troops[j];
        adjFoeMax2[i] = mx;
    }
    const keep = new Array(n).fill(P.interiorKeep);
    for (const i of mine) {
        if (i === home)
            keep[i] = homeKeep;
        else if (adjFoeCnt[i] > 0) {
            keep[i] = Math.min(P.frontierKeepMax, Math.max(P.frontierKeep, Math.ceil(adjFoeMax2[i] * P.frontierDeter) + 1));
        }
    }
    const orders = [];
    const avail = troops.slice();
    const used = new Set();
    const canOrder = () => orders.length < 5;
    const routesCache = new Map();
    const openRoutes = (src) => {
        const hit = routesCache.get(src);
        if (hit)
            return hit;
        const d = openDist(adj, src, (i) => owner[i] === you || owner[i] === NEUTRAL);
        routesCache.set(src, d);
        return d;
    };
    const free = (i) => avail[i] - keep[i];
    const send = (from, to, amount, ignoreKeep = false) => {
        if (from === to)
            return 0;
        if (owner[from] !== you)
            return 0;
        if (!canOrder())
            return 0;
        const key = `${from}>${to}`;
        if (used.has(key))
            return 0;
        if (owner[to] === you || owner[to] === NEUTRAL) {
            if (openRoutes(from)[to] >= 99)
                return 0;
        }
        else if (!adj[from].includes(to)) {
            return 0;
        }
        const cap = Math.floor(ignoreKeep ? avail[from] - 1 : free(from));
        const give = Math.min(Math.floor(amount), cap);
        if (give < 1)
            return 0;
        used.add(key);
        avail[from] -= give;
        orders.push({ from, to, troops: give });
        return give;
    };
    // ---- A 斩首 ----
    if (foeHomeId >= 0) {
        const gar = troops[foeHomeId] + enemyNow[foeHomeId];
        const srcs = adj[foeHomeId].filter((j) => owner[j] === you && avail[j] > 0);
        const force = srcs.reduce((s, j) => s + avail[j], 0);
        if (force > gar + P.killMargin && force >= 10) {
            for (const s of srcs)
                send(s, foeHomeId, avail[s], true);
            if (orders.length > 0)
                return orders;
        }
    }
    // ---- B 守家 ----
    if (avail[home] < homeKeep) {
        const donors = adj[home]
            .filter((j) => owner[j] === you && j !== home && avail[j] > 1)
            .sort((a, b) => adjFoeCnt[a] - adjFoeCnt[b] || avail[b] - avail[a]);
        for (const d of donors) {
            if (avail[home] >= homeKeep)
                break;
            if (used.has(`${d}>${home}`))
                continue;
            send(d, home, Math.min(homeKeep - avail[home], avail[d] - 1), true);
        }
    }
    const missions = [];
    const triedTargets = new Set();
    const srcPool = (t, isFoe) => {
        const out = [];
        for (const s of mine) {
            if (isFoe) {
                if (!adj[t].includes(s))
                    continue;
            }
            else {
                const hops = openRoutes(s)[t];
                if (hops >= 99 || hops - 1 > P.captureTravel)
                    continue;
            }
            if (free(s) < 1)
                continue;
            out.push(s);
        }
        return out;
    };
    for (const t of neutrals) {
        const contested = structuralFoe[t] <= P.contestRange || adj[t].some((j) => owner[j] !== you && owner[j] !== NEUTRAL);
        const bidBonus = !contested
            ? P.cheapBonus
            : kind[t] === 'foundry'
                ? P.foundryBid
                : kind[t] === 'watchtower'
                    ? P.towerBid
                    : Math.max(P.cheapBid, P.contestBonus - turn * P.bidDecay);
        const need = troops[t] + 1 + bidBonus;
        const pool = srcPool(t, false);
        if (pool.length === 0)
            continue;
        const total = pool.reduce((a, s) => a + free(s), 0);
        if (total < need)
            continue;
        let bestTravel = 99;
        for (const s of pool)
            bestTravel = Math.min(bestTravel, openRoutes(s)[t] - 1);
        if (foeReach[t] + 1 < bestTravel)
            continue;
        const val = gainIfMine(t) * P.horizon * P.foeProdWeight + P.posWeight * (maxAdv - structuralFoe[t]) + kindBonus(t);
        const tv = view.mode === 'ffa' ? P.ffaTravelValue : P.travelValue;
        const score = val - need * (1 + P.costWeight) - bestTravel * tv - (bestTravel > 0 ? 2 : 0);
        if (score >= P.missionMinScore)
            missions.push({ to: t, need, score, srcs: pool });
    }
    for (const t of foes) {
        if (t === foeHomeId)
            continue;
        if (turn >= P.hoardTurn)
            continue;
        const wall = troops[t] + enemyNow[t];
        const need = wall + 1;
        const pool = srcPool(t, true);
        if (pool.length === 0)
            continue;
        const total = pool.reduce((a, s) => a + free(s), 0);
        if (total < need)
            continue;
        const val = (gainIfMine(t) + lossIfFoe(t)) * P.horizon * P.foeProdWeight +
            P.posWeight * (maxAdv - structuralFoe[t]) * 1.5 +
            P.denyBonus +
            kindBonus(t);
        const score = val - need * (1 + P.costWeight);
        if (score >= P.missionMinScore)
            missions.push({ to: t, need, score, srcs: pool, strict: true });
    }
    missions.sort((a, b) => b.score - a.score);
    const execute = (m) => {
        if (m.strict) {
            const pool = m.srcs.reduce((a, s) => a + Math.max(0, Math.floor(free(s))), 0);
            if (pool < m.need)
                return false;
        }
        let remain = m.need;
        const srcs = m.srcs.slice().sort((a, b) => free(b) - free(a));
        for (const s of srcs) {
            if (remain <= 0 || !canOrder())
                break;
            const give = Math.min(remain, Math.max(0, Math.floor(free(s))));
            if (give < 1)
                continue;
            const got = send(s, m.to, give);
            if (got > 0)
                remain -= got;
        }
        return remain <= 0;
    };
    let done = 0;
    for (const m of missions) {
        if (done >= P.maxMissions)
            break;
        if (triedTargets.has(m.to))
            continue;
        if (freeSpace(m.to) === 0)
            continue;
        if (execute(m)) {
            done++;
            triedTargets.add(m.to);
        }
    }
    function freeSpace(t) {
        return 100 - troops[t];
    }
    // ---- D 聚兵 ----
    let gate = -1;
    let gateScore = -Infinity;
    for (const i of mine) {
        if (i === home)
            continue;
        const s = -structuralFoe[i] * 10 + (structuralFoe[i] <= 2 ? 6 : 0) + adjFoeCnt[i] * 3 + (kind[i] === 'watchtower' ? 3 : 0);
        if (s > gateScore) {
            gateScore = s;
            gate = i;
        }
    }
    if (gate >= 0) {
        const donors = mine.filter((i) => i !== gate && i !== home && free(i) >= P.flowMin).sort((a, b) => free(b) - free(a));
        for (const d of donors) {
            if (!canOrder())
                break;
            if (used.has(`${d}>${gate}`))
                continue;
            if (adj[gate].includes(d) ? false : openRoutes(d)[gate] >= 99)
                continue;
            send(d, gate, free(d));
        }
    }
    return orders;
}
