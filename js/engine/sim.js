/**
 * 裁判 / 模拟核心
 *
 * 一回合的完整流程（对应规则文档）：
 *   1. 双方同时提交指令（互不可见）
 *   2. 校验并出兵：指令立刻从起点扣除兵力，纵队按最短路开始行军
 *   3. 结算：本回合到达的纵队与守军在同一节点上按「兵力最多者胜」结算
 *   4. 判负：老家易主即淘汰
 *   5. 产出：回合结束时所有己方节点产兵
 *   6. 回合数 +1
 *
 * 所有函数都不含随机性（地图生成除外），同样的输入永远得到同样的输出。
 */
import { seedFrom } from './rng.js';
import { generateMap } from './mapgen.js';
import { NEUTRAL, RULES, } from './types.js';
// ---------------------------------------------------------------------------
// 建立对局
// ---------------------------------------------------------------------------
export function createGame(mode, seed, names) {
    const map = generateMap(mode, seed);
    const nodes = map.nodes.map((node) => ({ owner: NEUTRAL, troops: node.garrison }));
    map.homes.forEach((home, index) => {
        nodes[home].owner = index;
        nodes[home].troops = RULES.homeStart;
    });
    const players = map.homes.map((_, index) => ({
        id: index,
        name: names[index] ?? `玩家 ${index + 1}`,
        alive: true,
        eliminatedTurn: null,
    }));
    return {
        map,
        turn: 1,
        nodes,
        columns: [],
        players,
        nextColumnId: 1,
    };
}
// ---------------------------------------------------------------------------
// 产出
// ---------------------------------------------------------------------------
export function countKinds(state, owner) {
    const counts = {
        home: 0,
        farm: 0,
        mine: 0,
        lab: 0,
        watchtower: 0,
        foundry: 0,
    };
    if (owner === NEUTRAL)
        return counts;
    for (let i = 0; i < state.nodes.length; i++) {
        if (state.nodes[i].owner === owner)
            counts[state.map.nodes[i].kind]++;
    }
    return counts;
}
export function productionForKind(kind, counts) {
    switch (kind) {
        case 'home':
            return RULES.homeProduction;
        case 'foundry':
            return RULES.baseProduction + RULES.foundryBonus;
        case 'watchtower':
            return RULES.baseProduction;
        default:
            return RULES.baseProduction + Math.floor(counts[kind] / 2);
    }
}
export function nodeProduction(state, nodeId) {
    const owner = state.nodes[nodeId].owner;
    if (owner === NEUTRAL)
        return 0;
    return productionForKind(state.map.nodes[nodeId].kind, countKinds(state, owner));
}
export function playerProduction(state, owner) {
    if (owner === NEUTRAL)
        return 0;
    const counts = countKinds(state, owner);
    let total = 0;
    for (let i = 0; i < state.nodes.length; i++) {
        if (state.nodes[i].owner !== owner)
            continue;
        total += productionForKind(state.map.nodes[i].kind, counts);
    }
    return total;
}
function produceAtEndOfTurn(state, owner) {
    const counts = countKinds(state, owner);
    let total = 0;
    for (let i = 0; i < state.nodes.length; i++) {
        if (state.nodes[i].owner !== owner)
            continue;
        const gain = productionForKind(state.map.nodes[i].kind, counts);
        state.nodes[i].troops = Math.min(RULES.maxTroops, state.nodes[i].troops + gain);
        total += gain;
    }
    return total;
}
// ---------------------------------------------------------------------------
// 视野
// ---------------------------------------------------------------------------
export function computeVision(kinds, owners, adj, player) {
    const visible = new Array(owners.length).fill(false);
    for (let i = 0; i < owners.length; i++) {
        if (owners[i] !== player)
            continue;
        const kind = kinds[i];
        const radius = kind === 'home' ? RULES.homeVision : kind === 'watchtower' ? RULES.watchtowerVision : RULES.normalVision;
        visible[i] = true;
        let frontier = [i];
        for (let depth = 0; depth < radius; depth++) {
            const next = [];
            for (const u of frontier) {
                for (const v of adj[u]) {
                    if (!visible[v]) {
                        visible[v] = true;
                        next.push(v);
                    }
                }
            }
            frontier = next;
        }
    }
    return visible;
}
export function visionSet(state, player) {
    return computeVision(state.map.nodes.map((n) => n.kind), state.nodes.map((n) => n.owner), state.map.adj, player);
}
// ---------------------------------------------------------------------------
// 寻路
// ---------------------------------------------------------------------------
/** 最短路：可以经过己方与中立节点，但不能穿过敌方节点；终点本身可以是敌方节点。 */
export function findPath(state, from, to) {
    if (from === to)
        return null;
    if (from < 0 || to < 0 || from >= state.nodes.length || to >= state.nodes.length)
        return null;
    const mover = state.nodes[from].owner;
    if (mover === NEUTRAL)
        return null;
    const n = state.nodes.length;
    const prev = new Array(n).fill(-1);
    prev[from] = from;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of state.map.adj[u]) {
            if (prev[v] !== -1)
                continue;
            if (v !== to) {
                const owner = state.nodes[v].owner;
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
                path.reverse();
                return path;
            }
            queue.push(v);
        }
    }
    return null;
}
/** 纵队从起点出发到终点需要几回合（相邻 = 0）。 */
export function travelTurns(path) {
    return Math.max(0, path.length - 2);
}
export function validateOrders(state, player, raw) {
    const rejected = [];
    const orders = [];
    if (!Array.isArray(raw)) {
        rejected.push({ order: raw, reason: '没有返回指令数组' });
        return { orders, rejected };
    }
    if (raw.length > RULES.maxOrders) {
        for (const extra of raw.slice(RULES.maxOrders)) {
            rejected.push({ order: extra, reason: `每回合最多 ${RULES.maxOrders} 条指令` });
        }
    }
    const used = new Map();
    const seen = new Set();
    for (const item of raw.slice(0, RULES.maxOrders)) {
        if (!item || typeof item !== 'object') {
            rejected.push({ order: item, reason: '指令不是对象' });
            continue;
        }
        const record = item;
        const from = Math.floor(Number(record.from));
        const to = Math.floor(Number(record.to));
        const troops = Math.floor(Number(record.troops));
        if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(troops)) {
            rejected.push({ order: item, reason: 'from/to/troops 必须是数字' });
            continue;
        }
        if (from < 0 || from >= state.nodes.length || to < 0 || to >= state.nodes.length) {
            rejected.push({ order: item, reason: '节点编号越界' });
            continue;
        }
        if (from === to) {
            rejected.push({ order: item, reason: '起点和终点相同' });
            continue;
        }
        if (state.nodes[from].owner !== player) {
            rejected.push({ order: item, reason: '起点不是你的节点' });
            continue;
        }
        if (troops < 1) {
            rejected.push({ order: item, reason: '兵力必须 ≥ 1' });
            continue;
        }
        const already = used.get(from) ?? 0;
        if (already + troops > state.nodes[from].troops) {
            rejected.push({ order: item, reason: '该节点可用兵力不足' });
            continue;
        }
        const key = `${from}>${to}`;
        if (seen.has(key)) {
            rejected.push({ order: item, reason: '重复指令' });
            continue;
        }
        if (!findPath(state, from, to)) {
            rejected.push({ order: item, reason: '没有可通行的路径' });
            continue;
        }
        orders.push({ from, to, troops });
        used.set(from, already + troops);
        seen.add(key);
    }
    return { orders, rejected };
}
export function playTurn(state, inputs) {
    const turn = state.turn;
    const events = [];
    // 1. 同时校验（必须都在出兵之前完成）
    const orderSets = inputs.map((input) => {
        const result = validateOrders(state, input.player, input.orders);
        for (const rejection of result.rejected) {
            events.push({ turn, type: 'invalid', player: input.player, reason: rejection.reason });
        }
        return { player: input.player, orders: result.orders, rejected: result.rejected };
    });
    // 2. 出兵
    for (const set of orderSets) {
        for (const order of set.orders) {
            const source = state.nodes[order.from];
            if (source.owner !== set.player || source.troops < order.troops)
                continue;
            const path = findPath(state, order.from, order.to);
            if (!path)
                continue;
            source.troops -= order.troops;
            state.columns.push({
                id: state.nextColumnId++,
                owner: set.player,
                troops: order.troops,
                path,
                departTurn: turn,
                arriveTurn: turn + travelTurns(path),
            });
        }
    }
    // 3. 结算到达的纵队
    const arriving = state.columns.filter((column) => column.arriveTurn <= turn);
    if (arriving.length > 0) {
        state.columns = state.columns.filter((column) => column.arriveTurn > turn);
        const byTarget = new Map();
        for (const column of arriving) {
            const target = column.path[column.path.length - 1];
            const list = byTarget.get(target) ?? [];
            list.push(column);
            byTarget.set(target, list);
        }
        for (const [nodeId, columns] of byTarget) {
            resolveNode(state, nodeId, columns, events, turn);
        }
    }
    // 4. 判负：老家易主即淘汰
    for (const player of state.players) {
        if (!player.alive)
            continue;
        const home = state.map.homes[player.id];
        if (state.nodes[home].owner !== player.id) {
            player.alive = false;
            player.eliminatedTurn = turn;
            events.push({ turn, type: 'eliminated', player: player.id, killer: state.nodes[home].owner });
        }
    }
    // 四人混战：被淘汰者的地盘立即中立化，避免留下「僵尸领地」
    if (state.map.mode === 'ffa') {
        for (const player of state.players) {
            if (player.alive || player.eliminatedTurn !== turn)
                continue;
            for (const node of state.nodes) {
                if (node.owner === player.id) {
                    node.owner = NEUTRAL;
                    node.troops = 0;
                }
            }
            state.columns = state.columns.filter((column) => column.owner !== player.id);
        }
    }
    // 5. 产出
    const production = state.players.map((player) => player.alive ? produceAtEndOfTurn(state, player.id) : 0);
    const outcome = { turn, orderSets, events, production };
    state.turn++;
    return outcome;
}
/**
 * 单节点结算（纯函数，方便单测）：
 *   各方兵力汇总（同一玩家多支纵队合并）→ 最多者胜 → 剩余 = 最多 − 第二多
 *   平局：守方保留节点，兵力归零（中立点仍是中立）
 */
