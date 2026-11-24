/**
 * 承影 —— 精确结算 · 梯度补给 · 蓄势斩首
 *
 * 设计完全基于 README 规则与 src/engine/ 的实现，不参考任何其他 bot 的代码。
 *
 * 主干：
 *  1. 先算清楚有没有敌方纵队本回合落地，用相邻节点即时增援；
 *  2. 只打兵力可知的目标，投入严格大于守军的兵力，避免 1 兵对 1 兵的平局消耗；
 *  3. 目标价值 = 产出节点 + 朝敌方老家推进的几何奖励 + 敌方正在抢的点避让；
 *  4. 后方富余兵力沿「更靠近敌方」的相邻己方节点逐回合前推，
 *     在前线堆出一支能一拳打穿老家的拳头；多路相邻节点可同回合合并出兵。
 */
const VALUE_TOWER = 46;
const VALUE_FOUNDRY = 62;
const VALUE_NORMAL = 30;
/** 每多一回合到达的评分惩罚 */
const DELAY_PENALTY = 4;
/** 最多允许提前几个回合出发 */
const MAX_DELAY = 2;
/** 富余时多带的兵，让新节点下回合有本钱继续推进 */
const EXTRA_TROOPS = 4;
/** 老家驻军下限：开局 / 前 10 回合 / 之后 */
const HOME_KEEP_EARLY = 2;
const HOME_KEEP_MID = 6;
const HOME_KEEP_LATE = 10;
/** 两跳内敌军折算成的小心地主兵 */
const ENEMY_KEEP_FACTOR = 0.7;
/** 越靠近敌方老家，每跳加多少分 */
const PUSH_WEIGHT = 1.2;
/** 从 src 出发、允许穿过己方与中立节点的最短距离（跳）。到达滞后 = dist - 1。 */
function travelDist(view, me, src) {
    const nodes = view.nodes;
    const dist = new Array(nodes.length).fill(-1);
    dist[src] = 0;
    const queue = [src];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (dist[v] !== -1)
                continue;
            dist[v] = dist[u] + 1;
            const owner = nodes[v].owner;
            if (owner < 0 || owner === me)
                queue.push(v);
        }
    }
    return dist;
}
/** 每个节点离最近敌方节点有几跳（只看几何，不问通行），用来给补给定方向。 */
function enemyProximity(view, me) {
    const nodes = view.nodes;
    const dist = new Array(nodes.length).fill(Infinity);
    const queue = [];
    for (const node of nodes) {
        if (node.owner >= 0 && node.owner !== me) {
            dist[node.id] = 0;
            queue.push(node.id);
        }
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
export function createChengying() {
    return {
        name: '承影',
        style: '精确结算 · 梯度补给 · 蓄势斩首',
        decide(view) {
            const me = view.you;
            const nodes = view.nodes;
            const n = nodes.length;
            const my = nodes.filter((node) => node.owner === me).map((node) => node.id);
            if (my.length === 0)
                return [];
            const foeHome = nodes.find((node) => node.kind === 'home' && node.owner >= 0 && node.owner !== me) ??
                null;
            // 每个己方节点的可达距离表
            const reach = new Map();
            for (const src of my)
                reach.set(src, travelDist(view, me, src));
            // ---- 保留兵力：早期老家几乎全出抢点，看到敌情后再留兵 ----
            const keep = new Array(n).fill(0);
            const homeId = view.homeNode;
            let nearbyFoe = 0;
            const seen = new Set([homeId]);
            let frontier = [homeId];
            for (let depth = 0; depth < 2; depth++) {
                const next = [];
                for (const u of frontier) {
                    for (const v of view.adj[u]) {
                        if (seen.has(v))
                            continue;
                        seen.add(v);
                        const node = nodes[v];
                        if (node.owner >= 0 && node.owner !== me)
                            nearbyFoe += node.troops ?? 12;
                        next.push(v);
                    }
                }
                frontier = next;
            }
            const phaseKeep = view.turn <= 4 ? HOME_KEEP_EARLY : view.turn <= 10 ? HOME_KEEP_MID : HOME_KEEP_LATE;
            keep[homeId] =
                nearbyFoe > 0
                    ? Math.max(phaseKeep, Math.min(70, 4 + Math.ceil(nearbyFoe * ENEMY_KEEP_FACTOR)))
                    : phaseKeep;
            // 本回合会落地的敌方纵队：目标节点的守军不能动
            const incoming = new Map();
            for (const column of view.columns) {
                if (column.owner === me || column.arriveTurn > view.turn)
                    continue;
                const target = column.path[column.path.length - 1];
                if (nodes[target].owner !== me)
                    continue;
                incoming.set(target, (incoming.get(target) ?? 0) + column.troops);
            }
            for (const [target] of incoming)
                keep[target] = nodes[target].troops ?? 0;
            // ---- 指令登记 ----
            const orders = [];
            const spent = new Map();
            const sent = new Set();
            const spare = (id) => Math.max(0, (nodes[id].troops ?? 0) - (spent.get(id) ?? 0) - keep[id]);
            const issue = (from, to, troops) => {
                if (orders.length >= view.maxOrders)
                    return 0;
                const key = `${from}>${to}`;
                if (sent.has(key))
                    return 0;
                const send = Math.min(Math.floor(troops), spare(from));
                if (send < 1)
                    return 0;
                spent.set(from, (spent.get(from) ?? 0) + send);
                sent.add(key);
                orders.push({ from, to, troops: send });
                return send;
            };
            // ---- 1. 本回合落地的敌军：相邻己方节点即时增援 ----
            for (const [target, foeTroops] of incoming) {
                let held = nodes[target].troops ?? 0;
                if (held > foeTroops)
                    continue;
                const helpers = view.adj[target].filter((id) => nodes[id].owner === me);
                for (const src of helpers) {
                    if (held > foeTroops)
                        break;
                    held += issue(src, target, foeTroops + 1 - held);
                }
            }
            // ---- 2. 斩首：已经贴到敌方老家，且联军总兵力够 ----
            if (foeHome && foeHome.troops !== null && orders.length < view.maxOrders) {
                const neighbors = view.adj[foeHome.id].filter((id) => nodes[id].owner === me);
                const need = foeHome.troops + 2;
                let pooled = 0;
                for (const id of neighbors)
                    pooled += spare(id);
                if (pooled >= need) {
                    let remaining = need;
                    for (const id of neighbors) {
                        if (remaining <= 0)
                            break;
                        remaining -= issue(id, foeHome.id, remaining);
                    }
                }
            }
            // ---- 几何上离敌方老家多近（忽略归属），用来给推进方向加分 ----
            const geo = new Array(n).fill(Infinity);
            if (foeHome) {
                geo[foeHome.id] = 0;
                const geoQueue = [foeHome.id];
                for (let qi = 0; qi < geoQueue.length; qi++) {
                    const u = geoQueue[qi];
                    for (const v of view.adj[u]) {
                        if (geo[v] === Infinity) {
                            geo[v] = geo[u] + 1;
                            geoQueue.push(v);
                        }
                    }
                }
            }
            const pushBonus = (id) => Number.isFinite(geo[id]) ? Math.max(0, 24 - geo[id]) * PUSH_WEIGHT : 0;
            // 对手视野内正在前往的目标：不要同时撞上去打成平局
            const foeTargets = new Set();
            for (const column of view.columns) {
                if (column.owner === me)
                    continue;
                foeTargets.add(column.path[column.path.length - 1]);
            }
            const candidates = [];
            for (const target of nodes) {
                if (target.owner === me)
                    continue;
                if (target.troops === null)
                    continue; // 视野外的不赌
                if (target.kind === 'home')
                    continue; // 老家走斩首逻辑
                if (target.owner === -1 && foeTargets.has(target.id))
                    continue;
                const cost = target.troops;
                const hostile = target.owner >= 0;
                // 中立点只压「刚好严格大于守军」；敌占点翻倍投入，确保一击拿下。
                const need = hostile ? Math.max(cost * 2, cost + 2, 3) : cost + 1;
                let bestDelay = Infinity;
                for (const src of my) {
                    const d = reach.get(src)[target.id];
                    if (d <= 0)
                        continue;
                    const delay = d - 1;
                    if (delay > MAX_DELAY)
                        continue;
                    bestDelay = Math.min(bestDelay, delay);
                }
                if (!Number.isFinite(bestDelay))
                    continue;
                const value = target.kind === 'watchtower'
                    ? VALUE_TOWER
                    : target.kind === 'foundry'
                        ? VALUE_FOUNDRY
                        : VALUE_NORMAL;
                const score = value / Math.max(1, need) + pushBonus(target.id) - bestDelay * DELAY_PENALTY;
                candidates.push({ target, need, delay: bestDelay, score });
            }
            candidates.sort((a, b) => b.score - a.score);
            for (const candidate of candidates) {
                if (orders.length >= view.maxOrders)
                    break;
                const { target, need, delay } = candidate;
                const sources = my.filter((src) => {
                    const d = reach.get(src)[target.id];
                    return d > 0 && d - 1 === delay && spare(src) > 0;
                });
                let pooled = 0;
                for (const src of sources)
                    pooled += spare(src);
                if (pooled < need)
                    continue;
                const bonus = Math.min(EXTRA_TROOPS, Math.floor((pooled - need) / 2));
                let remaining = need + Math.max(0, bonus);
                for (const src of sources) {
                    if (remaining <= 0)
                        break;
                    remaining -= issue(src, target.id, remaining);
                }
            }
            // ---- 4. 梯度补给：后方富余兵力推向更靠近敌方的前线，汇成拳头 ----
            if (orders.length < view.maxOrders) {
                const proximity = enemyProximity(view, me);
                const advance = new Map();
                for (const src of my)
                    advance.set(src, foeHome ? reach.get(src)[foeHome.id] : -1);
                // 前线 = 与敌方节点相邻的己方节点；到前线的距离只在己方节点之间计算
                const frontDist = new Array(n).fill(Infinity);
                const queue = [];
                for (const id of my) {
                    const exposed = view.adj[id].some((nb) => nodes[nb].owner >= 0 && nodes[nb].owner !== me);
                    if (exposed) {
                        frontDist[id] = 0;
                        queue.push(id);
                    }
                }
                for (let qi = 0; qi < queue.length; qi++) {
                    const u = queue[qi];
                    for (const v of view.adj[u]) {
                        if (nodes[v].owner === me && frontDist[v] === Infinity) {
                            frontDist[v] = frontDist[u] + 1;
                            queue.push(v);
                        }
                    }
                }
                const rank = (id) => {
                    if (frontDist[id] !== Infinity)
                        return frontDist[id];
                    const adv = advance.get(id) ?? -1;
                    return adv >= 0 ? adv : 1000 + proximity[id];
                };
                const rear = [...my].sort((a, b) => rank(b) - rank(a));
                for (const src of rear) {
                    if (orders.length >= view.maxOrders)
                        break;
                    const here = rank(src);
                    if (!Number.isFinite(here))
                        continue;
                    let next = -1;
                    let best = here;
                    for (const nb of view.adj[src]) {
                        if (nodes[nb].owner !== me)
                            continue;
                        const there = rank(nb);
                        if (there < best) {
                            best = there;
                            next = nb;
                        }
                    }
                    if (next < 0)
                        continue;
                    const send = spare(src);
                    if (send >= 1)
                        issue(src, next, send);
                }
            }
            return orders;
        },
    };
}
