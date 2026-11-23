/**
 * 陪练 bot 共用的规划工具。
 *
 * 所有 bot 都只能使用 Observation 里公开的信息（见规则文档的战争迷雾），
 * 因此这里不提供任何「偷看全图」的捷径。
 */
import { NEUTRAL } from '../engine/types.js';
/** 从 from 到 to 的最短路；可以经过己方与中立节点，但不能穿过敌方节点。 */
export function buildPath(view, from, to) {
    if (from === to)
        return null;
    if (view.nodes[from].owner !== view.you)
        return null;
    const prev = new Array(view.nodes.length).fill(-1);
    prev[from] = from;
    const queue = [from];
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of view.adj[u]) {
            if (prev[v] !== -1)
                continue;
            if (v !== to) {
                const owner = view.nodes[v].owner;
                if (owner !== NEUTRAL && owner !== view.you)
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
/** 沿最短路要走几回合（相邻 = 0）。 */
export function hops(view, from, to) {
    const path = buildPath(view, from, to);
    return path ? Math.max(0, path.length - 2) : Infinity;
}
/** 忽略敌我阻挡的「地图距离」，用于粗糙的远近判断。 */
export function mapDistances(view, sources) {
    const dist = new Array(view.nodes.length).fill(Infinity);
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
export function ownNodes(view) {
    return view.nodes.filter((node) => node.owner === view.you);
}
export function enemyNodes(view) {
    return view.nodes.filter((node) => node.owner >= 0 && node.owner !== view.you);
}
/** 视野外的敌方节点只知道归属：按「中位守军」估算，避免 bot 依赖上帝视角。 */
export const UNKNOWN_GARRISON = 4;
export function defenseOf(node) {
    return node.troops ?? UNKNOWN_GARRISON;
}
export function nodeValue(node) {
    if (node.kind === 'home')
        return 1000;
    return node.production * 12 + 10;
}
/** 本回合可见的、正在飞向某个节点的敌方兵力。 */
export function incomingThreat(view, nodeId) {
    let total = 0;
    for (const column of view.columns) {
        if (column.owner === view.you)
            continue;
        const target = column.path[column.path.length - 1];
        if (target !== nodeId)
            continue;
        if (column.arriveTurn > view.turn + 2)
            continue;
        total += column.troops;
    }
    return total;
}
/** 本回合可见的、正在飞向某个节点的己方兵力。 */
export function incomingFriend(view, nodeId) {
    let total = 0;
    for (const column of view.columns) {
        if (column.owner !== view.you)
            continue;
        if (column.path[column.path.length - 1] !== nodeId)
            continue;
        total += column.troops;
    }
    return total;
}
/** 一个节点正常应该留多少守军：老家最金贵，前线次之。 */
export function garrisonKeep(view, node) {
    if (node.kind === 'home')
        return 6;
    if (isFrontline(view, node))
        return 2;
    return 1;
}
/** 与敌方节点相邻的己方节点（前线）。 */
export function isFrontline(view, node) {
    return view.adj[node.id].some((id) => {
        const owner = view.nodes[id].owner;
        return owner >= 0 && owner !== view.you;
    });
}
/**
 * 指令缓冲区：保证不超过每回合指令上限，也不会从同一个节点重复抽调超过它拥有的兵力。
 */
export class CommandBuffer {
    view;
    orders = [];
    used = new Map();
    constructor(view) {
        this.view = view;
    }
    available(nodeId) {
        const node = this.view.nodes[nodeId];
        if (node.owner !== this.view.you)
            return 0;
        return (node.troops ?? 0) - (this.used.get(nodeId) ?? 0);
    }
    /** 从节点里最多能派出多少兵而留出 keep 的守军。 */
    capacity(nodeId, keep = 0) {
        return Math.max(0, this.available(nodeId) - keep);
    }
    send(from, to, troops) {
        if (this.orders.length >= this.view.maxOrders)
            return false;
        const amount = Math.min(Math.floor(troops), this.capacity(from));
        if (amount < 1)
            return false;
        if (!buildPath(this.view, from, to))
            return false;
        if (this.orders.some((order) => order.from === from && order.to === to))
            return false;
        this.orders.push({ from, to, troops: amount });
        this.used.set(from, (this.used.get(from) ?? 0) + amount);
        return true;
    }
    /** 从「离目标最近、且兵力最充足」的节点派兵，最多动用 maxSources 个节点。 */
    sendFromClosest(to, troops, keep = 1, maxSources = 2) {
        let remaining = troops;
        const candidates = this.view.nodes
            .filter((node) => node.owner === this.view.you && this.capacity(node.id, keep) > 0)
            .map((node) => ({ node, dist: hops(this.view, node.id, to) }))
            .filter((entry) => Number.isFinite(entry.dist))
            .sort((a, b) => a.dist - b.dist || b.node.troops - a.node.troops);
        let sent = 0;
        for (const { node } of candidates.slice(0, maxSources)) {
            if (remaining <= 0)
                break;
            const amount = Math.min(remaining, this.capacity(node.id, keep));
            if (amount < 1)
                continue;
            if (this.send(node.id, to, amount)) {
                remaining -= amount;
                sent += amount;
            }
        }
        return sent;
    }
}
export function pick(list, seed) {
    if (list.length === 0)
        throw new Error('pick from empty list');
    const x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    return list[x % list.length];
}
