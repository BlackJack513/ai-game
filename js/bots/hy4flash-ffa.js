/**
 * hy4flash-ffa —— 四人混战专精 bot
 *
 * 设计原则（只从规则出发独立设计）：
 *  1. 老家即命：FFA 中老家易主立刻淘汰、领地全部中立化，因此老家留兵随威胁动态调整；
 *  2. 威胁感知：视野内的敌军纵队按终点聚合，用于老家回防与前线留兵；
 *  3. 经济优先：按「产出价值 / 兵力成本」挑中立点，兵工厂与瞭望塔额外加权；
 *  4. 同回合合击：只把到达回合相同的纵队合并结算，坚决不添油；
 *  5. 条件斩首：仅在兵力盈余且老家安全时，对视野内虚弱敌方老家出手；
 *  6. 终局抢点：临近 150 回合按节点数态势调整攻守。
 *
 * 纯函数：只读 view，不依赖任何外部状态。
 */
const NEUTRAL = -1;
const TROOP_CAP = 100;
/** 节点基础产出（规模效应另算）。 */
function baseProduction(kind) {
    switch (kind) {
        case 'foundry':
            return 5;
        case 'home':
            return 4;
        default:
            return 2;
    }
}
/**
 * 规则最短路：可经己方与中立节点，不可穿越敌方节点，终点本身可以是敌方节点。
 * 与引擎 findPath 完全一致，返回 path[0]=from, path[末]=to。
 */
function findPath(view, from, to) {
    if (from === to)
        return null;
    const nodes = view.nodes;
    const mover = nodes[from].owner;
    if (mover === NEUTRAL)
        return null;
    const n = nodes.length;
    const prev = new Int32Array(n).fill(-1);
    prev[from] = from;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (prev[v] !== -1)
                continue;
            if (v !== to) {
                const owner = nodes[v].owner;
                if (owner !== NEUTRAL && owner !== mover)
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
                return path.reverse();
            }
            queue.push(v);
        }
    }
    return null;
}
/**
 * 打下目标所需兵力：把守军与所有在途纵队按阵营汇总，取「最强的非我方一方 + 1」。
 * 结算规则是「最多者胜、剩余 = 最多 − 第二名」，因此必须严格超过最强的对手。
 */
