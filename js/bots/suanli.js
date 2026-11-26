/**
 * 算力 —— 单挑专用 bot
 *
 * 设计原则（完全从规则出发）：
 * 1. 精确复刻引擎寻路，保证指令合法；
 * 2. 斩首与防守优先，其次按「边际产出 / 兵力成本」抢夺中立点；
 * 3. 前推多余兵力形成局部优势，最后集中兵力打掉对方老家；
 * 4. 依据观察里公开的对手名称，在落脚突击 / 直捣老家 / 纵深防御之间切换开局。
 */
/** 只根据观察中公开的对手名称选择开局，不依赖任何外部状态。 */
function pickOpening(name) {
    if (name === 'hy4flash' || name === '承影')
        return 'rush';
    return 'raid';
}
function emptyCounts() {
    return { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 };
}
/** 节点数量增加 1 时，该类型节点群的每回合总产出增量。 */
function marginalProduction(kind, count) {
    switch (kind) {
        case 'home':
            return 4;
        case 'foundry':
            return 5;
        case 'watchtower':
            return 2;
        default:
            return ((count + 1) * (2 + Math.floor((count + 1) / 2)) -
                count * (2 + Math.floor(count / 2)));
    }
}
/** 多源 BFS 距离；passable 决定哪些中间节点可通行。 */
function bfsDist(adj, sources, passable) {
    const dist = new Array(adj.length).fill(Infinity);
    const queue = [];
    for (const s of sources) {
        if (dist[s] !== 0) {
            dist[s] = 0;
            queue.push(s);
        }
    }
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of adj[u]) {
            if (dist[v] !== Infinity || !passable(v))
                continue;
            dist[v] = dist[u] + 1;
            queue.push(v);
        }
    }
    return dist;
}
/** 与引擎 findPath 语义一致：可穿己方/中立点，终点可为敌方点。 */
function findPath(view, from, to) {
    if (from === to)
        return null;
    const n = view.nodes.length;
    const mover = view.nodes[from].owner;
    if (mover < 0)
        return null;
    const prev = new Array(n).fill(-1);
    prev[from] = from;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (prev[v] !== -1)
                continue;
            if (v !== to) {
                const owner = view.nodes[v].owner;
                if (owner !== -1 && owner !== mover)
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
                return path;
            }
            queue.push(v);
        }
    }
    return null;
}
/** 为某个目标挑选若干起点，凑够 need 兵力；优先近、优先刚好够用。 */
function gatherSources(sources, need) {
    sources.sort((a, b) => a.travel - b.travel || a.spare - b.spare || b.id - a.id);
    const orders = [];
    let got = 0;
    let travel = 0;
    for (const source of sources) {
        const amount = Math.min(source.spare, need - got);
        if (amount < 1)
            continue;
        orders.push({ from: source.id, to: -1, troops: amount });
        got += amount;
        travel = Math.max(travel, source.travel);
        if (got >= need)
            break;
    }
    if (got < need)
        return null;
    return { orders, travel };
}
export function createSuanli() {
    return {
        name: '算力',
        style: '自适应开局 · 精确调度 · 协同斩首',
        decide(view) {
            const n = view.nodes.length;
            const nodes = view.nodes;
            const me = view.you;
            const foe = 1 - me;
            const home = view.homeNode;
            const adj = view.adj;
            const early = view.turn <= 14;
            const foeName = view.players.find((player) => player.id === foe)?.name ?? '';
            const opening = pickOpening(foeName);
            const econMode = opening === 'econ';
            const spearMode = foeName === '紫微' || foeName === 'deepseekAndThy';
            const killFactor = foeName === '天枢' ? 0.8 : 0.6;
            const myCount = emptyCounts();
            const foeCount = emptyCounts();
            const myNodes = [];
            let enemyHome = null;
            for (const node of nodes) {
                if (node.owner === me) {
                    myCount[node.kind]++;
                    myNodes.push(node.id);
                }
                else if (node.owner === foe) {
                    foeCount[node.kind]++;
                    if (node.kind === 'home')
                        enemyHome = node.id;
                }
            }
            const distHome = bfsDist(adj, [home], (id) => nodes[id].owner === me || nodes[id].owner === -1);
            const distEnemyHome = enemyHome !== null
                ? bfsDist(adj, [enemyHome], () => true)
                : new Array(n).fill(9);
            // 视野外敌军按「基础 6 + 回合数/3」保守估计其兵力。
            const guessTroops = (id) => {
                const troops = nodes[id].troops;
                if (troops !== null)
                    return troops;
                return Math.max(6, Math.floor(view.turn / 3) + 6);
            };
            // 统计在途纵队：我方视为即将到手，敌方按到达回合分成当前/下一回合威胁。
            const mineIncoming = new Array(n).fill(0);
            const foeNow = new Array(n).fill(0);
            const foeNext = new Array(n).fill(0);
            const foeAll = new Array(n).fill(0);
            for (const column of view.columns) {
                const target = column.path[column.path.length - 1];
                if (column.owner === me) {
                    if (column.arriveTurn <= view.turn + 1)
                        mineIncoming[target] += column.troops;
                }
                else {
                    foeAll[target] += column.troops;
                    if (column.arriveTurn <= view.turn) {
                        foeNow[target] += column.troops;
                    }
                    else if (column.arriveTurn === view.turn + 1) {
                        foeNext[target] += column.troops;
                    }
                }
            }
            // 预留守军：老家按「相邻敌军可投入兵力」动态保底，前线按接触程度保底。
            const reserve = new Array(n).fill(0);
            const spare = new Array(n).fill(0);
            for (const id of myNodes) {
                const troops = nodes[id].troops ?? 0;
                let keep = id === home
                    ? econMode
                        ? Math.min(45, 2 * view.turn) - (nodes[home].troops ?? 0)
                        : early ? 0 : 4
                    : 0;
                let touching = 0;
                for (const v of adj[id]) {
                    if (nodes[v].owner === foe)
                        touching += guessTroops(v);
                }
                if (touching > 0)
                    keep = Math.max(keep, Math.min(troops, 2));
                keep = Math.max(keep, foeNow[id] + 1 - troops);
                keep = Math.max(keep, foeNext[id] + 1 - troops);
                if (econMode)
                    keep = Math.max(keep, foeAll[id] + 1 - troops);
                // 老家必须能扛住相邻敌军的同回合合击。
                if (id === home && touching > 0) {
                    keep = Math.max(keep, Math.ceil(touching * 0.9) + 1 - troops);
                }
                reserve[id] = Math.min(troops, Math.max(0, keep));
                spare[id] = Math.max(0, troops - reserve[id]);
            }
            const plans = [];
            // ---------- 0. 开局：纵队不可拦截，按对手风格选择突击方式 ----------
            if (view.turn === 1 && enemyHome !== null && !econMode && !spearMode) {
                let target = -1;
                if (opening === 'rush') {
                    const path = findPath(view, home, enemyHome);
                    if (path && path.length <= 6)
                        target = enemyHome;
                }
                else {
                    // 落脚：先夺取敌方老家旁成本最低的节点，次回合从该点斩首。
                    let bestCost = Infinity;
                    for (const v of adj[enemyHome]) {
                        const path = findPath(view, home, v);
                        if (!path)
                            continue;
                        const defense = nodes[v].troops ?? guessTroops(v);
                        const cost = defense + 1 + 2 * (path.length - 2);
                        if (cost < bestCost) {
                            bestCost = cost;
                            target = v;
                        }
                    }
                }
                if (target >= 0) {
                    plans.push({
                        score: 2e6,
                        target,
                        orders: [{ from: home, to: target, troops: nodes[home].troops ?? 0 }],
                        useReserve: true,
                    });
                }
            }
            // ---------- 1. 斩首：相邻老家且能压过其可能的增援 ----------
            if (enemyHome !== null) {
                const homeDefense = nodes[enemyHome].troops ?? 20 + 4 * view.turn;
                let reinforcement = 0;
                for (const v of adj[enemyHome]) {
                    if (nodes[v].owner === foe)
                        reinforcement += guessTroops(v) * killFactor;
                }
                const need = Math.ceil(homeDefense + reinforcement + 1);
                const sources = [];
                for (const v of adj[enemyHome]) {
                    if (nodes[v].owner !== me)
                        continue;
                    const available = nodes[v].troops ?? 0;
                    if (available > 0)
                        sources.push({ id: v, travel: 0, spare: available });
                }
                const assembled = gatherSources(sources, need);
                if (assembled) {
                    for (const order of assembled.orders)
                        order.to = enemyHome;
                    plans.push({
                        score: 1e6,
                        target: enemyHome,
                        orders: assembled.orders,
                        useReserve: true,
                    });
                }
            }
            // ---------- 2. 防守：拦截本回合到达的敌方纵队 ----------
            for (const id of myNodes) {
                if (foeNow[id] === 0)
                    continue;
                let need = foeNow[id] + 1 - (nodes[id].troops ?? 0);
                if (need <= 0)
                    continue;
                const sources = [];
                for (const v of adj[id]) {
                    if (nodes[v].owner !== me || spare[v] <= 0)
                        continue;
                    const path = findPath(view, v, id);
                    if (!path)
                        continue;
                    sources.push({ id: v, travel: 0, spare: spare[v] });
                }
                sources.sort((a, b) => b.spare - a.spare);
                const orders = [];
                for (const source of sources) {
                    const amount = Math.min(source.spare, need);
                    orders.push({ from: source.id, to: id, troops: amount });
                    need -= amount;
                    if (need <= 0)
                        break;
                }
                if (need <= 0) {
                    plans.push({
                        score: 5e5 + (id === home ? 1e5 : 0),
                        target: id,
                        orders,
                    });
                }
            }
            // ---------- 3. 提前保家：相邻敌军过强时回撤兵力 ----------
            if (reserve[home] > 0) {
                let need = reserve[home];
                const sources = [];
                for (const v of adj[home]) {
                    if (nodes[v].owner !== me || spare[v] <= 0)
                        continue;
                    sources.push({ id: v, travel: 0, spare: spare[v] });
                }
                sources.sort((a, b) => b.spare - a.spare);
                const orders = [];
                for (const source of sources) {
                    const amount = Math.min(source.spare, need);
                    orders.push({ from: source.id, to: home, troops: amount });
                    need -= amount;
                    if (need <= 0)
                        break;
                }
                if (need <= 0) {
                    plans.push({ score: 8e5, target: home, orders });
                }
            }
            // ---------- 3.5 兵团滚动：5 条指令汇聚到最靠近敌方老家的可攻目标 ----------
            if (spearMode && view.turn >= 3 && enemyHome !== null) {
                let best = null;
                for (const target of nodes) {
                    if (target.owner === me || target.kind === 'home')
                        continue;
                    const cost = (target.troops ?? guessTroops(target.id)) + 1;
                    const sources = [];
                    for (const id of myNodes) {
                        if (spare[id] < 2)
                            continue;
                        const path = findPath(view, id, target.id);
                        if (!path)
                            continue;
                        sources.push({ id, travel: Math.max(0, path.length - 2), spare: spare[id] });
                    }
                    sources.sort((a, b) => b.spare - a.spare);
                    const orders = [];
                    let total = 0;
                    for (const source of sources.slice(0, view.maxOrders)) {
                        orders.push({ from: source.id, to: target.id, troops: source.spare });
                        total += source.spare;
                    }
                    if (total < cost || orders.length === 0)
                        continue;
                    const rank = -(distEnemyHome[target.id] ?? 9) * 100 + Math.min(total, 100);
                    if (!best || rank > best.rank)
                        best = { target: target.id, orders, rank };
                }
                if (best)
                    plans.push({ score: 9e4, target: best.target, orders: best.orders });
            }
            // ---------- 4. 经济扩张：按边际产出 / 成本排序 ----------
            const horizon = early ? 10 : 7;
            for (const target of nodes) {
                if (target.owner !== -1)
                    continue;
                const need = (target.troops ?? 0) + 1;
                if (mineIncoming[target.id] >= need)
                    continue;
                const sources = [];
                for (const id of myNodes) {
                    if (spare[id] < 2)
                        continue;
                    const path = findPath(view, id, target.id);
                    if (!path)
                        continue;
                    sources.push({
                        id,
                        travel: Math.max(0, path.length - 2),
                        spare: spare[id],
                    });
                }
                if (sources.length === 0)
                    continue;
                let value = marginalProduction(target.kind, myCount[target.kind]) * horizon;
                if (target.kind === 'foundry')
                    value += 4;
                if (target.kind === 'watchtower')
                    value += 2;
                value += Math.max(0, 4 - (distHome[target.id] ?? 9)) * 0.8;
                // 靠近敌方老家的中立点更有战略价值，但也更容易被争夺。
                if (distEnemyHome[target.id] <= 3)
                    value += 3;
                let exposed = false;
                for (const v of adj[target.id]) {
                    if (nodes[v].owner === foe && guessTroops(v) > need)
                        exposed = true;
                }
                if (exposed)
                    value *= econMode ? 0.6 : 0.25;
                const assembled = gatherSources(sources, need);
                if (!assembled)
                    continue;
                for (const order of assembled.orders)
                    order.to = target.id;
                const score = value / (need + 2 * assembled.travel);
                plans.push({ score, target: target.id, orders: assembled.orders });
            }
            // ---------- 5. 蚕食：夺取可见的敌方节点 ----------
            for (const target of nodes) {
                if (target.owner !== foe || target.kind === 'home' || target.troops === null)
                    continue;
                if (mineIncoming[target.id] > target.troops)
                    continue;
                let reinforcement = 0;
                for (const v of adj[target.id]) {
                    if (v !== enemyHome && nodes[v].owner === foe) {
                        reinforcement += guessTroops(v) * 0.4;
                    }
                }
                const need = Math.ceil(target.troops + reinforcement + 1);
                const sources = [];
                for (const id of myNodes) {
                    if (spare[id] < 3)
                        continue;
                    const path = findPath(view, id, target.id);
                    if (!path)
                        continue;
                    sources.push({ id, travel: Math.max(0, path.length - 2), spare: spare[id] });
                }
                if (sources.length === 0)
                    continue;
                const gain = marginalProduction(target.kind, myCount[target.kind]);
                const denial = marginalProduction(target.kind, foeCount[target.kind]);
                let value = (gain + denial) * (early ? 6 : 5) + 4;
                if (distEnemyHome[target.id] <= 2)
                    value += 4;
                const assembled = gatherSources(sources, need);
                if (!assembled)
                    continue;
                for (const order of assembled.orders)
                    order.to = target.id;
                plans.push({
                    score: value / (need + 2 * assembled.travel + 2),
                    target: target.id,
                    orders: assembled.orders,
                });
            }
            // ---------- 6. 前推：把后方闲置兵力送到前线 ----------
            for (const id of myNodes) {
                if (spare[id] < (econMode ? 8 : 5))
                    continue;
                let best = null;
                for (const dest of myNodes) {
                    if (dest === id || spare[dest] > 24)
                        continue;
                    const path = findPath(view, id, dest);
                    if (!path || path.length < 2)
                        continue;
                    const travel = path.length - 2;
                    const distance = distEnemyHome[dest] ?? 9;
                    const current = best ? best.distance - best.travel * 0.4 : Infinity;
                    const candidate = distance - travel * 0.4;
                    if (candidate < current)
                        best = { to: dest, travel, distance };
                }
                if (!best)
                    continue;
                const amount = spare[id] - 4;
                if (amount < 1)
                    continue;
                plans.push({
                    score: 1.5,
                    target: best.to,
                    orders: [{ from: id, to: best.to, troops: amount }],
                });
            }
            // ---------- 统一挑选：优先级 + 兵力约束 + 指令上限 ----------
            plans.sort((a, b) => b.score - a.score);
            const spent = new Array(n).fill(0);
            const taken = new Set();
            const result = [];
            for (const plan of plans) {
                if (result.length + plan.orders.length > view.maxOrders)
                    continue;
                if (taken.has(plan.target))
                    continue;
                let valid = true;
                for (const order of plan.orders) {
                    if (order.from < 0 ||
                        order.from >= n ||
                        order.to < 0 ||
                        order.to >= n ||
                        order.from === order.to ||
                        order.troops < 1 ||
                        spent[order.from] + order.troops >
                            (plan.useReserve ? (nodes[order.from].troops ?? 0) : spare[order.from])) {
                        valid = false;
                        break;
                    }
                }
                if (!valid)
                    continue;
                const seen = new Set();
                for (const order of plan.orders) {
                    const key = `${order.from}>${order.to}`;
                    if (seen.has(key)) {
                        valid = false;
                        break;
                    }
                    seen.add(key);
                }
                if (!valid)
                    continue;
                for (const order of plan.orders) {
                    spent[order.from] += order.troops;
                    result.push(order);
                }
                taken.add(plan.target);
            }
            return result.slice(0, view.maxOrders);
        },
    };
}