export function resolveCombat(defender, garrison, arrivals) {
    const sides = new Map();
    sides.set(defender, garrison);
    for (const arrival of arrivals) {
        sides.set(arrival.owner, (sides.get(arrival.owner) ?? 0) + arrival.troops);
    }
    const entries = [...sides.entries()].sort((a, b) => b[1] - a[1]);
    const max = entries[0][1];
    const tied = entries.filter((entry) => entry[1] === max).length > 1;
    if (tied) {
        return { owner: defender, troops: 0, winner: null, tied: true, losses: max };
    }
    const [winner, troops] = entries[0];
    const second = entries.length > 1 ? entries[1][1] : 0;
    const remain = Math.min(RULES.maxTroops, Math.max(0, troops - second));
    const total = entries.reduce((sum, entry) => sum + entry[1], 0);
    return {
        owner: winner,
        troops: remain,
        winner,
        tied: false,
        losses: total - remain,
    };
}
function resolveNode(state, nodeId, columns, events, turn) {
    const node = state.nodes[nodeId];
    const before = node.owner;
    const result = resolveCombat(node.owner, node.troops, columns.map((column) => ({ owner: column.owner, troops: column.troops })));
    node.owner = result.owner;
    node.troops = result.troops;
    if (node.owner !== before) {
        events.push({ turn, type: 'capture', node: nodeId, from: before, to: node.owner });
    }
}
// ---------------------------------------------------------------------------
// 观察（bot 的输入）
// ---------------------------------------------------------------------------
export function observe(state, player) {
    const visible = visionSet(state, player);
    const countsByOwner = new Map();
    for (const info of state.players)
        countsByOwner.set(info.id, countKinds(state, info.id));
    const nodes = state.map.nodes.map((mapNode, id) => {
        const node = state.nodes[id];
        const seen = visible[id];
        const known = node.owner === NEUTRAL || node.owner === player || seen;
        return {
            id,
            kind: mapNode.kind,
            owner: node.owner,
            troops: known ? node.troops : null,
            visible: seen,
            production: node.owner === NEUTRAL
                ? 0
                : productionForKind(mapNode.kind, countsByOwner.get(node.owner)),
        };
    });
    const columns = state.columns
        .filter((column) => column.path.some((id) => visible[id]))
        .map((column) => ({
        owner: column.owner,
        troops: column.troops,
        path: column.path.slice(),
        departTurn: column.departTurn,
        arriveTurn: column.arriveTurn,
    }));
    const players = state.players.map((info) => {
        let nodeCount = 0;
        let production = 0;
        let troops = 0;
        for (let i = 0; i < state.nodes.length; i++) {
            if (state.nodes[i].owner !== info.id)
                continue;
            nodeCount++;
            production += productionForKind(state.map.nodes[i].kind, countsByOwner.get(info.id));
            troops += state.nodes[i].troops;
        }
        return {
            id: info.id,
            name: info.name,
            alive: info.alive,
            nodes: nodeCount,
            production,
            totalTroops: info.id === player ? troops : null,
            eliminatedTurn: info.eliminatedTurn,
        };
    });
    return {
        turn: state.turn,
        maxTurns: RULES.maxTurns,
        mode: state.map.mode,
        you: player,
        homeNode: state.map.homes[player],
        nodes,
        adj: state.map.adj.map((neighbors) => neighbors.slice()),
        columns,
        players,
        ordersLeft: RULES.maxOrders,
        maxOrders: RULES.maxOrders,
        rngSeed: seedFrom(state.map.seed, state.turn, player),
    };
}
// ---------------------------------------------------------------------------
// 终局判定辅助
// ---------------------------------------------------------------------------
export function totalTroops(state, player) {
    let total = 0;
    for (const node of state.nodes)
        if (node.owner === player)
            total += node.troops;
    for (const column of state.columns)
        if (column.owner === player)
            total += column.troops;
    return total;
}
export function nodeCount(state, player) {
    let total = 0;
    for (const node of state.nodes)
        if (node.owner === player)
            total++;
    return total;
}
export function alivePlayers(state) {
    return state.players.filter((player) => player.alive).map((player) => player.id);
}