function requiredTroops(view, target, turn) {
    if (target.troops === null) {
        // 视野外敌军兵力未知。普通节点绝不盲攻（中期守军可达 20+，用低估值去撞=白送兵）。
        // 唯一的例外是真老家：斩首收益极高（淘汰对手+领地中立化），值得按产兵速度豪赌一次。
        if (target.kind === 'home' && target.owner === target.id) {
            return Math.min(80, 20 + Math.floor(turn * 1.2));
        }
        return Infinity;
    }
    const forces = new Map();
    forces.set(target.owner, target.troops);
    for (const col of view.columns) {
        if (col.arriveTurn < turn)
            continue;
        // 斩首窗口稍纵即逝：对敌方老家只把「立刻到达」的回防算进需求，
        // 后续回合才到的援军不阻止我们出手，否则永远抓不到 4~9 兵的破绽。
        if (target.kind === 'home' && col.arriveTurn > turn + 1)
            continue;
        const dest = col.path[col.path.length - 1];
        if (dest !== target.id)
            continue;
        forces.set(col.owner, (forces.get(col.owner) ?? 0) + col.troops);
    }
    let strongest = 0;
    for (const [owner, amount] of forces) {
        if (owner === view.you)
            continue;
        if (amount > strongest)
            strongest = amount;
    }
    return Math.min(TROOP_CAP, strongest + 1);
}
/** 目标综合价值：产出 + 战略加权 + 规模效应 − 兵力成本。 */
function targetValue(view, target, need, turn, rivalCount, distToEnemyHome) {
    let value = baseProduction(target.kind) * 3;
    if (target.kind === 'foundry')
        value += 10; // 产出 5，最高
    if (target.kind === 'watchtower')
        value += 7; // 3 跳视野，预警与斩首的眼睛
    if (target.kind === 'home') {
        // 只有存活玩家的真老家才触发淘汰；死者的旧家只是普通据点
        value += target.owner === target.id ? (rivalCount === 1 ? 90 : 62) : 9;
    }
    if (target.owner === NEUTRAL)
        value += 8; // 中立守军公开、不增长，成本确定
    else
        value += 10; // FFA 是零和：削弱对手 = 抬高自己名次，不能只种田
    if (target.kind === 'farm' || target.kind === 'mine' || target.kind === 'lab') {
        const same = view.nodes.reduce((sum, node) => sum + (node.owner === view.you && node.kind === target.kind ? 1 : 0), 0);
        value += same * 1.5; // ⌊同类数÷2⌋ 的规模效应
    }
    // 通往敌方老家的节点是斩首通道：提前打通，否则临到破绽也无路可走
    const approach = distToEnemyHome[target.id];
    if (Number.isFinite(approach))
        value += Math.max(0, 9 - approach) * 2;
    value -= need * 0.35;
    if (turn >= 120)
        value += 12; // 终局按节点数决胜，抢点优先
    return value;
}
/** 无视归属的图距离：用于衡量节点离各敌方老家有多近（斩首通道价值）。 */
function graphDistance(adj, sources) {
    const dist = new Array(adj.length).fill(Infinity);
    const queue = [];
    for (const s of sources) {
        dist[s] = 0;
        queue.push(s);
    }
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of adj[u]) {
            if (dist[v] !== Infinity)
                continue;
            dist[v] = dist[u] + 1;
            queue.push(v);
        }
    }
    return dist;
}
export function createHy4FlashFfa() {
    return {
        name: 'hy4flash-ffa',
        style: '混战专精 · 威胁感知 · 经济扩张 · 同回合合击 · 伺机斩首',
        decide(view) {
            const budget = Math.min(view.ordersLeft, view.maxOrders, 5);
            if (budget <= 0)
                return [];
            const me = view.you;
            const nodes = view.nodes;
            const n = nodes.length;
            const home = view.homeNode;
            const turn = view.turn;
            const rivals = view.players.filter((p) => p.alive && p.id !== me);
            if (rivals.length === 0)
                return [];
            // 地图保证「玩家 i 的老家 = 节点 i」。玩家被淘汰后其老家节点会被别人占据，
            // 那种节点 kind 仍是 home 但占下它不会淘汰任何人——斩首价值必须排除它。
            const isLiveHome = (node) => node.kind === 'home' && node.owner === node.id && node.owner !== NEUTRAL;
            const enemyHomeIds = nodes.filter((node) => isLiveHome(node) && node.owner !== me).map((node) => node.id);
            const distToEnemyHome = graphDistance(view.adj, enemyHomeIds);
            const mine = nodes.filter((node) => node.owner === me).map((node) => node.id);
            if (mine.length === 0)
                return [];
            const homeTroops = nodes[home].troops ?? 0;
            // 视野内敌军纵队：按终点聚合威胁
            const incoming = new Array(n).fill(0);
            const incomingArrive = new Array(n).fill(Infinity);
            for (const col of view.columns) {
                if (col.owner === me || col.arriveTurn < turn)
                    continue;
                const dest = col.path[col.path.length - 1];
                incoming[dest] += col.troops;
                incomingArrive[dest] = Math.min(incomingArrive[dest], col.arriveTurn);
            }
            const orders = [];
            const usedFrom = new Array(n).fill(0);
            const usedTo = new Set();
            // ---- 阶段 0：老家告急时紧急回防 ----
            // 回防纵队抵达后与守军同阵营合并，因此能在敌军到达前补足防线。
            const homeThreat = incoming[home];
            if (homeThreat > 0 && homeTroops < homeThreat + 4) {
                let deficit = homeThreat + 6 - homeTroops;
                const defenders = mine
                    .filter((id) => id !== home)
                    .map((id) => {
                    const path = findPath(view, id, home);
                    return { id, dist: path ? path.length - 2 : Infinity };
                })
                    .filter((d) => d.dist <= incomingArrive[home] - turn && d.dist <= 4)
                    .sort((a, b) => a.dist - b.dist);
                for (const def of defenders) {
                    if (deficit <= 0 || orders.length >= budget)
                        break;
                    const keep = Math.max(1, incoming[def.id] + 1);
                    const spare = (nodes[def.id].troops ?? 0) - keep - usedFrom[def.id];
                    if (spare < 2)
                        continue;
                    const send = Math.min(spare, deficit);
                    if (send < 1)
                        continue;
                    orders.push({ from: def.id, to: home, troops: send });
                    usedFrom[def.id] += send;
                    deficit -= send;
                }
            }
            // ---- 阶段 1：计算每个节点的留守兵力 ----
            const maxRivalNodes = Math.max(0, ...rivals.map((p) => p.nodes));
            const myNodes = mine.length;
            // 开局只有老家有兵，前 3 回合必须放血抢点；之后迅速把老家养成堡垒。
            // 破军一类对手会在 8~12 回合集中 20+ 兵斩首，留守太薄等于直接送命。
            let homeReserve;
            if (turn <= 3)
                homeReserve = 8;
            else if (turn <= 8)
                homeReserve = 11;
            else
                homeReserve = 14 + Math.floor((turn - 9) / 25) * 2; // 14 → 26：省下的兵前置到前线
            if (turn >= 120)
                homeReserve += 4;
            // 相邻敌方节点本回合即可突袭老家（相邻当回合到达），决策时看不到这些纵队。
            let adjacentThreat = 0;
            for (const nb of view.adj[home]) {
                const node = nodes[nb];
                if (node.owner !== me && node.owner !== NEUTRAL && node.troops !== null) {
                    adjacentThreat += node.troops;
                }
            }
            const totalHomeThreat = homeThreat + adjacentThreat;
            if (totalHomeThreat > 0)
                homeReserve = Math.max(homeReserve, totalHomeThreat + 4);
            if (turn >= 120 && myNodes > maxRivalNodes)
                homeReserve += 4; // 终局领先则求稳
            homeReserve = Math.min(homeReserve, 55, homeTroops);
            const reserve = new Array(n).fill(1);
            const frontBase = turn <= 5 ? 1 : turn <= 15 ? 2 : 3;
            for (const id of mine) {
                reserve[id] = Math.min(nodes[id].troops ?? 0, Math.max(frontBase, incoming[id] + 3));
            }
            reserve[home] = homeReserve;
            // ---- 阶段 2：为每个目标寻找同回合合击方案 ----
            const plans = [];
            for (const target of nodes) {
                if (target.owner === me)
                    continue;
                // 需求保持低门槛，否则多带兵的要求会让大量进攻计划因「凑不够」而流产；
                // 额外兵力在分配阶段再补（见阶段 3），既保证成行又能在占领后留下战力。
                const need = requiredTroops(view, target, turn) + 1;
                if (!Number.isFinite(need))
                    continue;
                const value = targetValue(view, target, need, turn, rivals.length, distToEnemyHome);
                // 按距离分组：只让同一回合到达的纵队合并结算，先到先被吃掉的添油战术不划算。
                const byDist = new Map();
                for (const s of mine) {
                    const avail = (nodes[s].troops ?? 0) - reserve[s] - usedFrom[s];
                    if (avail < 1)
                        continue;
                    const path = findPath(view, s, target.id);
                    if (!path)
                        continue;
                    const dist = path.length - 2;
                    if (dist > 5)
                        continue;
                    const group = byDist.get(dist) ?? [];
                    group.push({ id: s, avail, dist });
                    byDist.set(dist, group);
                }
                if (byDist.size === 0)
                    continue;
                let chosen = [];
                for (const dist of [...byDist.keys()].sort((a, b) => a - b)) {
                    const group = byDist.get(dist);
                    const total = group.reduce((sum, s) => sum + s.avail, 0);
                    if (total < need)
                        continue;
                    const weight = (s) => (s.id === home ? s.avail * 0.5 : s.avail);
                    group.sort((a, b) => weight(b) - weight(a));
                    let sum = 0;
                    for (const s of group) {
                        if (sum >= need)
                            break;
                        chosen.push(s);
                        sum += s.avail;
                    }
                    break;
                }
                if (chosen.length === 0)
                    continue;
                const score = value / (1 + chosen[0].dist * 0.55) - chosen.length * 1.5;
                plans.push({ target: target.id, need, sources: chosen, score });
            }
            // ---- 阶段 3：按评分贪心分配指令 ----
            plans.sort((a, b) => b.score - a.score);
            for (const plan of plans) {
                if (orders.length >= budget)
                    break;
                if (usedTo.has(plan.target))
                    continue;
                const spareOf = (s) => Math.max(0, (nodes[s.id].troops ?? 0) - reserve[s.id] - usedFrom[s.id]);
                // 剩余指令位内最多能投入多少：不够就整单放弃，绝不添油
                const slots = budget - orders.length;
                const injectable = [...plan.sources]
                    .sort((a, b) => spareOf(b) - spareOf(a))
                    .slice(0, slots)
                    .reduce((sum, s) => sum + spareOf(s), 0);
                if (injectable < plan.need)
                    continue;
                let remaining = plan.need;
                const before = orders.length;
                for (const s of plan.sources) {
                    if (remaining <= 0 || orders.length >= budget)
                        break;
                    const spare = (nodes[s.id].troops ?? 0) - reserve[s.id] - usedFrom[s.id];
                    if (spare < 1)
                        continue;
                    // 结算剩余 = 攻方 − 守方，多带的兵会留在占领后的节点成为下一个扩张源。
                    // 但每源最多多带 8，避免一个目标吸干所有兵力。
                    const send = Math.min(spare, remaining + 8);
                    if (send < 1)
                        continue;
                    orders.push({ from: s.id, to: plan.target, troops: send });
                    usedFrom[s.id] += send;
                    remaining -= send;
                }
                if (orders.length > before)
                    usedTo.add(plan.target);
            }
            // ---- 阶段 4：兵力前置 ----
            // 老家超出安全线的兵如果窝在家里就是死钱。送到靠近前线、兵力偏薄的我方节点，
            // 既能当扩张跳板，也能在敌人来犯时充当机动防御力量（同阵营抵达即合并）。
            if (orders.length < budget) {
                let excess = (nodes[home].troops ?? 0) - usedFrom[home] - reserve[home];
                if (excess >= 6) {
                    const frontlines = mine
                        .filter((id) => id !== home && usedFrom[id] === 0 && (nodes[id].troops ?? 0) < 22)
                        .map((id) => {
                        const path = findPath(view, home, id);
                        return { id, dist: path ? path.length - 2 : Infinity };
                    })
                        .filter((d) => d.dist >= 1 && d.dist <= 3)
                        .sort((a, b) => a.dist - b.dist || (nodes[a.id].troops ?? 0) - (nodes[b.id].troops ?? 0));
                    for (const front of frontlines) {
                        if (orders.length >= budget || excess < 6)
                            break;
                        const room = 22 - (nodes[front.id].troops ?? 0);
                        const send = Math.min(excess, room, 20);
                        if (send < 3)
                            continue;
                        orders.push({ from: home, to: front.id, troops: send });
                        usedFrom[home] += send;
                        excess -= send;
                    }
                }
            }
            return orders;
        },
    };
}
export default createHy4FlashFfa;
