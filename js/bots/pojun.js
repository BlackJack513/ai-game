/**
 * 「破军」—— 战将临阵，斩关刈城（issue #3 投稿，作者 @wztckx）
 *
 * 核心设计：
 * 1. 多线抢产：按产出、边境接触面与「离敌方老家的距离」给每个目标打分，
 *    倾向低代价、高产出的中立与敌方节点。
 * 2. 合兵攻家：观察到敌方老家时，单跳集火斩首权重最高，其余目标按需兵量折价。
 * 3. 同时刻结算推演：把在途纵队与预计到点时间并入 `incoming` / `evaluate`，
 *    避免只看静态兵力导致送兵。
 * 4. 老家守备按 0..3 回合威胁推演 `reserveHome`，前线节点只留 `guard` 级守军。
 * 5. 每回合生成多个候选计划，并用「对手同步推演」的简化副本评估，
 *    再尝试把单条指令改派到相邻战场做局部搜索。
 *
 * 严格纯函数：每次 decide 都由 view 重新推演，不保存任何跨回合状态。
 */
function plan(view, pressureBias = 12, guardFraction = 0, predicted = []) {
    const { nodes, adj, you, homeNode, turn } = view;
    const mine = nodes.filter((n) => n.owner === you);
    const enemies = nodes.filter((n) => n.owner >= 0 && n.owner !== you);
    const hostileHomes = enemies.filter((n) => n.kind === 'home' && n.owner === n.id);
    const left = nodes.map((n) => n.troops ?? (n.kind === 'home' ? 18 : 6));
    const routes = nodes.map((start) => {
        const d = nodes.map(() => Infinity);
        const queue = [start.id];
        d[start.id] = 0;
        for (let i = 0; i < queue.length; i++) {
            for (const v of adj[queue[i]]) {
                if (d[v] !== Infinity)
                    continue;
                d[v] = d[queue[i]] + 1;
                if (nodes[v].owner < 0 || nodes[v].owner === start.owner)
                    queue.push(v);
            }
        }
        return d;
    });
    const expected = [...left];
    for (const order of predicted) {
        expected[order.from] -= order.troops;
        if (routes[order.from][order.to] === 1 && nodes[order.from].owner === nodes[order.to].owner) {
            expected[order.to] += order.troops;
        }
    }
    const proximity = nodes.map((n) => Math.min(...hostileHomes.map((h) => routes[h.id][n.id])));
    const orders = [];
    const arrival = view.columns.map((c) => ({
        to: c.path[c.path.length - 1],
        at: c.arriveTurn - turn,
        owner: c.owner,
        troops: c.troops,
    }));
    function send(from, to, troops) {
        left[from] -= troops;
        orders.push({ from, to, troops });
        arrival.push({ to, at: routes[from][to] - 1, owner: you, troops });
    }
    // Only the largest opposing faction matters in a simultaneous battle.
    function incoming(to, at) {
        const totals = view.players.map(() => 0);
        for (const a of arrival)
            if (a.to === to && a.at <= at)
                totals[a.owner] += a.troops;
        const friendly = totals[you];
        totals[you] = 0;
        return Math.max(...totals) - friendly;
    }
    function reserveHome() {
        let reserve = 0;
        for (let k = 0; k <= 3; k++) {
            const threats = view.players.map(() => 0);
            for (const e of enemies) {
                const d = routes[e.id][homeNode] - 1;
                if (d <= k)
                    threats[e.owner] += left[e.id] * (d === 0 || k === 0 ? 1 : 0.75);
            }
            const recall = mine.reduce((s, n) => s + (n.id !== homeNode && routes[n.id][homeNode] <= k ? left[n.id] : 0), 0);
            reserve = Math.max(reserve, Math.max(...threats) + incoming(homeNode, k) - 4 * k - recall);
        }
        return Math.ceil(reserve);
    }
    for (let k = 0; k <= 3; k++) {
        const danger = view.players.map(() => 0);
        for (const e of enemies)
            if (routes[e.id][homeNode] === 1)
                danger[e.owner] += left[e.id];
        let deficit = incoming(homeNode, k) + Math.max(...danger) - left[homeNode] - k * 4;
        for (const n of [...mine].sort((a, b) => left[b.id] - left[a.id])) {
            if (deficit <= 0 || orders.length >= view.maxOrders)
                break;
            if (routes[n.id][homeNode] !== k + 1 || left[n.id] === 0)
                continue;
            const count = Math.min(left[n.id], deficit);
            send(n.id, homeNode, count);
            deficit -= count;
        }
    }
    // A frontier garrison protects both its production and the safe route behind it.
    function guard(id) {
        if (id === homeNode)
            return reserveHome();
        const adjacent = enemies.filter((e) => routes[e.id][id] === 1);
        const raid = Math.max(0, ...adjacent.map((e) => left[e.id]));
        return Math.min(view.mode === 'duel' ? 10 : 25, Math.ceil(Math.max(raid * guardFraction, incoming(id, 0))));
    }
    const taken = new Set();
    while (orders.length < view.maxOrders) {
        const homeReserve = reserveHome();
        const available = left.map((x, i) => Math.max(0, x - (i === homeNode ? homeReserve : guard(i))));
        let best = 0;
        let moves = [];
        for (const t of nodes) {
            if (t.owner === you || taken.has(t.id))
                continue;
            const kill = hostileHomes.some((h) => h.id === t.id);
            for (let hops = 1; hops <= 2 && turn + hops - 1 <= view.maxTurns; hops++) {
                const capacity = (id) => (kill && hops === 1 && id !== homeNode ? left[id] : available[id]);
                const donors = mine
                    .filter((n) => capacity(n.id) && routes[n.id][t.id] === hops)
                    .sort((a, b) => capacity(b.id) - capacity(a.id))
                    .slice(0, view.maxOrders - orders.length);
                if (!donors.length || arrival.some((a) => a.to === t.id && a.owner === you))
                    continue;
                const enemySupport = enemies.reduce((s, e) => s +
                    (e.id !== t.id && e.owner === t.owner && routes[e.id][t.id] <= hops ? left[e.id] : 0), 0);
                const threat = Math.max(0, ...enemies.filter((e) => e.id !== t.id && routes[e.id][t.id] <= hops).map((e) => left[e.id]));
                const defenders = Math.ceil(0.25 * left[t.id] + 0.75 * expected[t.id]);
                const need = Math.max(1, defenders +
                    1 +
                    incoming(t.id, hops - 1) +
                    (hops - 1) * t.production +
                    Math.ceil(enemySupport * (hops === 1 ? 0.08 : 0.62)) +
                    (t.owner < 0 && threat ? Math.min(threat, 3) : 0));
                const pool = donors.reduce((s, n) => s + capacity(n.id), 0);
                if (pool < need)
                    continue;
                const same = mine.filter((n) => n.kind === t.kind).length;
                const prod = t.kind === 'foundry'
                    ? 5
                    : t.kind === 'watchtower'
                        ? 2.5
                        : 2 + Math.floor((same + 1) / 2) + (same % 2 ? same : 0);
                const frontier = adj[t.id].filter((v) => nodes[v].owner !== you).length;
                const score = (kill
                    ? 10000 / hops
                    : (prod +
                        (t.owner >= 0 ? t.production * 1.4 : 0) +
                        0.55 * frontier +
                        pressureBias / Math.max(1, proximity[t.id])) /
                        (3 + need * 0.65 + (hops - 1) * 10));
                if (score <= best)
                    continue;
                best = score;
                let want = kill
                    ? pool
                    : Math.min(pool, need + Math.ceil(threat * (t.owner < 0 ? 0.15 : guardFraction)));
                moves = [];
                for (const d of donors) {
                    const troops = Math.min(want, capacity(d.id));
                    moves.push({ from: d.id, to: t.id, troops });
                    want -= troops;
                    if (!want)
                        break;
                }
            }
        }
        if (!moves.length)
            break;
        taken.add(moves[0].to);
        for (const m of moves)
            send(m.from, m.to, m.troops);
    }
    // Move surplus into contact. A newly captured node can spend its garrison next turn.
    const pressure = nodes.map((n) => Math.min(...enemies.map((e) => routes[n.id][e.id] + (hostileHomes.includes(e) ? 0 : 1))));
    for (const s of [...mine].sort((a, b) => left[b.id] - left[a.id])) {
        const spare = left[s.id] - guard(s.id);
        if (spare < 2)
            continue;
        const candidates = nodes
            .filter((t) => t.id !== s.id &&
            (t.owner === you || taken.has(t.id)) &&
            routes[s.id][t.id] < Infinity &&
            (pressure[t.id] < pressure[s.id] || proximity[t.id] < proximity[s.id]) &&
            left[t.id] < 90)
            .sort((a, b) => {
            const rank = (id) => Math.min(10, pressure[id]) * 2 +
                Math.min(10, proximity[id]) +
                routes[s.id][id] * 1.4 +
                left[id] / 70;
            return rank(a.id) - rank(b.id);
        });
        for (const t of candidates) {
            const existing = orders.find((o) => o.from === s.id && o.to === t.id);
            if (existing) {
                existing.troops += spare;
                left[s.id] -= spare;
                break;
            }
            if (orders.length < view.maxOrders) {
                send(s.id, t.id, spare);
                break;
            }
        }
    }
    return orders;
}
// Evaluate a simultaneous exchange twice: once against a mobile opponent and
// once against defenders holding position. Longer marches retain discounted value.
function evaluate(view, ours, rivals) {
    const { nodes, you, adj, homeNode } = view;
    const forces = nodes.map((n) => {
        const sides = Array(view.players.length + 1).fill(0);
        sides[n.owner + 1] = n.troops ?? (n.kind === 'home' ? 18 : 6);
        return sides;
    });
    let score = 0;
    for (const c of view.columns) {
        if (c.arriveTurn === view.turn)
            forces[c.path[c.path.length - 1]][c.owner + 1] += c.troops;
    }
    for (const o of [...ours, ...rivals]) {
        const owner = nodes[o.from].owner;
        forces[o.from][owner + 1] -= o.troops;
        if (adj[o.from].includes(o.to))
            forces[o.to][owner + 1] += o.troops;
        else if (owner === you) {
            score += o.troops * 0.8;
            if (nodes[o.to].owner !== you)
                score += Math.min(o.troops, nodes[o.to].troops ?? 6) * 0.3;
        }
    }
    const owners = [];
    const armies = [];
    for (const node of nodes) {
        const sides = forces[node.id];
        const top = Math.max(...sides);
        const first = sides.indexOf(top);
        const second = Math.max(0, ...sides.filter((_, i) => i !== first));
        owners.push(top === second ? node.owner : first - 1);
        armies.push(Math.min(100, top - second));
    }
    if (owners[homeNode] !== you)
        return -10000;
    const kindCounts = view.players.map(() => new Map());
    for (const n of nodes) {
        const counts = kindCounts[owners[n.id]];
        if (counts)
            counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    }
    for (const n of nodes) {
        const owner = owners[n.id];
        if (owner < 0)
            continue;
        const weight = owner === you ? 1 : view.mode === 'duel' ? -1 : -0.5;
        const count = kindCounts[owner].get(n.kind) ?? 0;
        const prod = n.kind === 'home' ? 4 : n.kind === 'foundry' ? 5 : n.kind === 'watchtower' ? 2 : 2 + Math.floor(count / 2);
        const nearEnemyHome = adj[n.id].some((v) => nodes[v].kind === 'home' && nodes[v].owner === v && nodes[v].owner !== owner);
        score += weight * (prod * 5 + 5 + armies[n.id] * (nearEnemyHome ? 1.55 : 1));
        if (n.kind === 'home' && n.owner === n.id && owner === you && n.owner !== you)
            score += 1000;
    }
    const nearby = view.players.map(() => 0);
    for (const v of adj[homeNode])
        if (owners[v] >= 0 && owners[v] !== you)
            nearby[owners[v]] += armies[v];
    return score - 3 * Math.max(0, Math.max(...nearby) - armies[homeNode]);
}
function decide(view) {
    const predicted = [];
    for (const rival of view.players) {
        if (!rival.alive || rival.id === view.you)
            continue;
        const home = view.nodes.find((n) => n.kind === 'home' && n.owner === rival.id && n.id === rival.id);
        if (home)
            predicted.push(...plan({ ...view, you: rival.id, homeNode: home.id }));
    }
    const candidates = [
        plan(view),
        plan(view, 3, 0.15),
        plan(view, 12, 0.1, predicted),
        plan(view, 35, 0.4, predicted),
    ];
    const score = (orders) => evaluate(view, orders, predicted) + 0.65 * evaluate(view, orders, []);
    const scores = candidates.map(score);
    let best = Math.max(...scores);
    const base = candidates[scores.indexOf(best)];
    let winner = base;
    // Try diverting one order to an adjacent fight. Other orders still execute,
    // so the comparison includes the opportunity cost of the abandoned mission.
    for (let slot = 0; slot <= base.length; slot++) {
        if (slot >= view.maxOrders)
            break;
        const rest = base.filter((_, i) => i !== slot);
        const spare = view.nodes.map((n) => n.troops ?? 0);
        for (const o of rest)
            spare[o.from] -= o.troops;
        for (const n of view.nodes) {
            if (n.owner !== view.you || spare[n.id] <= 0 || (slot < base.length && base[slot].from !== n.id))
                continue;
            for (const to of view.adj[n.id]) {
                if (rest.some((o) => o.from === n.id && o.to === to))
                    continue;
                const target = view.nodes[to];
                const minForce = target.owner === view.you ? spare[n.id] : (target.troops ?? 5) + 1;
                for (const troops of new Set([spare[n.id], Math.min(spare[n.id], minForce)])) {
                    const trial = [...rest, { from: n.id, to, troops }];
                    const value = score(trial);
                    if (value > best + 0.01) {
                        best = value;
                        winner = trial;
                    }
                }
            }
        }
    }
    return winner;
}
export function createPojun() {
    return { name: '破军', style: '多线抢产 · 合兵攻家', decide };
}
