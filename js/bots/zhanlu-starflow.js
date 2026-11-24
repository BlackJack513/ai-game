/**
 * 湛卢星流 —— 单文件参赛 bot
 *
 * 风格：经济滚雪球 · 视野预警 · 精准掠夺 · 蓄势斩首
 *
 * 设计原则：
 * 1. 只依赖 view，不读写任何模块级可变状态，保证并发对局安全；
 * 2. 每回合重新做一次「路径 + 威胁 + 收益」计算，不做跨回合记忆；
 * 3. 先保证老家与关键节点不失守，再把多余兵力投入高收益目标；
 * 4. 视野内的敌方纵队是精确信息，利用它做同回合合击与增援。
 */
const NEUTRAL = -1;
const TROOP_CAP = 100;
function emptyCounts() {
    return { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 };
}
function countMine(view, me) {
    const counts = emptyCounts();
    for (const node of view.nodes) {
        if (node.owner === me)
            counts[node.kind]++;
    }
    return counts;
}
/**
 * 与引擎 findPath 完全一致的 BFS：
 * 中间节点只能是己方或中立，敌方节点可以作为终点但不能穿过。
 */
function bfsFrom(view, me, src) {
    const n = view.nodes.length;
    const dist = new Array(n).fill(-1);
    const prev = new Array(n).fill(-1);
    dist[src] = 0;
    prev[src] = src;
    const queue = [src];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (dist[v] !== -1)
                continue;
            const owner = view.nodes[v].owner;
            if (owner === me || owner === NEUTRAL) {
                dist[v] = dist[u] + 1;
                prev[v] = u;
                queue.push(v);
            }
            else {
                // 敌方节点：只能作为终点，记录最短路但不入队
                dist[v] = dist[u] + 1;
                prev[v] = u;
            }
        }
    }
    return { dist, prev };
}
/** 不限制归属的图距离，仅用于位置估值。 */
function graphDistance(view, sources) {
    const dist = new Array(view.nodes.length).fill(-1);
    const queue = [];
    for (const source of sources) {
        if (dist[source] === -1) {
            dist[source] = 0;
            queue.push(source);
        }
    }
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (dist[v] !== -1)
                continue;
            dist[v] = dist[u] + 1;
            queue.push(v);
        }
    }
    return dist;
}
/** 占领该节点后，我方每回合能多拿多少产出（含同类节点联动）。 */
function productionGain(kind, counts) {
    if (kind === 'home')
        return 4;
    if (kind === 'foundry')
        return 5;
    if (kind === 'watchtower')
        return 2;
    const current = counts[kind];
    const own = 2 + Math.floor((current + 1) / 2);
    const bump = current % 2 === 1 ? current : 0;
    return own + bump * 0.5;
}
/** 目标价值：产出、节点数、位置、视野与掠夺收益的综合。 */
function targetValue(target, counts, enemyHomeDist, myHomeDist, turnRatio) {
    const production = productionGain(target.kind, counts);
    let value = production * 1.7 + 1.0 + turnRatio * 3.2;
    if (target.kind === 'watchtower')
        value += 1.2;
    if (target.kind === 'foundry')
        value += 1.6;
    if (target.owner !== NEUTRAL) {
        value += 2.0; // 打压对手经济与节点数
        if (target.troops !== null && target.troops <= 4)
            value += 5.5; // 捡漏：刚占下、守军薄
        if (target.troops !== null && target.troops <= 2)
            value += 2.5;
    }
    const dh = enemyHomeDist[target.id];
    if (dh >= 0)
        value += Math.max(0, 4 - dh) * 0.7;
    const mh = myHomeDist[target.id];
    if (mh >= 0)
        value += Math.max(0, 3 - mh) * 0.25;
    return value;
}
function decide(view) {
    const me = view.you;
    const turn = view.turn;
    const nodes = view.nodes;
    const myNodes = nodes.filter((node) => node.owner === me);
    if (myNodes.length === 0)
        return [];
    const myHome = view.homeNode;
    const counts = countMine(view, me);
    // 敌方老家：kind 为 home 且归属不是自己的节点（归属与地形都是公开信息）。
    const enemyHomes = nodes.filter((node) => node.kind === 'home' && node.owner >= 0 && node.owner !== me);
    const enemyHomeDist = graphDistance(view, enemyHomes.map((node) => node.id));
    // 敌方阵地的前沿：到最近的敌方节点还有几跳，用于补给与撤退方向。
    const enemyFrontierDist = graphDistance(view, nodes.filter((node) => node.owner >= 0 && node.owner !== me).map((node) => node.id));
    const myHomeDist = graphDistance(view, [myHome]);
    const reach = new Map();
    for (const node of myNodes)
        reach.set(node.id, bfsFrom(view, me, node.id));
    // ---- 敌军在途兵力（终点是我方节点时必然是精确信息：我方节点本身在视野内） ----
    const incoming = new Map();
    // 我方在途兵力：按「目标 -> 到达回合 -> 兵力」记账，避免对同一目标重复投入。
    const myAttack = new Map();
    const myReinforce = new Map();
    for (const column of view.columns) {
        const dst = column.path[column.path.length - 1];
        if (column.owner === me) {
            if (nodes[dst].owner === me) {
                if (column.arriveTurn <= turn) {
                    myReinforce.set(dst, (myReinforce.get(dst) ?? 0) + column.troops);
                }
            }
            else {
                const byTurn = myAttack.get(dst) ?? new Map();
                byTurn.set(column.arriveTurn, (byTurn.get(column.arriveTurn) ?? 0) + column.troops);
                myAttack.set(dst, byTurn);
            }
            continue;
        }
        if (nodes[dst].owner !== me)
            continue;
        const record = incoming.get(dst) ?? { now: 0, next: 0 };
        if (column.arriveTurn <= turn)
            record.now += column.troops;
        else if (column.arriveTurn === turn + 1)
            record.next += column.troops;
        incoming.set(dst, record);
    }
    // ---- 相邻敌方节点兵力（相邻时必然在我方 1 跳视野内，因此可见） ----
    const adjacent = new Map();
    const adjacentSum = new Map();
    for (const node of myNodes) {
        let best = 0;
        let sum = 0;
        for (const neighbor of view.adj[node.id]) {
            const owner = nodes[neighbor].owner;
            if (owner < 0 || owner === me)
                continue;
            const troops = nodes[neighbor].troops ?? 6;
            best = Math.max(best, troops);
            sum += troops;
        }
        adjacent.set(node.id, best);
        adjacentSum.set(node.id, sum);
    }
    const remaining = new Map();
    for (const node of myNodes)
        remaining.set(node.id, node.troops ?? 0);
    const reserve = new Map();
    for (const node of myNodes) {
        const adj = adjacent.get(node.id) ?? 0;
        const own = remaining.get(node.id) ?? 0;
        let base = 0;
        if (node.id === myHome) {
            // 老家是唯一不能丢的节点：相邻敌人可能合击，按总兵力估算
            const threat = adjacentSum.get(node.id) ?? 0;
            base = threat > 0 ? threat + 1 : turn <= 3 ? 0 : 2;
        }
        else if (adj > 0) {
            // 守不住就别把兵锁在节点里等死：要么增援，要么把兵拿去别处换收益
            base = own <= adj ? 0 : adj + 1;
        }
        reserve.set(node.id, Math.min(own, base));
    }
    const spendable = (id) => Math.max(0, (remaining.get(id) ?? 0) - (reserve.get(id) ?? 0));
    const orders = [];
    const seenOrders = new Set();
    const pushOrder = (from, to, troops) => {
        if (troops < 1 || orders.length >= view.maxOrders)
            return false;
        const key = `${from}>${to}`;
        if (seenOrders.has(key))
            return false;
        const left = remaining.get(from) ?? 0;
        if (troops > left)
            troops = left;
        if (troops < 1)
            return false;
        orders.push({ from, to, troops });
        seenOrders.add(key);
        remaining.set(from, left - troops);
        return true;
    };
    // ---- 防守：只对「本回合可能被打掉」的节点投入 ----
    const plans = [];
    for (const node of myNodes) {
        const inc = incoming.get(node.id);
        const confirmed = inc?.now ?? 0;
        const threat = node.id === myHome ? (adjacentSum.get(node.id) ?? 0) : (adjacent.get(node.id) ?? 0);
        const pressure = confirmed + threat;
        const own = node.troops ?? 0;
        // 本回合会到达的我方增援已经在路上，不需重复派
        const gap = pressure + 1 - (own + (myReinforce.get(node.id) ?? 0));
        if (gap <= 0)
            continue;
        const isHome = node.id === myHome;
        const value = productionGain(node.kind, counts) * 1.6 + (node.kind === 'home' ? 40 : 0);
        plans.push({
            node,
            gap,
            confirmed,
            score: (isHome ? 1000 : value * 4) + gap * 0.5 + confirmed * 4,
        });
    }
    plans.sort((a, b) => b.score - a.score);
    const threatened = new Set(plans.filter((plan) => plan.confirmed > 0).map((plan) => plan.node.id));
    /** 从相邻己方节点凑兵：同回合到达，可与守军合并结算。 */
    const reinforce = (targetId, need, emergency = false) => {
        const sources = myNodes
            .filter((node) => node.id !== targetId && (reach.get(node.id)?.dist[targetId] ?? -1) === 1)
            .map((node) => ({
            id: node.id,
            value: emergency ? (remaining.get(node.id) ?? 0) : spendable(node.id),
        }))
            .filter((item) => item.value > 0)
            .sort((a, b) => b.value - a.value);
        const total = sources.reduce((sum, item) => sum + item.value, 0);
        if (total < need)
            return false;
        let left = need;
        for (const source of sources) {
            if (left <= 0)
                break;
            const amount = Math.min(left, source.value);
            if (pushOrder(source.id, targetId, amount))
                left -= amount;
        }
        return left <= 0;
    };
    /** 守不住时把兵撤到相邻的安全己方节点，避免白送。 */
    const retreat = (node) => {
        if (node.id === myHome)
            return;
        const amount = remaining.get(node.id) ?? 0;
        if (amount < 1)
            return;
        const targets = view.adj[node.id]
            .filter((id) => nodes[id].owner === me && !threatened.has(id))
            .sort((a, b) => (enemyFrontierDist[b] ?? 0) - (enemyFrontierDist[a] ?? 0));
        if (targets.length === 0)
            return;
        pushOrder(node.id, targets[0], amount);
    };
    for (const plan of plans) {
        if (plan.confirmed > 0) {
            // 已确认本回合到达：同回合增援合并结算，救不下来就撤兵
            if (!reinforce(plan.node.id, plan.gap))
                retreat(plan.node);
            continue;
        }
        if (plan.node.id === myHome) {
            // 老家宁可少扩张也要守住：紧急时允许从相邻节点抽干
            reinforce(plan.node.id, plan.gap, true);
            continue;
        }
        // 相邻敌人只是「可能」来打：缺口小且节点值钱时才增援，否则留着兵继续扩张
        if (plan.gap <= 3 && productionGain(plan.node.kind, counts) >= 2.5) {
            reinforce(plan.node.id, plan.gap);
        }
    }
    // ---- 进攻 ----
    const turnRatio = turn / Math.max(1, view.maxTurns);
    const buildOptions = () => {
        const options = [];
        for (const target of nodes) {
            if (target.owner === me)
                continue;
            if (target.id === myHome)
                continue;
            const isEnemyHome = target.owner >= 0 && target.kind === 'home';
            let def = target.troops;
            // 兵力未知的普通敌方节点不碰（避免送兵）；老家是唯一允许赌一把的目标
            if (def === null) {
                if (!isEnemyHome)
                    continue;
                const minePlayer = view.players[me];
                const oppPlayer = view.players[target.owner];
                const behind = oppPlayer && minePlayer && oppPlayer.production >= minePlayer.production * 1.15;
                if (!behind || turn > 30)
                    continue;
                // 对手在扩张期会把老家兵力派出去，按回合递减估计守军
                def = Math.max(8, Math.round(20 - (turn - 1) * 0.8));
            }
            const need = def + (isEnemyHome ? 3 : 1);
            if (need > 70)
                continue;
            const pre = myAttack.get(target.id);
            const preFor = (arrive) => pre?.get(arrive) ?? 0;
            const rows = [];
            for (const source of myNodes) {
                const d = reach.get(source.id)?.dist[target.id] ?? -1;
                if (d < 0)
                    continue;
                const amount = spendable(source.id);
                if (amount < 1)
                    continue;
                rows.push({ id: source.id, arrive: turn + d - 1, amount });
            }
            rows.sort((a, b) => a.arrive - b.arrive || b.amount - a.amount);
            // 单源优先：一条指令拿一个点最省指令数。
            let chosen = null;
            for (const row of rows) {
                const already = preFor(row.arrive);
                if (row.amount + already < need)
                    continue;
                chosen = { arrive: row.arrive, sources: [row.id], count: 1, pre: already };
                break;
            }
            if (!chosen) {
                // 单源拿不下才用同一到达回合的多源合击。
                const groups = new Map();
                for (const row of rows) {
                    const list = groups.get(row.arrive) ?? [];
                    list.push({ id: row.id, amount: row.amount });
                    groups.set(row.arrive, list);
                }
                for (const [arrive, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
                    const already = preFor(arrive);
                    const total = list.reduce((sum, item) => sum + item.amount, 0) + already;
                    if (total < need)
                        continue;
                    let left = need - already;
                    if (left <= 0)
                        continue;
                    const picked = [];
                    for (const item of list.slice().sort((a, b) => b.amount - a.amount)) {
                        if (left <= 0)
                            break;
                        picked.push(item.id);
                        left -= item.amount;
                    }
                    chosen = { arrive, sources: picked, count: picked.length, pre: already };
                    break;
                }
            }
            if (!chosen || chosen.pre >= need)
                continue;
            const isHomeTarget = target.owner >= 0 && target.kind === 'home';
            let value = targetValue(target, counts, enemyHomeDist, myHomeDist, turnRatio);
            if (isHomeTarget)
                value += 2000;
            if (target.owner >= 0) {
                value += 1.0 + turnRatio * 1.5;
                // 与我方贴脸的敌人优先打掉，消除「无预警突袭」的威胁
                if (view.adj[target.id].some((id) => nodes[id].owner === me))
                    value += 4.0;
            }
            const delay = Math.max(0, chosen.arrive - turn);
            const speed = delay === 0 ? 1 : delay === 1 ? 0.5 : 0.5 / delay;
            const score = ((value * 10 + (delay === 0 ? 4 : 0)) /
                (need * 0.85 + 2 + 4 * Math.max(0, chosen.count - 1))) *
                speed;
            options.push({
                target,
                need,
                pre: chosen.pre,
                arrive: chosen.arrive,
                sources: chosen.sources,
                score,
            });
        }
        options.sort((a, b) => b.score - a.score);
        return options;
    };
    const assigned = new Set();
    while (orders.length < view.maxOrders) {
        const options = buildOptions().filter((option) => !assigned.has(option.target.id));
        if (options.length === 0)
            break;
        const best = options[0];
        let left = Math.max(0, best.need - best.pre);
        const used = [];
        for (const id of best.sources) {
            if (left <= 0)
                break;
            const amount = Math.min(left, spendable(id));
            if (amount < 1)
                continue;
            if (pushOrder(id, best.target.id, amount)) {
                left -= amount;
                used.push(id);
            }
        }
        assigned.add(best.target.id);
        if (left > 0) {
            // 理论上不会发生（buildOptions 已校验），保险起见不保留半成品指令
            for (const order of orders.slice(orders.length - used.length)) {
                const src = order.from;
                remaining.set(src, (remaining.get(src) ?? 0) + order.troops);
                seenOrders.delete(`${order.from}>${order.to}`);
            }
            orders.length -= used.length;
            break;
        }
    }
    // ---- 后方补给：把囤在纵深、快要溢出上限的兵推向前线 ----
    if (orders.length < view.maxOrders) {
        const safeFrontier = myNodes
            .filter((node) => enemyFrontierDist[node.id] === 2)
            .map((node) => node.id);
        const frontier = safeFrontier.length > 0
            ? safeFrontier
            : myNodes.filter((node) => enemyFrontierDist[node.id] === 1).map((node) => node.id);
        if (frontier.length > 0) {
            const pushes = myNodes
                .filter((node) => {
                const d = enemyFrontierDist[node.id];
                return d >= 2 && spendable(node.id) >= 8 && !threatened.has(node.id);
            })
                .sort((a, b) => spendable(b.id) - spendable(a.id))
                .slice(0, 2);
            for (const source of pushes) {
                if (orders.length >= view.maxOrders)
                    break;
                const amount = spendable(source.id) - 3;
                if (amount < 5)
                    continue;
                let bestTarget = -1;
                let bestDist = Infinity;
                for (const id of frontier) {
                    if (id === source.id)
                        continue;
                    const d = reach.get(source.id)?.dist[id] ?? -1;
                    if (d < 0)
                        continue;
                    const room = TROOP_CAP - (remaining.get(id) ?? 0);
                    if (room < amount)
                        continue;
                    if (d < bestDist) {
                        bestDist = d;
                        bestTarget = id;
                    }
                }
                if (bestTarget >= 0)
                    pushOrder(source.id, bestTarget, amount);
            }
        }
    }
    return orders.slice(0, view.maxOrders);
}
export function createZhanluStarflow() {
    return {
        name: '湛卢星流',
        style: '经济滚雪球 · 视野预警 · 精准掠夺 · 蓄势斩首',
        decide,
    };
}
