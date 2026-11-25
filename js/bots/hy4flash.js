/**
 * 「hy4flash」投稿 bot（issue #8）：抢产扩军 · 协同斩首 · 可视防御。
 * 只专注单挑榜，不参与混战榜。
 */
/** 与引擎一致的寻路：可经己方/中立节点，终点可以是敌方节点。 */
function route(view, from, to) {
    if (from === to)
        return null;
    const n = view.nodes.length;
    const owner = view.nodes[from].owner;
    const prev = new Array(n).fill(-1);
    prev[from] = from;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (prev[v] !== -1)
                continue;
            if (v !== to) {
                const o = view.nodes[v].owner;
                if (o !== -1 && o !== owner)
                    continue;
            }
            prev[v] = u;
            if (v === to) {
                const path = [to];
                let cur = to;
                while (cur !== from) {
                    cur = prev[cur];
                    path.push(cur);
                }
                path.reverse();
                return { path, travel: Math.max(0, path.length - 2) };
            }
            queue.push(v);
        }
    }
    return null;
}
function distances(view, source) {
    const dist = new Array(view.nodes.length).fill(Infinity);
    dist[source] = 0;
    const queue = [source];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (dist[v] === Infinity) {
                dist[v] = dist[u] + 1;
                queue.push(v);
            }
        }
    }
    return dist;
}
function baseProduction(kind) {
    if (kind === 'home')
        return 4;
    if (kind === 'foundry')
        return 5;
    return 2;
}
/** 占领一个同类节点带来的每回合总产出增量（含同类协同）。 */
function marginalProduction(view, me, kind) {
    let count = 0;
    for (const node of view.nodes) {
        if (node.owner === me && node.kind === kind)
            count++;
    }
    const next = count + 1;
    let gain = baseProduction(kind);
    if (kind === 'farm' || kind === 'mine' || kind === 'lab') {
        gain += Math.floor(next / 2) + (next % 2 === 0 ? count : 0);
    }
    return gain;
}
export function createHy4Flash() {
    return {
        name: 'hy4flash',
        style: '抢产扩军 · 协同斩首 · 可视防御',
        decide(view) {
            const me = view.you;
            const orders = [];
            const budget = view.nodes.map((node) => (node.owner === me ? node.troops ?? 0 : 0));
            const usedPair = new Set();
            const distHome = distances(view, view.homeNode);
            let enemyHome = -1;
            for (const node of view.nodes) {
                if (node.kind === 'home' && node.owner !== me)
                    enemyHome = node.id;
            }
            const enemy = view.players.find((player) => player.id !== me);
            const enemyProduction = enemy?.production ?? 0;
            const enemyNodes = Math.max(1, enemy?.nodes ?? 1);
            const push = (from, to, troops) => {
                const amount = Math.floor(troops);
                if (amount < 1 || amount > budget[from])
                    return false;
                const key = `${from}>${to}`;
                if (usedPair.has(key))
                    return false;
                if (!route(view, from, to))
                    return false;
                budget[from] -= amount;
                usedPair.add(key);
                orders.push({ from, to, troops: amount });
                return true;
            };
            const enemyIncoming = (target, arrival) => {
                let sum = 0;
                for (const column of view.columns) {
                    if (column.owner === me)
                        continue;
                    if (column.path[column.path.length - 1] === target && column.arriveTurn <= arrival) {
                        sum += column.troops;
                    }
                }
                return sum;
            };
            const myIncoming = (target, arrival) => {
                let sum = 0;
                for (const column of view.columns) {
                    if (column.owner !== me)
                        continue;
                    if (column.path[column.path.length - 1] === target && column.arriveTurn <= arrival) {
                        sum += column.troops;
                    }
                }
                return sum;
            };
            const threats = new Map();
            for (const column of view.columns) {
                if (column.owner === me)
                    continue;
                const target = column.path[column.path.length - 1];
                if (view.nodes[target].owner !== me)
                    continue;
                const key = `${target}:${column.arriveTurn}`;
                const item = threats.get(key) ?? { target, arrival: column.arriveTurn, troops: 0 };
                item.troops += column.troops;
                threats.set(key, item);
            }
            const orderedThreats = [...threats.values()].sort((a, b) => {
                if (a.target === view.homeNode)
                    return -1;
                if (b.target === view.homeNode)
                    return 1;
                return a.arrival - b.arrival || a.target - b.target;
            });
            for (const threat of orderedThreats) {
                if (orders.length >= view.maxOrders)
                    break;
                const defense = (view.nodes[threat.target].troops ?? 0) + myIncoming(threat.target, threat.arrival);
                let need = threat.troops + 2 - defense;
                if (need <= 0)
                    continue;
                const helpers = [];
                for (const node of view.nodes) {
                    if (node.owner !== me || node.id === threat.target)
                        continue;
                    const spare = budget[node.id];
                    if (spare < 1)
                        continue;
                    const r = route(view, node.id, threat.target);
                    if (!r || r.travel > threat.arrival - view.turn)
                        continue;
                    helpers.push({ id: node.id, travel: r.travel, spare });
                }
                helpers.sort((a, b) => {
                    const penalty = (id) => (id === view.homeNode ? 2 : 0);
                    return a.travel + penalty(a.id) - (b.travel + penalty(b.id)) || b.spare - a.spare || a.id - b.id;
                });
                for (const helper of helpers) {
                    if (need <= 0 || orders.length >= view.maxOrders)
                        break;
                    const amount = Math.min(helper.spare, need);
                    if (push(helper.id, threat.target, amount))
                        need -= amount;
                }
            }
            // 2) 进攻/扩张：为每个目标挑一个「同回合到达」的最优兵力组合。
            const plans = [];
            const frontierRatio = Math.min(1, view.turn / 40);
            for (const target of view.nodes) {
                if (target.owner === me || orders.some((order) => order.to === target.id))
                    continue;
                const isEnemyHome = target.id === enemyHome;
                const visible = target.troops !== null;
                const guess = Math.max(3, Math.floor(enemyProduction / enemyNodes));
                const garrison = visible ? target.troops ?? 0 : Math.max(guess, 5);
                let value = marginalProduction(view, me, target.kind) * 2.8;
                if (target.owner !== -1)
                    value += (visible ? garrison : guess) * 0.3 + 10 + target.production;
                if (target.kind === 'foundry')
                    value += 14;
                if (target.kind === 'watchtower')
                    value += 6;
                value += Math.max(0, 6 - distHome[target.id]) * 0.35;
                if (Number.isFinite(distHome[enemyHome])) {
                    value += Math.max(0, distHome[enemyHome] - distHome[target.id]) * (0.5 + frontierRatio);
                }
                if (isEnemyHome)
                    value = 100000;
                // 敌方节点会随回合得到增援，远程攻打通常打不穿；只打相邻或一跳内的敌方节点。
                const maxTravel = target.owner === -1 ? 3 : isEnemyHome ? 0 : 1;
                for (let travel = 0; travel <= maxTravel; travel++) {
                    const arrival = view.turn + travel;
                    const required = garrison + enemyIncoming(target.id, arrival) + 1 + (target.owner === -1 ? 0 : 1);
                    const sources = [];
                    for (const source of view.nodes) {
                        if (source.owner !== me)
                            continue;
                        if (budget[source.id] < 1)
                            continue;
                        const r = route(view, source.id, target.id);
                        if (!r || r.travel !== travel)
                            continue;
                        sources.push({ id: source.id, spare: budget[source.id] });
                    }
                    if (sources.length === 0)
                        continue;
                    sources.sort((a, b) => b.spare - a.spare || a.id - b.id);
                    const extraCap = isEnemyHome ? 0 : target.kind === 'foundry' ? 10 : 6;
                    const moves = [];
                    let needLeft = required;
                    for (const source of sources) {
                        if (needLeft <= 0)
                            break;
                        const need = Math.min(source.spare, needLeft);
                        if (need < 1)
                            continue;
                        moves.push({ from: source.id, need, extra: 0 });
                        needLeft -= need;
                    }
                    if (needLeft > 0)
                        continue;
                    let extraLeft = extraCap;
                    for (const move of moves) {
                        const source = sources.find((item) => item.id === move.from);
                        const add = Math.min(source.spare - move.need, extraLeft);
                        move.extra = Math.max(0, add);
                        extraLeft -= move.extra;
                    }
                    const total = moves.reduce((sum, move) => sum + move.need + move.extra, 0);
                    const score = value / (total + 3) / (1 + travel * 0.9) - moves.length * 0.35;
                    plans.push({ target: target.id, moves, required, value, cost: total, travel, score });
                }
            }
            plans.sort((a, b) => b.score - a.score || a.target - b.target || a.travel - b.travel);
            // 先只承诺「刚好能拿下」的兵力，保证尽量多的目标同时起兵；再把余兵补给高价值目标。
            const committed = new Map();
            const claimed = new Set();
            const selected = [];
            for (const plan of plans) {
                if (orders.length + selected.reduce((sum, item) => sum + item.moves.length, 0) + plan.moves.length > view.maxOrders)
                    continue;
                if (claimed.has(plan.target))
                    continue;
                let ok = true;
                for (const move of plan.moves) {
                    if (budget[move.from] - (committed.get(move.from) ?? 0) < move.need) {
                        ok = false;
                        break;
                    }
                }
                if (!ok)
                    continue;
                for (const move of plan.moves) {
                    committed.set(move.from, (committed.get(move.from) ?? 0) + move.need);
                }
                claimed.add(plan.target);
                selected.push(plan);
            }
            const slack = new Map();
            for (const [id, need] of committed)
                slack.set(id, budget[id] - need);
            for (const plan of selected) {
                for (const move of plan.moves) {
                    const add = Math.min(move.extra, slack.get(move.from) ?? 0);
                    const amount = move.need + add;
                    slack.set(move.from, (slack.get(move.from) ?? 0) - add);
                    push(move.from, plan.target, amount);
                }
            }
            // 3) 余兵削城：打不下来也能把中立守军/敌军兵力打掉，为下回合创造 cheaper 的入口。
            if (orders.length < view.maxOrders) {
                const chips = [];
                for (const source of view.nodes) {
                    if (source.owner !== me || budget[source.id] < 4)
                        continue;
                    for (const target of view.nodes) {
                        if (target.owner === me || claimed.has(target.id))
                            continue;
                        const r = route(view, source.id, target.id);
                        if (!r || r.travel > (target.owner === -1 ? 2 : 1))
                            continue;
                        const defense = target.troops ?? Math.max(5, Math.floor(enemyProduction / enemyNodes));
                        if (defense < 2)
                            continue;
                        const troops = Math.min(budget[source.id] - 1, defense - 1);
                        if (troops < 1)
                            continue;
                        const kindBonus = target.kind === 'foundry' ? 3 : target.kind === 'watchtower' ? 1.5 : 1;
                        chips.push({
                            from: source.id,
                            to: target.id,
                            troops,
                            score: (kindBonus * troops) / (defense + 2) / (1 + r.travel),
                            travel: r.travel,
                        });
                    }
                }
                chips.sort((a, b) => b.score - a.score || a.from - b.from || a.to - b.to);
                for (const chip of chips) {
                    if (orders.length >= view.maxOrders)
                        break;
                    push(chip.from, chip.to, chip.troops);
                }
            }
            return orders.slice(0, view.maxOrders);
        },
    };
}
