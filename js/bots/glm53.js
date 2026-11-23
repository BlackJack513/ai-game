/**
 * 「GLM53」—— 全局调度型 AI
 *
 * 每回合按四层流水线分配至多 5 条指令：
 *   1. 防守：敌方在途纵队 + 相邻突袭潜力 → 守军缺口，就近限时增援
 *   2. 扩张：中立点按「价值 − 守军成本 − 距离 − 竞速风险」评分，多线抢占
 *   3. 进攻：可见的敌方弱点（含空虚老家）用同回合多源合击一击致命
 *   4. 流动：后方富余永远向前线锚点集结，临近 100 上限强制外送
 *
 * 核心是一个复刻引擎结算规则的小型战斗模拟器：把所有在途纵队按到达
 * 顺序逐回合结算（含产出增长），预测任意节点在我抵达时刻的归属与兵力，
 * 从而把每笔出兵的需求兵力精确到「只多 1~2 个」。零记忆纯函数，
 * 只依赖当回合 Observation，视野外敌军按类型保守估值。
 */
import { NEUTRAL } from '../engine/types.js';
const CAP = 100;
/** 视野外目标的保守兵力估计。 */
function estimateOf(node) {
    if (node.troops !== null)
        return node.troops;
    if (node.owner === NEUTRAL)
        return 4;
    if (node.kind === 'home')
        return 10;
    if (node.kind === 'foundry')
        return 8;
    return 6;
}
/** 与引擎 resolveCombat 完全一致的纯结算。 */
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
/** 带敌方阻挡的 BFS：返回 edges[v]，敌方节点可作终点、不可穿过（与引擎寻路一致）。 */
function bfsBlocked(view, from) {
    const n = view.nodes.length;
    const edges = new Array(n).fill(Infinity);
    edges[from] = 0;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        const owner = view.nodes[u].owner;
        if (u !== from && owner !== NEUTRAL && owner !== view.you)
            continue;
        for (const v of view.adj[u]) {
            if (edges[v] !== Infinity)
                continue;
            edges[v] = edges[u] + 1;
            queue.push(v);
        }
    }
    return edges;
}
/** 无阻挡多源 BFS，用于渗透/竞速的保守估计。 */
function bfsFree(view, sources) {
    const n = view.nodes.length;
    const dist = new Array(n).fill(Infinity);
    const queue = [];
    for (const s of sources) {
        dist[s] = 0;
        queue.push(s);
    }
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
function plan(view) {
    const n = view.nodes.length;
    const me = view.you;
    const now = view.turn;
    const remain = view.maxTurns - now;
    const mineSet = new Array(n).fill(false);
    const myIds = [];
    for (const node of view.nodes) {
        if (node.owner === me) {
            mineSet[node.id] = true;
            myIds.push(node.id);
        }
    }
    if (myIds.length === 0)
        return [];
    const troopsOf = (id) => (mineSet[id] ? view.nodes[id].troops ?? 0 : 0);
    // 我方出兵距离表（相邻节点 = 0 延迟，当回合结算）
    const myEdges = new Map();
    for (const id of myIds)
        myEdges.set(id, bfsBlocked(view, id));
    const hopsFrom = (from, to) => {
        const edges = myEdges.get(from);
        if (!edges)
            return Infinity;
        return edges[to] === Infinity ? Infinity : edges[to] - 1;
    };
    // 我方同类节点统计与产出
    const counts = { farm: 0, mine: 0, lab: 0 };
    for (const node of view.nodes) {
        if (node.owner === me && counts[node.kind] !== undefined)
            counts[node.kind]++;
    }
    const myProdOf = (id) => {
        const kind = view.nodes[id].kind;
        if (kind === 'home')
            return 4;
        if (kind === 'foundry')
            return 5;
        if (kind === 'watchtower')
            return 2;
        return 2 + Math.floor(counts[kind] / 2);
    };
    const approxProdOf = (id) => {
        const kind = view.nodes[id].kind;
        if (kind === 'home')
            return 4;
        if (kind === 'foundry')
            return 5;
        return 2;
    };
    // 敌方节点 / 敌方老家（归属公开）
    const enemyIds = [];
    let enemyHome = -1;
    let enemyHomeDist = Infinity;
    const distFromEnemyHome = bfsFree(view, view.nodes.filter((node) => node.kind === 'home' && node.owner >= 0 && node.owner !== me).map((node) => node.id));
    const distFromMyHome = bfsFree(view, [view.homeNode]);
    for (const node of view.nodes) {
        if (node.owner >= 0 && node.owner !== me)
            enemyIds.push(node.id);
        if (node.kind === 'home' && node.owner >= 0 && node.owner !== me) {
            if (distFromMyHome[node.id] < enemyHomeDist) {
                enemyHomeDist = distFromMyHome[node.id];
                enemyHome = node.id;
            }
        }
    }
    const distFromEnemies = enemyIds.length > 0 ? bfsFree(view, enemyIds) : new Array(n).fill(Infinity);
    // ---- 战斗预测器：target 在 now+delay 时刻的归属与兵力 ----
    const predictAt = (target, delay) => {
        const cur = view.nodes[target];
        let owner = cur.owner;
        let troops = estimateOf(cur);
        const events = [];
        for (const column of view.columns) {
            const last = column.path[column.path.length - 1];
            if (last !== target)
                continue;
            const arrive = column.arriveTurn - now;
            if (arrive > delay)
                continue;
            events.push({ arrive, owner: column.owner, troops: column.troops });
        }
        events.sort((a, b) => a.arrive - b.arrive);
        const prodBetween = (turns) => {
            if (turns <= 0 || owner === NEUTRAL)
                return 0;
            const per = owner === me ? myProdOf(target) : approxProdOf(target);
            return per * turns;
        };
        let lastArrive = 0;
        let index = 0;
        while (index < events.length) {
            const arrive = events[index].arrive;
            troops = Math.min(CAP, troops + prodBetween(arrive - lastArrive));
            const group = [];
            while (index < events.length && events[index].arrive === arrive) {
                group.push(events[index]);
                index++;
            }
            const result = combat(owner, troops, group);
            owner = result.owner;
            troops = result.troops;
            lastArrive = arrive;
        }
        troops = Math.min(CAP, troops + prodBetween(delay - lastArrive));
        return { owner, troops };
    };
    // ---- 指令缓冲 ----
    const orders = [];
    const used = new Array(n).fill(0);
    const capacity = (id, keep) => Math.max(0, troopsOf(id) - used[id] - keep);
    const send = (from, to, troops, keep) => {
        if (orders.length >= view.maxOrders)
            return false;
        if (from === to || !mineSet[from])
            return false;
        if (orders.some((order) => order.from === from && order.to === to))
            return false;
        const amount = Math.min(Math.floor(troops), capacity(from, keep));
        if (amount < 1)
            return false;
        const hops = hopsFrom(from, to);
        if (hops < 0 || hops === Infinity)
            return false;
        orders.push({ from, to, troops: amount });
        used[from] += amount;
        return true;
    };
    // ---- 威胁与守军 ----
    const threat = new Array(n).fill(0);
    const threatDelay = new Array(n).fill(Infinity);
    const inbound = new Array(n).fill(0);
    for (const column of view.columns) {
        const target = column.path[column.path.length - 1];
        if (!mineSet[target])
            continue;
        const delay = column.arriveTurn - now;
        if (column.owner === me) {
            if (delay <= 2)
                inbound[target] += column.troops;
        }
        else {
            // 纵队一旦出发必然到达，威胁按全量计，不打折
            threat[target] += column.troops;
            threatDelay[target] = Math.min(threatDelay[target], delay);
        }
    }
    const isFront = (id) => view.adj[id].some((v) => {
        const owner = view.nodes[v].owner;
        return owner >= 0 && owner !== me;
    });
    const keepOf = (id) => {
        if (id === view.homeNode) {
            let vuln = 0;
            for (const enemy of view.nodes) {
                if (enemy.owner < 0 || enemy.owner === me)
                    continue;
                const d = distFromMyHome[enemy.id];
                if (d === 1)
                    vuln += Math.max(0, estimateOf(enemy) - 1) * 0.55;
                else if (d === 2)
                    vuln += Math.max(0, estimateOf(enemy) - 1) * 0.3;
                else if (d === 3)
                    vuln += Math.max(0, estimateOf(enemy) - 2) * 0.15;
            }
            // 封顶：锁死一切就是慢性死亡，超限风险交给威胁检测响应
            return Math.max(7, Math.min(18, Math.round(7 + vuln * 0.5)));
        }
        if (isFront(id)) {
            let maxAdj = 0;
            for (const v of view.adj[id]) {
                const node = view.nodes[v];
                if (node.owner >= 0 && node.owner !== me)
                    maxAdj = Math.max(maxAdj, estimateOf(node));
            }
            if (maxAdj <= 4)
                return 3;
            return Math.min(8, Math.ceil((maxAdj - 1) * 0.5) + 2);
        }
        return 1;
    };
    // 已放弃救援的点：解除出兵锁定，别让守不住的兵陪葬
    const abandoned = new Set();
    // 威胁在途时锁住出兵：保证不把防守需要的兵抽走
    const safeKeepOf = (id) => {
        const base = keepOf(id);
        if (abandoned.has(id))
            return base;
        if (threat[id] <= 0)
            return base;
        const prodGrow = myProdOf(id) * Math.max(0, Math.min(2, threatDelay[id]));
        const kind = view.nodes[id].kind;
        // 老家满锁；普通点按重要性打折，多线威胁下保住机动性，避免全军瘫痪
        const coef = id === view.homeNode ? 1 : kind === 'foundry' || kind === 'watchtower' ? 0.9 : 0.75;
        const locked = (threat[id] + 1 - inbound[id] - prodGrow) * coef;
        return Math.max(base, Math.min(troopsOf(id), Math.ceil(locked)));
    };
    // ---- 阶段 1：守军缺口增援 ----
    const deficits = [];
    for (const id of myIds) {
        if (threat[id] <= 0)
            continue;
        const grow = myProdOf(id) * Math.max(0, threatDelay[id]);
        const effective = troopsOf(id) + inbound[id] + grow;
        let need = Math.ceil(threat[id] + 1 - effective);
        // 前线点一次堆够期望驻防，避免被轮流骚扰、天天救火
        if (isFront(id) && threatDelay[id] >= 1) {
            let maxAdj = 0;
            for (const v of view.adj[id]) {
                const owner = view.nodes[v].owner;
                if (owner >= 0 && owner !== me)
                    maxAdj = Math.max(maxAdj, estimateOf(view.nodes[v]));
            }
            const desired = Math.ceil(maxAdj * 0.8) + 3;
            need = Math.max(need, Math.ceil(desired - effective));
        }
        if (need > 0)
            deficits.push({ id, need, delay: threatDelay[id] });
    }
    deficits.sort((a, b) => (b.id === view.homeNode ? 1 : 0) - (a.id === view.homeNode ? 1 : 0) || b.need - a.need);
    for (const deficit of deficits) {
        if (orders.length >= view.maxOrders)
            break;
        // 战术放弃：守不住的前线/后方不值得倾家增援，老家除外
        const rescueLimit = deficit.id === view.homeNode ? Infinity : isFront(deficit.id) ? 18 : 10;
        if (deficit.need > rescueLimit) {
            abandoned.add(deficit.id);
            continue;
        }
        const urgent = deficit.id === view.homeNode;
        const timeLimit = deficit.delay <= 1 ? deficit.delay : Math.max(deficit.delay, 2);
        const sources = myIds
            .filter((s) => s !== deficit.id && hopsFrom(s, deficit.id) <= timeLimit)
            .sort((a, b) => hopsFrom(a, deficit.id) - hopsFrom(b, deficit.id) ||
            capacity(b, safeKeepOf(b)) - capacity(a, safeKeepOf(a)));
        let remaining = deficit.need + 1;
        for (const s of sources) {
            if (remaining <= 0 || orders.length >= view.maxOrders)
                break;
            const keep = urgent ? Math.min(safeKeepOf(s), 2) : safeKeepOf(s);
            const amount = Math.min(remaining, capacity(s, keep));
            if (amount >= 1 && send(s, deficit.id, amount, keep))
                remaining -= amount;
        }
    }
    const candidates = [];
    const valueOf = (id) => {
        const node = view.nodes[id];
        if (node.owner === me)
            return 0;
        if (node.kind === 'foundry')
            return 110;
        if (node.kind === 'watchtower')
            return 80;
        if (node.kind === 'home')
            return 35;
        return 45 + counts[node.kind] * 5;
    };
    for (const node of view.nodes) {
        if (node.owner === me)
            continue;
        const isEnemy = node.owner >= 0;
        const neutral = !isEnemy;
        let bestDelay = Infinity;
        for (const s of myIds) {
            if (capacity(s, safeKeepOf(s)) < 1)
                continue;
            bestDelay = Math.min(bestDelay, hopsFrom(s, node.id));
        }
        if (!Number.isFinite(bestDelay) || bestDelay > (node.kind === 'home' && isEnemy ? 4 : 3))
            continue;
        const predicted = predictAt(node.id, bestDelay);
        if (predicted.owner === me)
            continue;
        let need;
        let minNeed;
        let value = valueOf(node.id);
        let hidden = 0;
        if (predicted.owner === NEUTRAL) {
            minNeed = predicted.troops + 1;
            need = minNeed;
            const enemyNear = distFromEnemies[node.id];
            if (enemyNear <= 2) {
                // 贴敌点占领后必被反抢：驻防成本一次给足，要么别去拉锯
                let maxAdj = 0;
                for (const v of view.adj[node.id]) {
                    const owner = view.nodes[v].owner;
                    if (owner >= 0 && owner !== me)
                        maxAdj = Math.max(maxAdj, estimateOf(view.nodes[v]));
                }
                const garrison = maxAdj > 4 ? Math.ceil(maxAdj * 0.6) + 2 : 0;
                if (enemyNear <= 1) {
                    need += 2 + garrison;
                    value = value * 0.75;
                }
                else {
                    need += 1 + Math.ceil(garrison / 2);
                    value = value * 0.9;
                }
            }
            if (remain <= 40)
                value += 22;
            if (predicted.troops <= 1)
                value += 25;
        }
        else if (predicted.owner !== me) {
            // 劣势时保守余量只会坐等被围死，敢打才有翻盘窗口
            const myScale = myIds.length;
            const foeScale = enemyIds.filter((id) => view.nodes[id].owner === predicted.owner).length;
            const margin = foeScale >= 2 * myScale ? 2 : 3;
            minNeed = predicted.troops + margin;
            need = minNeed;
            if (view.nodes[node.id].troops === null)
                hidden = 20;
            let adjacentStrength = 0;
            for (const v of view.adj[node.id]) {
                const neighbor = view.nodes[v];
                if (neighbor.owner === predicted.owner)
                    adjacentStrength += estimateOf(neighbor);
            }
            need += Math.min(6, Math.floor(adjacentStrength / 4));
            if (predicted.troops <= 3)
                value += 25; // 白捡的空点
            if (node.kind === 'home' && node.owner === predicted.owner)
                value += 550;
            if (node.kind === 'foundry')
                value += 20;
        }
        else {
            continue;
        }
        if (remain <= 12 && neutral)
            value += 30;
        candidates.push({
            target: node.id,
            need,
            minNeed,
            delay: bestDelay,
            score: value - need * 3 - bestDelay * 10 - hidden,
        });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const candidate of candidates) {
        if (orders.length >= view.maxOrders)
            break;
        // 兵源优先用普通点：兵工厂/瞭望塔是经济命脉与情报节点，只在无兵可用时才许抽调
        let sources = myIds
            .filter((s) => hopsFrom(s, candidate.target) === candidate.delay && capacity(s, safeKeepOf(s)) >= 1)
            .sort((a, b) => capacity(b, safeKeepOf(b)) - capacity(a, safeKeepOf(a)));
        if (sources.some((s) => view.nodes[s].kind !== 'foundry' && view.nodes[s].kind !== 'watchtower')) {
            sources = sources.filter((s) => view.nodes[s].kind !== 'foundry' && view.nodes[s].kind !== 'watchtower');
        }
        const single = sources.find((s) => capacity(s, safeKeepOf(s)) >= candidate.minNeed);
        if (single !== undefined) {
            send(single, candidate.target, candidate.need, safeKeepOf(single));
            continue;
        }
        // 同回合多源合击（保证同时到达才能合并结算）；软目标拿不到就拿硬门槛
        let gathered = 0;
        const picked = [];
        const aim = candidate.need;
        for (const s of sources) {
            if (gathered >= aim || picked.length >= 3)
                break;
            if (orders.length + picked.length >= view.maxOrders)
                break;
            const keep = safeKeepOf(s);
            const amount = Math.min(aim - gathered, capacity(s, keep));
            if (amount >= 1) {
                picked.push({ from: s, amount, keep });
                gathered += amount;
            }
        }
        if (gathered >= candidate.minNeed && picked.length >= 1) {
            for (const p of picked) {
                if (!send(p.from, candidate.target, p.amount, p.keep))
                    break;
            }
        }
    }
    // ---- 阶段 4：兵力流动 ----
    const anchors = myIds.filter((id) => isFront(id) && id !== view.homeNode);
    if (anchors.length === 0) {
        let best = -1;
        let bestDist = Infinity;
        for (const id of myIds) {
            const d = enemyHome >= 0 ? distFromEnemyHome[id] : Infinity;
            if (d < bestDist) {
                bestDist = d;
                best = id;
            }
        }
        if (best >= 0)
            anchors.push(best);
    }
    // 集结：没打下来的高分目标，把最近的己方节点标为锚点，下回合就地合击
    const targeted = new Set(orders.map((order) => order.to));
    for (const candidate of candidates) {
        if (anchors.length >= 6)
            break;
        if (candidate.score < 25)
            break;
        if (targeted.has(candidate.target))
            continue;
        if (candidate.need > 60)
            continue;
        let source = -1;
        let bestDist = Infinity;
        for (const s of myIds) {
            const h = hopsFrom(s, candidate.target);
            if (h === candidate.delay && h < bestDist) {
                bestDist = h;
                source = s;
            }
        }
        if (source >= 0 && source !== view.homeNode && !anchors.includes(source))
            anchors.push(source);
    }
    if (anchors.length > 0 && orders.length < view.maxOrders) {
        const anchorLoad = new Map();
        for (const id of anchors)
            anchorLoad.set(id, troopsOf(id) + inbound[id]);
        const shipTo = (from, keep) => {
            if (orders.length >= view.maxOrders)
                return;
            let best = -1;
            let bestHops = Infinity;
            for (const anchor of anchors) {
                if (anchor === from)
                    continue;
                const h = hopsFrom(from, anchor);
                if (h < 0 || h === Infinity)
                    continue;
                if (h < bestHops || (h === bestHops && (anchorLoad.get(anchor) ?? 0) < (anchorLoad.get(best) ?? 0))) {
                    best = anchor;
                    bestHops = h;
                }
            }
            if (best < 0)
                return;
            const amount = capacity(from, keep);
            if (amount >= 1 && send(from, best, amount, keep)) {
                anchorLoad.set(best, (anchorLoad.get(best) ?? 0) + amount);
            }
        };
        for (const id of myIds) {
            if (orders.length >= view.maxOrders)
                break;
            if (id === view.homeNode)
                continue;
            const protectedKind = view.nodes[id].kind === 'foundry' || view.nodes[id].kind === 'watchtower';
            // 前线锚点之间不互相倒兵，只接收后方输送，避免来回空转
            if (anchors.includes(id)) {
                const overfull = troopsOf(id) + inbound[id] >= 92 && threat[id] <= 0;
                if (overfull)
                    shipTo(id, 0);
                continue;
            }
            const overfull = troopsOf(id) + inbound[id] >= 92;
            if (protectedKind && !(overfull && threat[id] <= 0))
                continue;
            const keep = threat[id] > 0 ? safeKeepOf(id) : overfull ? 0 : 1;
            if (capacity(id, keep) >= (overfull && threat[id] <= 0 ? 1 : 5))
                shipTo(id, keep);
        }
        // 老家富余也向前线输送（无威胁时）：留一段缓冲，优势期不被小股斩首
        if (threat[view.homeNode] <= 0 && orders.length < view.maxOrders) {
            const keep = safeKeepOf(view.homeNode) + 8;
            if (capacity(view.homeNode, keep) >= 5)
                shipTo(view.homeNode, keep);
        }
        // 锚点间单向战略转移：最富余且无威胁的锚点支援最缺的锚点（只许单向，防来回空转）
        if (anchors.length >= 2 && orders.length < view.maxOrders) {
            const loads = anchors
                .map((a) => ({ id: a, load: troopsOf(a) + inbound[a] - Math.ceil(threat[a] * 0.5) }))
                .sort((a, b) => b.load - a.load);
            const rich = loads[0];
            const poor = loads[loads.length - 1];
            if (rich.id !== poor.id && threat[rich.id] <= 0 && rich.load >= poor.load + 10) {
                const keep = Math.max(keepOf(rich.id), Math.ceil(rich.load * 0.35));
                if (capacity(rich.id, keep) >= 5)
                    send(rich.id, poor.id, capacity(rich.id, keep), keep);
            }
        }
    }
    return orders;
}
export function createGlm53() {
    return {
        name: 'GLM53',
        style: '全局调度 · 攻守兼备',
        decide(view) {
            try {
                return plan(view);
            }
            catch {
                return [];
            }
        },
    };
}
