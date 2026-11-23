/**
 * 「天枢」—— 精确推演 · 协同绝杀型 AI
 *
 * 核心设计：
 * 1. 精确经济估值：完整计算 farm/mine/lab 同类偶数组合跳档收益，动态结合剩余回合数与节点数终局权重
 * 2. 稳健开局与避坑：前期优先抢占安全零延迟邻点，避免在不占优的对等中心竞速中白送兵力；不盲撞视野外敌点
 * 3. 抗佯攻精确防线 + 主动护家：
 *    - 按时间轴逐回合推演在途纵队与己方产出，仅锁定守住节点所需的最小兵力，免疫小股佯攻锁兵
 *    - 老家邻接有敌方重兵时主动回防补兵，防止对手零延迟偷家；非邻接（≥2步）敌人依赖视野与在途预警，不白锁死兵力
 *    - 对注定失守且无救的非老家节点执行「就近撤离」，把即将阵亡的兵力提前退入安全邻点
 * 4. 必杀斩首引擎：支持同回合邻接零延迟斩首，以及结合外围纵队与邻接部队的「1回合不可逆将杀」
 * 5. 锋矢集结推进：后方与高产设施兵力向邻近前线锋点稳健流动，避免大部队跨图横跳暴露纵深
 *
 * 严格纯函数：零外部状态、不修改 view。
 */
import { NEUTRAL, RULES, } from '../engine/types.js';
const CAP = RULES.maxTroops;
const NORMAL_KINDS = ['farm', 'mine', 'lab'];
function totalProdForKind(kind, count) {
    if (count <= 0)
        return 0;
    if (kind === 'home')
        return count * RULES.homeProduction;
    if (kind === 'foundry')
        return count * (RULES.baseProduction + RULES.foundryBonus);
    if (kind === 'watchtower')
        return count * RULES.baseProduction;
    return count * (RULES.baseProduction + Math.floor(count / 2));
}
function resolveCombatPure(defender, garrison, group) {
    const sides = new Map();
    sides.set(defender, garrison);
    for (const item of group) {
        sides.set(item.owner, (sides.get(item.owner) ?? 0) + item.troops);
    }
    const entries = [...sides.entries()].sort((a, b) => b[1] - a[1]);
    const top = entries[0][1];
    let ties = 0;
    for (const e of entries) {
        if (e[1] === top)
            ties++;
    }
    if (ties > 1)
        return { owner: defender, troops: 0 };
    const second = entries.length > 1 ? entries[1][1] : 0;
    return { owner: entries[0][0], troops: Math.min(CAP, top - second) };
}
function bfsFree(adj, start) {
    const n = adj.length;
    const dist = new Array(n).fill(Infinity);
    dist[start] = 0;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        for (const v of adj[u]) {
            if (dist[v] === Infinity) {
                dist[v] = dist[u] + 1;
                q.push(v);
            }
        }
    }
    return dist;
}
/** 从 start 出发、仅穿过 {passOwner, NEUTRAL} 节点（终点可为任意势力）的最短跳数（相邻 = 0）。 */
function bfsOpenHops(view, start, passOwner) {
    const n = view.nodes.length;
    const dist = new Array(n).fill(Infinity);
    dist[start] = 0;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        for (const v of view.adj[u]) {
            if (dist[v] !== Infinity)
                continue;
            dist[v] = dist[u] + 1;
            const own = view.nodes[v].owner;
            if (own === NEUTRAL || own === passOwner) {
                q.push(v);
            }
        }
    }
    const hops = new Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) {
        if (dist[i] >= 1 && Number.isFinite(dist[i]))
            hops[i] = dist[i] - 1;
    }
    return hops;
}
function plan(view) {
    const n = view.nodes.length;
    const me = view.you;
    const now = view.turn;
    const remain = Math.max(0, view.maxTurns - now);
    const home = view.homeNode;
    const isDuel = view.mode === 'duel';
    const mine = [];
    const mineSet = new Array(n).fill(false);
    const enemyNodes = [];
    const enemyHomes = [];
    const aliveFoes = view.players.filter((p) => p.id !== me && p.alive);
    for (const node of view.nodes) {
        if (node.owner === me) {
            mine.push(node.id);
            mineSet[node.id] = true;
        }
        else if (node.owner >= 0) {
            enemyNodes.push(node.id);
            if (node.kind === 'home')
                enemyHomes.push(node.id);
        }
    }
    if (mine.length === 0)
        return [];
    // ---- 各类节点统计与精确边际产出 ----
    const emptyCounts = () => ({
        home: 0,
        farm: 0,
        mine: 0,
        lab: 0,
        watchtower: 0,
        foundry: 0,
    });
    const countsByPlayer = new Map();
    for (const p of view.players)
        countsByPlayer.set(p.id, emptyCounts());
    for (const node of view.nodes) {
        if (node.owner >= 0) {
            const c = countsByPlayer.get(node.owner);
            if (c)
                c[node.kind]++;
        }
    }
    const myCounts = countsByPlayer.get(me) ?? emptyCounts();
    const myProdAt = (id) => {
        const kind = view.nodes[id].kind;
        if (kind === 'home')
            return RULES.homeProduction;
        if (kind === 'foundry')
            return RULES.baseProduction + RULES.foundryBonus;
        if (kind === 'watchtower')
            return RULES.baseProduction;
        return RULES.baseProduction + Math.floor(myCounts[kind] / 2);
    };
    const marginalGain = (kind) => {
        const c = myCounts[kind];
        return totalProdForKind(kind, c + 1) - totalProdForKind(kind, c);
    };
    const marginalLoss = (kind, owner) => {
        if (owner < 0 || owner === me)
            return 0;
        const c = countsByPlayer.get(owner)?.[kind] ?? 0;
        if (c <= 0)
            return 0;
        return totalProdForKind(kind, c) - totalProdForKind(kind, c - 1);
    };
    const prodOfOwner = (id, owner) => {
        if (owner === NEUTRAL)
            return 0;
        if (owner === me)
            return myProdAt(id);
        const cur = view.nodes[id];
        if (cur.owner === owner)
            return cur.production;
        const kind = cur.kind;
        if (kind === 'home')
            return 4;
        if (kind === 'foundry')
            return 5;
        if (kind === 'watchtower')
            return 2;
        const c = (countsByPlayer.get(owner)?.[kind] ?? 0) + 1;
        return 2 + Math.floor(c / 2);
    };
    // ---- 视野外敌方节点合理兵力估计 ----
    const estTroops = (node) => {
        if (node.troops !== null)
            return node.troops;
        if (node.owner === NEUTRAL)
            return 4;
        const p = view.players[node.owner];
        const avgProd = p && p.nodes > 0 ? p.production / p.nodes : 3;
        if (node.kind === 'home') {
            return Math.min(45, 12 + Math.floor(now * 0.35) + Math.floor(avgProd * 1.2));
        }
        if (node.kind === 'foundry') {
            return Math.min(35, 10 + Math.floor(now * 0.25));
        }
        if (node.kind === 'watchtower') {
            return Math.min(28, 8 + Math.floor(now * 0.2));
        }
        return Math.min(26, 6 + Math.floor(now * 0.18));
    };
    // ---- 距离矩阵（n <= 36，极快） ----
    const freeDist = [];
    for (let i = 0; i < n; i++)
        freeDist.push(bfsFree(view.adj, i));
    const myHops = new Map();
    for (const id of mine)
        myHops.set(id, bfsOpenHops(view, id, me));
    const enemyMinHops = new Array(n).fill(Infinity);
    for (const eid of enemyNodes) {
        const eOwner = view.nodes[eid].owner;
        const eh = bfsOpenHops(view, eid, eOwner);
        for (let t = 0; t < n; t++) {
            if (eh[t] < enemyMinHops[t])
                enemyMinHops[t] = eh[t];
        }
    }
    // ---- 战斗推演器 ----
    const arrivalsByTarget = new Map();
    for (const col of view.columns) {
        const target = col.path[col.path.length - 1];
        const at = col.arriveTurn - now;
        if (at < 0)
            continue;
        let list = arrivalsByTarget.get(target);
        if (!list) {
            list = [];
            arrivalsByTarget.set(target, list);
        }
        list.push({ at, owner: col.owner, troops: col.troops });
    }
    const grow = (troops, owner, id, turns) => {
        if (owner === NEUTRAL || turns <= 0)
            return troops;
        const p = prodOfOwner(id, owner);
        if (p <= 0)
            return troops;
        return Math.min(CAP, troops + p * turns);
    };
    const simulateWithStart = (target, horizon, startOwner, startTroops, extra = []) => {
        let owner = startOwner;
        let troops = startTroops;
        const baseArrivals = arrivalsByTarget.get(target);
        const list = [];
        if (baseArrivals) {
            for (const a of baseArrivals) {
                if (a.at <= horizon)
                    list.push(a);
            }
        }
        for (const a of extra) {
            if (a.at >= 0 && a.at <= horizon)
                list.push(a);
        }
        list.sort((a, b) => a.at - b.at);
        let last = 0;
        let idx = 0;
        while (idx < list.length) {
            const at = list[idx].at;
            troops = grow(troops, owner, target, at - last);
            last = at;
            const group = [];
            while (idx < list.length && list[idx].at === at) {
                group.push(list[idx]);
                idx++;
            }
            const res = resolveCombatPure(owner, troops, group);
            owner = res.owner;
            troops = res.troops;
        }
        troops = grow(troops, owner, target, horizon - last);
        return { owner, troops };
    };
    const simulate = (target, horizon, extra = []) => {
        const cur = view.nodes[target];
        return simulateWithStart(target, horizon, cur.owner, estTroops(cur), extra);
    };
    // ---- 精确防线分析 ----
    const adjEnemyInfo = (id) => {
        let max = 0;
        let sum = 0;
        let count = 0;
        for (const v of view.adj[id]) {
            const vn = view.nodes[v];
            if (vn.owner >= 0 && vn.owner !== me) {
                const t = estTroops(vn);
                if (t > max)
                    max = t;
                sum += t;
                count++;
            }
        }
        return { max, sum, count };
    };
    // 计算老家主动安全阈值（仅贴脸 d=1 敌人能零预警偷家，d=2 敌人至少提前 1 回合在视野中现身）
    const computeHomeSafeTarget = () => {
        const adjInfo = adjEnemyInfo(home);
        let d2Max = 0;
        let minDist = Infinity;
        for (const eid of enemyNodes) {
            const d = freeDist[home][eid];
            if (d < minDist)
                minDist = d;
            if (d === 2) {
                const et = estTroops(view.nodes[eid]);
                if (et > d2Max)
                    d2Max = et;
            }
        }
        const hasHomeCol = arrivalsByTarget.get(home)?.some((a) => a.owner !== me) ?? false;
        if (now <= 2 && minDist >= 3 && !hasHomeCol)
            return 1;
        if (adjInfo.count > 0) {
            // 有敌方节点直接贴老家：必须留够防零延迟斩首的守军
            return Math.min(44, Math.max(10, adjInfo.max + 4 + Math.floor((adjInfo.sum - adjInfo.max) * 0.4)));
        }
        if (minDist === 2) {
            return Math.min(18, Math.max(6, Math.ceil(d2Max * 0.35) + 4));
        }
        return Math.min(12, 3 + Math.floor(now * 0.2));
    };
    const homeSafeTarget = computeHomeSafeTarget();
    const baseKeep = (id) => {
        const curTroops = view.nodes[id].troops ?? 0;
        if (id === home) {
            return Math.min(curTroops, homeSafeTarget);
        }
        const { max: adjMax } = adjEnemyInfo(id);
        if (adjMax > 0) {
            if (remain <= 12)
                return Math.min(14, Math.max(2, Math.ceil(adjMax * 0.55) + 1));
            return Math.min(12, Math.max(2, Math.ceil(adjMax * 0.45) + 1));
        }
        // 贴近前线 2 步以内的次级纵深节点适当留小股垫脚，防前线破防后瞬间裸奔
        let nearFoe = false;
        for (const eid of enemyNodes) {
            if (freeDist[id][eid] <= 2) {
                nearFoe = true;
                break;
            }
        }
        return nearFoe ? 2 : 1;
    };
    const analyzeDefense = (id) => {
        const curTroops = view.nodes[id].troops ?? 0;
        const cols = arrivalsByTarget.get(id);
        if (!cols || !cols.some((a) => a.owner !== me)) {
            return { minLockNow: 0, broken: false, breakAt: Infinity, deficit: 0 };
        }
        const sorted = cols.slice().sort((a, b) => a.at - b.at);
        const survivesWith = (startTroops) => {
            let owner = me;
            let troops = startTroops;
            let last = 0;
            let idx = 0;
            while (idx < sorted.length) {
                const at = sorted[idx].at;
                troops = grow(troops, owner, id, at - last);
                last = at;
                const group = [];
                while (idx < sorted.length && sorted[idx].at === at) {
                    group.push(sorted[idx]);
                    idx++;
                }
                const res = resolveCombatPure(owner, troops, group);
                owner = res.owner;
                troops = res.troops;
                if (owner !== me)
                    return { ok: false, breakAt: at };
            }
            return { ok: true, breakAt: Infinity };
        };
        const fullCheck = survivesWith(curTroops);
        if (!fullCheck.ok) {
            let lo = 1;
            let hi = 200;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                const test = simulateWithStart(id, fullCheck.breakAt, me, curTroops, [
                    { at: fullCheck.breakAt, owner: me, troops: mid },
                ]);
                if (test.owner === me)
                    hi = mid;
                else
                    lo = mid + 1;
            }
            return { minLockNow: curTroops, broken: true, breakAt: fullCheck.breakAt, deficit: lo };
        }
        let lo = 0;
        let hi = curTroops;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (survivesWith(mid).ok)
                hi = mid;
            else
                lo = mid + 1;
        }
        return { minLockNow: lo, broken: false, breakAt: Infinity, deficit: 0 };
    };
    const defenseMap = new Map();
    for (const id of mine)
        defenseMap.set(id, analyzeDefense(id));
    const evacuated = new Set();
    const keepOf = (id) => {
        if (evacuated.has(id))
            return 0;
        const def = defenseMap.get(id);
        return Math.max(baseKeep(id), def ? def.minLockNow : 0);
    };
    // ---- 指令缓冲 ----
    const orders = [];
    const used = new Array(n).fill(0);
    const availOf = (id) => (mineSet[id] ? (view.nodes[id].troops ?? 0) - used[id] : 0);
    const capOf = (id, keep = keepOf(id)) => Math.max(0, availOf(id) - keep);
    const send = (from, to, troops, keep = keepOf(from)) => {
        if (orders.length >= view.maxOrders)
            return 0;
        if (from === to || !mineSet[from])
            return 0;
        if (orders.some((o) => o.from === from && o.to === to))
            return 0;
        const h = myHops.get(from)?.[to] ?? Infinity;
        if (!Number.isFinite(h))
            return 0;
        const amount = Math.min(Math.floor(troops), capOf(from, keep));
        if (amount < 1)
            return 0;
        orders.push({ from, to, troops: amount });
        used[from] += amount;
        return amount;
    };
    // ---- 阶段 1A：在途破防紧急守家 & 战略撤离 ----
    const threatened = mine
        .map((id) => ({ id, def: defenseMap.get(id) }))
        .filter((x) => x.def !== undefined && x.def.broken && x.def.deficit > 0)
        .sort((a, b) => {
        if (a.id === home && b.id !== home)
            return -1;
        if (b.id === home && a.id !== home)
            return 1;
        return a.def.breakAt - b.def.breakAt || a.def.deficit - b.def.deficit;
    });
    for (const { id, def } of threatened) {
        if (orders.length >= view.maxOrders)
            break;
        const isHome = id === home;
        const donors = mine
            .filter((s) => s !== id && !evacuated.has(s) && (myHops.get(s)?.[id] ?? Infinity) <= def.breakAt)
            .sort((a, b) => (myHops.get(a)?.[id] ?? Infinity) - (myHops.get(b)?.[id] ?? Infinity) || capOf(b) - capOf(a));
        const donorKeep = (s) => {
            const sDef = defenseMap.get(s);
            if (isHome)
                return Math.max(sDef?.minLockNow ?? 0, s === home ? 0 : 1);
            return keepOf(s);
        };
        const maxRescue = donors.reduce((sum, s) => sum + capOf(s, donorKeep(s)), 0);
        const kind = view.nodes[id].kind;
        const rescueWorth = isHome ? Infinity : kind === 'foundry' || kind === 'watchtower' ? 20 : 13;
        if (!isHome && (maxRescue < def.deficit || def.deficit > rescueWorth)) {
            evacuated.add(id);
            continue;
        }
        let need = def.deficit;
        for (const s of donors) {
            if (need <= 0 || orders.length >= view.maxOrders)
                break;
            const k = donorKeep(s);
            const give = send(s, id, need, k);
            if (give > 0)
                need -= give;
        }
        if (!isHome && need > 0)
            evacuated.add(id);
    }
    // ---- 阶段 1B：贴脸威慑主动回防老家（防对手下回合 0 延迟偷家） ----
    const homeInboundFriend = arrivalsByTarget
        .get(home)
        ?.filter((a) => a.owner === me && a.at <= 1)
        .reduce((s, a) => s + a.troops, 0) ?? 0;
    const homeCur = availOf(home) + homeInboundFriend;
    if (homeCur < homeSafeTarget && orders.length < view.maxOrders && adjEnemyInfo(home).count > 0) {
        let need = homeSafeTarget - homeCur;
        const donors = mine
            .filter((s) => s !== home && !evacuated.has(s) && (myHops.get(s)?.[home] ?? Infinity) <= 1)
            .sort((a, b) => (myHops.get(a)?.[home] ?? Infinity) - (myHops.get(b)?.[home] ?? Infinity) || availOf(b) - availOf(a));
        for (const s of donors) {
            if (need <= 0 || orders.length >= view.maxOrders)
                break;
            const k = Math.max(defenseMap.get(s)?.minLockNow ?? 0, 1);
            const give = send(s, home, need, k);
            if (give > 0)
                need -= give;
        }
    }
    // ---- 阶段 2：斩首行动（0 延迟即刻斩首 + 1 回合不可逆将杀） ----
    if (enemyHomes.length > 0 && orders.length < view.maxOrders) {
        const homeColsNow = arrivalsByTarget.get(home)?.filter((a) => a.at === 0 && a.owner !== me) ?? [];
        const homeSafeNow = homeColsNow.length === 0 || !defenseMap.get(home)?.broken;
        for (const eh of enemyHomes) {
            if (orders.length >= view.maxOrders)
                break;
            const ehNode = view.nodes[eh];
            const ehVisible = ehNode.troops !== null;
            // 2A: 0 延迟（邻接）即刻斩首
            const adjSrcs = mine
                .filter((s) => (myHops.get(s)?.[eh] ?? Infinity) === 0 && availOf(s) > (s === home ? 1 : 0))
                .sort((a, b) => availOf(b) - availOf(a));
            if (adjSrcs.length > 0) {
                const pred0 = simulate(eh, 0);
                const margin0 = ehVisible ? 2 : 12;
                const need0 = pred0.troops + margin0;
                const maxSlots = Math.min(view.maxOrders - orders.length, adjSrcs.length);
                let force0 = 0;
                for (let i = 0; i < maxSlots; i++) {
                    const s = adjSrcs[i];
                    const k = s === home ? (isDuel && homeSafeNow ? 0 : Math.max(1, keepOf(home))) : 0;
                    force0 += capOf(s, k);
                }
                if (force0 >= need0) {
                    let rem = need0 + (ehVisible ? 2 : 6);
                    for (const s of adjSrcs) {
                        if (rem <= 0 || orders.length >= view.maxOrders)
                            break;
                        const k = s === home ? (isDuel && homeSafeNow ? 0 : Math.max(1, keepOf(home))) : 0;
                        const sent = send(s, eh, rem, k);
                        if (sent > 0)
                            rem -= sent;
                    }
                    if (isDuel && rem <= 0 && homeSafeNow)
                        return orders;
                    continue;
                }
            }
            // 2B: 1 回合不可逆将杀（敌老家必须可见）
            if (ehVisible && (isDuel || aliveFoes.length <= 2)) {
                const d1Srcs = mine
                    .filter((s) => (myHops.get(s)?.[eh] ?? Infinity) === 1 && capOf(s) >= 2)
                    .sort((a, b) => capOf(b) - capOf(a));
                if (d1Srcs.length > 0) {
                    const pred1 = simulate(eh, 1);
                    if (pred1.owner !== me) {
                        let adjFoeMaxSupport = 0;
                        const ehOwner = ehNode.owner;
                        for (const v of view.adj[eh]) {
                            const vn = view.nodes[v];
                            if (vn.owner === ehOwner)
                                adjFoeMaxSupport += estTroops(vn);
                        }
                        let d0Followup = 0;
                        for (const s of mine) {
                            if ((myHops.get(s)?.[eh] ?? Infinity) === 0) {
                                d0Followup += Math.floor(capOf(s) * 0.8);
                            }
                        }
                        const totalKillNeed = pred1.troops + adjFoeMaxSupport + 3;
                        const slots = Math.min(view.maxOrders - orders.length, d1Srcs.length);
                        let d1Force = 0;
                        for (let i = 0; i < slots; i++)
                            d1Force += capOf(d1Srcs[i]);
                        if (d1Force > 0 &&
                            d1Force + d0Followup >= totalKillNeed &&
                            d1Force >= Math.ceil(pred1.troops * 0.75)) {
                            let rem = Math.max(1, totalKillNeed - d0Followup);
                            for (const s of d1Srcs) {
                                if (rem <= 0 || orders.length >= view.maxOrders)
                                    break;
                                const sent = send(s, eh, rem);
                                if (sent > 0)
                                    rem -= sent;
                            }
                        }
                    }
                }
            }
        }
    }
    // ---- 阶段 3：全局扩张与战术进攻 ----
    const myWatchtowers = myCounts.watchtower;
    const maxRange = isDuel ? 4 : 3;
    const candidates = [];
    const myTotalNodes = mine.length;
    let maxOtherNodes = 0;
    for (const p of aliveFoes)
        maxOtherNodes = Math.max(maxOtherNodes, p.nodes);
    const endgameLead = remain <= 28 && myTotalNodes > maxOtherNodes + 1;
    for (const node of view.nodes) {
        if (node.owner === me)
            continue;
        const t = node.id;
        const isEnemy = node.owner >= 0;
        const isUnseenEnemy = isEnemy && node.troops === null;
        if (isUnseenEnemy)
            continue;
        let minDelay = Infinity;
        for (const s of mine) {
            if (capOf(s) < 1 && !(evacuated.has(s) && availOf(s) >= 1))
                continue;
            const h = myHops.get(s)?.[t] ?? Infinity;
            if (h < minDelay)
                minDelay = h;
        }
        if (!Number.isFinite(minDelay) || minDelay > maxRange || minDelay > remain)
            continue;
        if (isEnemy && node.kind !== 'home' && minDelay > 1)
            continue;
        if (endgameLead && minDelay > 2 && isEnemy)
            continue;
        const maxTryDelay = isEnemy ? minDelay : Math.min(minDelay + 1, maxRange, remain);
        for (let delay = minDelay; delay <= maxTryDelay; delay++) {
            const pred = simulate(t, delay);
            if (pred.owner === me)
                continue;
            const predEnemy = pred.owner >= 0;
            if (predEnemy && node.troops === null)
                continue;
            const eRace = enemyMinHops[t];
            const { max: adjFoeMax, sum: adjFoeSum } = adjEnemyInfo(t);
            // 开局前 2 回合，普通中立点若存在同速竞速风险且 delay>=1 则直接跳过，先拿自家稳妥邻点
            if (!predEnemy && now <= 2 && delay >= 1 && eRace <= delay) {
                if (node.kind !== 'foundry' && node.kind !== 'watchtower')
                    continue;
            }
            // 不在 delay >= 2 时贸然对竞速点多路空投（兵力冻在路上太久，后院易失守）
            if (!predEnemy && delay >= 2 && eRace <= delay)
                continue;
            let minNeed = pred.troops + 1;
            let idealNeed = minNeed;
            if (!predEnemy) {
                if (eRace < delay) {
                    minNeed += 3;
                    idealNeed += 5;
                }
                else if (eRace === delay) {
                    const bid = node.kind === 'foundry' ? 9 : node.kind === 'watchtower' ? 8 : 3;
                    minNeed += bid;
                    idealNeed += bid + 1;
                }
                if (adjFoeMax > 0) {
                    const garrison = Math.min(7, Math.ceil(adjFoeMax * 0.4) + 1);
                    idealNeed += garrison;
                }
            }
            else {
                if (delay === 0) {
                    minNeed = pred.troops + 1;
                    idealNeed = pred.troops + (adjFoeMax > 6 ? 2 : 1);
                }
                else {
                    minNeed = pred.troops + 3 + Math.ceil(adjFoeSum * 0.35);
                    idealNeed = minNeed + 2;
                }
                if (node.kind === 'foundry' || node.kind === 'watchtower') {
                    idealNeed += 1;
                }
            }
            const gain = marginalGain(node.kind);
            const deny = predEnemy ? (isDuel ? 1.0 : 0.45) * marginalLoss(node.kind, pred.owner) : 0;
            const horizon = Math.min(remain, isDuel ? 18 : 15);
            let value = (gain + deny) * horizon;
            if (node.kind === 'foundry')
                value += 16;
            if (node.kind === 'watchtower')
                value += myWatchtowers === 0 ? 28 : 10;
            if (NORMAL_KINDS.includes(node.kind) && myCounts[node.kind] % 2 === 1) {
                value += 8;
            }
            if (delay === 0)
                value += 14;
            if (!predEnemy && eRace > delay && eRace <= 2)
                value += 8;
            // 消除贴着我方老家的敌方威胁节点，战略价值极高
            if (predEnemy && freeDist[home][t] === 1)
                value += 65;
            if (predEnemy && node.kind === 'home')
                value += isDuel ? 360 : 140;
            if (predEnemy && pred.troops <= 3)
                value += 24;
            if (remain <= 35)
                value += 18;
            if (remain <= 14)
                value += 42;
            if (remain <= 5)
                value += 90;
            const delayCost = now <= 4 ? 17 : 13;
            const score = value - idealNeed * 1.9 - delay * delayCost;
            if (score > 0) {
                candidates.push({
                    target: t,
                    delay,
                    minNeed,
                    idealNeed,
                    score,
                    isHomeStrike: predEnemy && node.kind === 'home',
                });
            }
        }
    }
    candidates.sort((a, b) => b.score - a.score || a.delay - b.delay);
    const attackedTargets = new Set();
    const stagedTargets = [];
    for (const cand of candidates) {
        if (orders.length >= view.maxOrders)
            break;
        if (attackedTargets.has(cand.target))
            continue;
        const keepForSend = (s) => {
            if (evacuated.has(s))
                return 0;
            if (cand.delay === 0 && view.nodes[cand.target].owner >= 0 && !defenseMap.get(s)?.broken) {
                if (s === home) {
                    // 如果老家正在消除贴脸威胁，只留防其他邻接威胁的兵
                    const targetEst = estTroops(view.nodes[cand.target]);
                    const otherThreat = Math.max(0, adjEnemyInfo(home).sum - targetEst);
                    return Math.min(keepOf(home), Math.max(4, otherThreat + 3));
                }
                return Math.max(1, keepOf(s) - 2);
            }
            return keepOf(s);
        };
        const usableCap = (s) => capOf(s, keepForSend(s));
        // 撤离节点只许参与 0 延迟顺手收割，禁止拖着别人远征
        const pool = mine
            .filter((s) => {
            if (evacuated.has(s) && cand.delay > 0)
                return false;
            return (myHops.get(s)?.[cand.target] ?? Infinity) === cand.delay && usableCap(s) >= 1;
        })
            .sort((a, b) => {
            const evA = evacuated.has(a) ? 1 : 0;
            const evB = evacuated.has(b) ? 1 : 0;
            if (evA !== evB)
                return evB - evA;
            return usableCap(b) - usableCap(a);
        });
        if (pool.length === 0)
            continue;
        const totalAvail = pool.reduce((sum, s) => sum + usableCap(s), 0);
        if (totalAvail < cand.minNeed) {
            if (cand.score >= 12)
                stagedTargets.push({ target: cand.target, score: cand.score });
            continue;
        }
        const singleIdeal = pool.find((s) => usableCap(s) >= cand.idealNeed);
        if (singleIdeal !== undefined) {
            if (send(singleIdeal, cand.target, cand.idealNeed, keepForSend(singleIdeal)) > 0) {
                attackedTargets.add(cand.target);
                continue;
            }
        }
        const singleMin = pool.find((s) => usableCap(s) >= cand.minNeed);
        if (singleMin !== undefined) {
            if (send(singleMin, cand.target, cand.minNeed, keepForSend(singleMin)) > 0) {
                attackedTargets.add(cand.target);
                continue;
            }
        }
        // delay >= 2 时避免多点同时抽空合击（最多 2 源，且不抽老家）
        const maxCombo = cand.isHomeStrike ? 4 : cand.delay >= 2 ? 2 : 3;
        const picks = [];
        let gathered = 0;
        for (const s of pool) {
            if (gathered >= cand.idealNeed || picks.length >= maxCombo)
                break;
            if (orders.length + picks.length >= view.maxOrders)
                break;
            if (cand.delay >= 2 && s === home && pool.length > 1)
                continue;
            const give = Math.min(cand.idealNeed - gathered, usableCap(s));
            if (give >= 1) {
                picks.push({ from: s, amount: give });
                gathered += give;
            }
        }
        if (gathered >= cand.minNeed && picks.length >= 1) {
            let okAny = false;
            for (const p of picks) {
                if (send(p.from, cand.target, p.amount, keepForSend(p.from)) > 0)
                    okAny = true;
            }
            if (okAny)
                attackedTargets.add(cand.target);
        }
    }
    // ---- 阶段 4：撤离残兵 + 稳健锋矢集结 ----
    if (orders.length < view.maxOrders) {
        const isFront = (id) => view.adj[id].some((v) => view.nodes[v].owner >= 0 && view.nodes[v].owner !== me);
        const fronts = mine.filter((id) => !evacuated.has(id) && isFront(id) && id !== home);
        const anchors = [];
        const anchorScore = (id) => {
            let bestTargetDist = Infinity;
            const targets = enemyHomes.length > 0 ? enemyHomes : enemyNodes;
            for (const t of targets) {
                if (freeDist[id][t] < bestTargetDist)
                    bestTargetDist = freeDist[id][t];
            }
            let bonus = 0;
            for (const st of stagedTargets.slice(0, 2)) {
                const h = myHops.get(id)?.[st.target] ?? Infinity;
                if (h === 0)
                    bonus += 14;
                else if (h === 1)
                    bonus += 6;
            }
            return -bestTargetDist * 10 + bonus + Math.min(12, availOf(id) * 0.3);
        };
        const sortedFronts = fronts.slice().sort((a, b) => anchorScore(b) - anchorScore(a));
        for (const f of sortedFronts) {
            if (anchors.length >= 4)
                break;
            anchors.push(f);
        }
        if (anchors.length === 0) {
            for (const st of stagedTargets.slice(0, 2)) {
                let bestNode = -1;
                let bestDist = Infinity;
                for (const id of mine) {
                    if (id === home || evacuated.has(id))
                        continue;
                    const h = myHops.get(id)?.[st.target] ?? Infinity;
                    if (h < bestDist) {
                        bestDist = h;
                        bestNode = id;
                    }
                }
                if (bestNode >= 0 && !anchors.includes(bestNode))
                    anchors.push(bestNode);
            }
        }
        if (anchors.length === 0) {
            let best = -1;
            let bestD = Infinity;
            const targets = enemyHomes.length > 0 ? enemyHomes : enemyNodes;
            for (const id of mine) {
                if (id === home || evacuated.has(id))
                    continue;
                for (const t of targets) {
                    if (freeDist[id][t] < bestD) {
                        bestD = freeDist[id][t];
                        best = id;
                    }
                }
            }
            if (best >= 0)
                anchors.push(best);
        }
        const anchorSet = new Set(anchors);
        const anchorLoad = new Map();
        for (const a of anchors) {
            const incoming = arrivalsByTarget
                .get(a)
                ?.filter((x) => x.owner === me && x.at <= 2)
                .reduce((s, x) => s + x.troops, 0) ?? 0;
            anchorLoad.set(a, availOf(a) + incoming);
        }
        const shipToBestAnchor = (from, minSend, keep, maxHopAllowed = Infinity) => {
            if (orders.length >= view.maxOrders)
                return false;
            const avail = capOf(from, keep);
            if (avail < minSend)
                return false;
            let bestAnchor = -1;
            let bestScore = -Infinity;
            for (let idx = 0; idx < anchors.length; idx++) {
                const a = anchors[idx];
                if (a === from)
                    continue;
                const h = myHops.get(from)?.[a] ?? Infinity;
                if (!Number.isFinite(h) || h > maxHopAllowed)
                    continue;
                const load = anchorLoad.get(a) ?? 0;
                if (load >= 85)
                    continue;
                const rankBonus = (anchors.length - idx) * 6;
                const s = -h * 16 + rankBonus - load * 0.14;
                if (s > bestScore) {
                    bestScore = s;
                    bestAnchor = a;
                }
            }
            if (bestAnchor < 0)
                return false;
            const room = Math.max(0, 95 - (anchorLoad.get(bestAnchor) ?? 0));
            const give = Math.min(avail, room);
            if (give < minSend)
                return false;
            const sent = send(from, bestAnchor, give, keep);
            if (sent > 0) {
                anchorLoad.set(bestAnchor, (anchorLoad.get(bestAnchor) ?? 0) + sent);
                return true;
            }
            return false;
        };
        // 4A: 撤离节点优先退入零延迟（邻接）安全友军节点
        for (const id of evacuated) {
            if (orders.length >= view.maxOrders)
                break;
            if (availOf(id) < 1)
                continue;
            if (shipToBestAnchor(id, 1, 0, 0))
                continue;
            const safeFriend = mine
                .filter((f) => f !== id && !evacuated.has(f) && Number.isFinite(myHops.get(id)?.[f] ?? Infinity))
                .sort((a, b) => (myHops.get(id)?.[a] ?? Infinity) - (myHops.get(id)?.[b] ?? Infinity) || availOf(a) - availOf(b))[0];
            if (safeFriend !== undefined)
                send(id, safeFriend, availOf(id), 0);
        }
        // 4B: 非锋点向前线锋点输送，近敌纵深大部队不跨图远跳
        const shippers = mine
            .filter((id) => !evacuated.has(id) && (!anchorSet.has(id) || availOf(id) >= 88))
            .sort((a, b) => capOf(b) - capOf(a));
        for (const id of shippers) {
            if (orders.length >= view.maxOrders)
                break;
            const curLoad = availOf(id);
            const overfull = curLoad >= 88;
            if (endgameLead && !overfull)
                continue;
            if (id === home) {
                if (defenseMap.get(home)?.broken)
                    continue;
                const homeFlowKeep = keepOf(home) + (now <= 5 ? 0 : 2);
                shipToBestAnchor(home, overfull ? 1 : 4, homeFlowKeep);
            }
            else {
                // 距敌 <= 2 步的二线重兵只允许向邻接（delay=0）锋点增援，避免在途暴露纵深
                let minFoeD = Infinity;
                for (const eid of enemyNodes) {
                    if (freeDist[id][eid] < minFoeD)
                        minFoeD = freeDist[id][eid];
                }
                const maxHop = minFoeD <= 2 && curLoad >= 15 && !overfull ? 0 : Infinity;
                const keep = overfull ? 1 : keepOf(id);
                shipToBestAnchor(id, overfull ? 1 : 3, keep, maxHop);
            }
        }
    }
    return orders;
}
export function createTianshu() {
    return {
        name: '天枢',
        style: '精确推演 · 协同绝杀',
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
