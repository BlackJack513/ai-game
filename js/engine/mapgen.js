/**
 * 随机地图生成器
 *
 * 目标：
 *  1. 完全对称 —— 每个玩家拿到的地形在几何上等价（C2 或 C4 旋转对称）。
 *  2. 可验证 —— 连通、老家之间有足够距离、节点类型数量精确。
 *  3. 好看 —— 用「边轨道」做贪心平面化连线，避免交叉线。
 *
 * 做法：
 *  - 在基本域（半个/四分之一个地图）里撒点，旋转复制出整张图。
 *  - 把「所有点对」按对称群分组，一组边要么全部加上、要么全部不加，
 *    这样对称性在构造上就是精确的。
 */
import { Rng } from './rng.js';
import { NEUTRAL, RULES } from './types.js';
const SPECS = {
    duel: {
        mode: 'duel',
        players: 2,
        order: 2,
        basePoints: 8,
        region: { x0: 0.56, y0: 0.08, x1: 0.94, y1: 0.92 },
        minDist: 0.135,
        maxLen: 0.37,
        maxDegree: 4,
        home: { x: 0.08, y: 0.5 },
        minHomeDist: 4,
    },
    ffa: {
        mode: 'ffa',
        players: 4,
        order: 4,
        basePoints: 8,
        region: { x0: 0.56, y0: 0.06, x1: 0.94, y1: 0.44 },
        minDist: 0.105,
        maxLen: 0.3,
        maxDegree: 4,
        home: { x: 0.5, y: 0.1 },
        minHomeDist: 3,
    },
};
// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------
function step(p, order) {
    // order 2: 绕中心 180°；order 4: 绕中心逆时针 90°
    return order === 2 ? { x: 1 - p.x, y: 1 - p.y } : { x: 1 - p.y, y: p.x };
}
function rotate(p, k, order) {
    let q = p;
    for (let i = 0; i < k; i++)
        q = step(q, order);
    return q;
}
function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}
function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
/** 两条线段是否真正相交（共享端点不算）。 */
function segmentsCross(a, b, c, d) {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    const eps = 1e-9;
    return (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
        ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps)));
}
function pointSegDist(p, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0)
        return Math.hypot(wx, wy);
    let t = (wx * vx + wy * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}
// ---------------------------------------------------------------------------
// 撒点
// ---------------------------------------------------------------------------
function sampleBasePoints(spec, rng) {
    let minDist = spec.minDist;
    for (let round = 0; round < 8; round++) {
        const points = [];
        const homes = [];
        for (let k = 0; k < spec.order; k++)
            homes.push(rotate(spec.home, k, spec.order));
        let attempts = 0;
        while (points.length < spec.basePoints && attempts < 4000) {
            attempts++;
            const p = {
                x: rng.range(spec.region.x0, spec.region.x1),
                y: rng.range(spec.region.y0, spec.region.y1),
            };
            const copies = [];
            for (let k = 0; k < spec.order; k++)
                copies.push(rotate(p, k, spec.order));
            let ok = true;
            // 候选点自己的各个复制之间
            for (let i = 0; i < copies.length && ok; i++) {
                for (let j = i + 1; j < copies.length && ok; j++) {
                    if (dist2(copies[i], copies[j]) < minDist * minDist)
                        ok = false;
                }
            }
            // 与已有基本点（及其复制）之间
            for (const q of points) {
                const qs = [];
                for (let k = 0; k < spec.order; k++)
                    qs.push(rotate(q, k, spec.order));
                for (const a of copies) {
                    for (const b of qs) {
                        if (dist2(a, b) < minDist * minDist) {
                            ok = false;
                            break;
                        }
                    }
                    if (!ok)
                        break;
                }
                if (!ok)
                    break;
            }
            // 与老家之间
            for (const a of copies) {
                for (const h of homes) {
                    if (dist2(a, h) < minDist * minDist) {
                        ok = false;
                        break;
                    }
                }
                if (!ok)
                    break;
            }
            if (ok)
                points.push(p);
        }
        if (points.length === spec.basePoints)
            return points;
        minDist *= 0.9;
    }
    return [];
}
// ---------------------------------------------------------------------------
// 构建节点与对称置换
// ---------------------------------------------------------------------------
function buildNodes(spec, base) {
    const nodes = [];
    for (let k = 0; k < spec.players; k++) {
        const p = rotate(spec.home, k, spec.order);
        nodes.push({
            id: nodes.length,
            x: p.x,
            y: p.y,
            kind: 'home',
            garrison: RULES.homeStart,
        });
    }
    for (let i = 0; i < base.length; i++) {
        for (let k = 0; k < spec.order; k++) {
            const p = rotate(base[i], k, spec.order);
            nodes.push({
                id: nodes.length,
                x: p.x,
                y: p.y,
                kind: 'farm',
                garrison: 0,
            });
        }
    }
    return nodes;
}
/**
 * perms[k][id] = 把节点 id 旋转 k 次后落在的节点 id。
 * 节点按「组」排列：每组 order 个互为旋转的节点。
 */
function buildPerms(spec, count) {
    const perms = [];
    for (let k = 0; k < spec.order; k++) {
        const perm = new Array(count);
        for (let id = 0; id < count; id++) {
            let start;
            if (id < spec.players)
                start = 0;
            else
                start = spec.players + Math.floor((id - spec.players) / spec.order) * spec.order;
            const c = (id - start) % spec.order;
            perm[id] = start + ((c + k) % spec.order);
        }
        perms.push(perm);
    }
    return perms;
}
// ---------------------------------------------------------------------------
// 连边：按「边轨道」贪心加边
// ---------------------------------------------------------------------------
function canonicalPair(a, b, perms) {
    let best = '';
    for (const p of perms) {
        const x = Math.min(p[a], p[b]);
        const y = Math.max(p[a], p[b]);
        const key = `${String(x).padStart(3, '0')}:${String(y).padStart(3, '0')}`;
        if (best === '' || key < best)
            best = key;
    }
    return best;
}
function buildEdges(nodes, perms, spec) {
    const n = nodes.length;
    const seen = new Set();
    const orbits = [];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const key = canonicalPair(i, j, perms);
            if (seen.has(key))
                continue;
            seen.add(key);
            const pairKeys = new Set();
            for (const p of perms) {
                const a = Math.min(p[i], p[j]);
                const b = Math.max(p[i], p[j]);
                pairKeys.add(`${a},${b}`);
            }
            const pairs = [...pairKeys].map((s) => s.split(',').map(Number));
            const len = Math.min(...pairs.map(([a, b]) => Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y)));
            orbits.push({ pairs, len });
        }
    }
    orbits.sort((a, b) => a.len - b.len);
    const degree = new Array(n).fill(0);
    const edges = [];
    const edgeKeys = new Set();
    const addOrbit = (orbit) => {
        for (const [a, b] of orbit.pairs) {
            const key = `${Math.min(a, b)},${Math.max(a, b)}`;
            if (edgeKeys.has(key))
                continue;
            edgeKeys.add(key);
            edges.push([a, b]);
            degree[a]++;
            degree[b]++;
        }
    };
    const blockedByNode = (a, b) => {
        for (let k = 0; k < n; k++) {
            if (k === a || k === b)
                continue;
            if (pointSegDist(nodes[k], nodes[a], nodes[b]) < 0.022)
                return true;
        }
        return false;
    };
    for (const orbit of orbits) {
        if (orbit.len > spec.maxLen)
            continue;
        const use = new Array(n).fill(0);
        for (const [a, b] of orbit.pairs) {
            use[a]++;
            use[b]++;
        }
        let ok = true;
        for (const [a, b] of orbit.pairs) {
            if (degree[a] + use[a] > spec.maxDegree || degree[b] + use[b] > spec.maxDegree) {
                ok = false;
                break;
            }
        }
        if (!ok)
            continue;
        for (const [a, b] of orbit.pairs) {
            if (blockedByNode(a, b)) {
                ok = false;
                break;
            }
            for (const [c, d] of edges) {
                if (a === c || a === d || b === c || b === d)
                    continue;
                if (segmentsCross(nodes[a], nodes[b], nodes[c], nodes[d])) {
                    ok = false;
                    break;
                }
            }
            if (!ok)
                break;
        }
        if (!ok)
            continue;
        addOrbit(orbit);
    }
    // 连通性修复：每次挑一条能连接两个连通块的边轨道，整组加入。
    const added = new Set();
    for (const [a, b] of edges)
        added.add(`${Math.min(a, b)},${Math.max(a, b)}`);
    for (let guard = 0; guard < n; guard++) {
        const parent = new Array(n).fill(0).map((_, i) => i);
        const find = (x) => {
            while (parent[x] !== x) {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            return x;
        };
        const union = (x, y) => {
            const rx = find(x);
            const ry = find(y);
            if (rx !== ry)
                parent[rx] = ry;
        };
        for (const [a, b] of edges)
            union(a, b);
        const roots = new Set();
        for (let i = 0; i < n; i++)
            roots.add(find(i));
        if (roots.size === 1)
            break;
        let best = null;
        for (const orbit of orbits) {
            const key = orbit.pairs.map(([a, b]) => `${Math.min(a, b)},${Math.max(a, b)}`).sort()[0];
            if (added.has(key))
                continue;
            const connects = orbit.pairs.some(([a, b]) => find(a) !== find(b));
            if (!connects)
                continue;
            if (!best || orbit.len < best.len)
                best = orbit;
        }
        if (!best)
            break;
        addOrbit(best);
        for (const [a, b] of best.pairs)
            added.add(`${Math.min(a, b)},${Math.max(a, b)}`);
    }
    if (edges.length < n - 1)
        return null;
    return edges;
}
// ---------------------------------------------------------------------------
// 类型 / 守军
// ---------------------------------------------------------------------------
function assignKinds(nodes, spec, rng) {
    const groups = [];
    for (let g = 0; g < spec.basePoints; g++) {
        const start = spec.players + g * spec.order;
        const radius = Math.hypot(nodes[start].x - 0.5, nodes[start].y - 0.5);
        groups.push({ start, radius });
    }
    groups.sort((a, b) => a.radius - b.radius);
    const specials = rng.next() < 0.5 ? ['watchtower', 'foundry'] : ['foundry', 'watchtower'];
    for (let g = 0; g < 2; g++) {
        for (let k = 0; k < spec.order; k++)
            nodes[groups[g].start + k].kind = specials[g];
    }
    const rest = rng.shuffle(['farm', 'farm', 'mine', 'mine', 'lab', 'lab']);
    for (let g = 2; g < groups.length; g++) {
        for (let k = 0; k < spec.order; k++)
            nodes[groups[g].start + k].kind = rest[g - 2];
    }
}
function bfsDistances(adj, sources) {
    const dist = new Array(adj.length).fill(Infinity);
    const queue = [];
    for (const s of sources) {
        dist[s] = 0;
        queue.push(s);
    }
    for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const v of adj[u]) {
            if (dist[v] === Infinity) {
                dist[v] = dist[u] + 1;
                queue.push(v);
            }
        }
    }
    return dist;
}
function assignGarrison(nodes, spec, rng, dist) {
    for (const node of nodes) {
        if (node.kind === 'home')
            continue;
        const special = node.kind === 'watchtower' || node.kind === 'foundry';
        const base = 3 + (Number.isFinite(dist[node.id]) ? dist[node.id] : 8);
        const value = base + rng.int(2) + (special ? 2 : 0);
        node.garrison = Math.max(3, Math.min(10, value));
    }
    void spec;
}
// ---------------------------------------------------------------------------
// 校验与入口
// ---------------------------------------------------------------------------
function validate(nodes, adj, homes, spec) {
    const n = nodes.length;
    // 连通
    const seen = new Array(n).fill(false);
    const queue = [0];
    seen[0] = true;
    for (let qi = 0; qi < queue.length; qi++) {
        for (const v of adj[queue[qi]]) {
            if (!seen[v]) {
                seen[v] = true;
                queue.push(v);
            }
        }
    }
    if (queue.length !== n)
        return false;
    // 每个节点至少一条边
    for (let i = 0; i < n; i++)
        if (adj[i].length === 0)
            return false;
    // 老家之间距离
    const dist = bfsDistances(adj, [homes[0]]);
    for (let i = 1; i < homes.length; i++) {
        if (!Number.isFinite(dist[homes[i]]) || dist[homes[i]] < spec.minHomeDist)
            return false;
    }
    // 类型数量：8 组地形里，2 组是特殊节点，剩下 6 组平分给农场/矿场/研究院
    const normalPerKind = ((spec.basePoints - 2) / 3) * spec.order;
    const expected = {
        home: spec.players,
        farm: normalPerKind,
        mine: normalPerKind,
        lab: normalPerKind,
        watchtower: spec.order,
        foundry: spec.order,
    };
    const counts = {};
    for (const node of nodes)
        counts[node.kind] = (counts[node.kind] ?? 0) + 1;
    for (const [kind, want] of Object.entries(expected)) {
        if ((counts[kind] ?? 0) !== want)
            return false;
    }
    return true;
}
function tryGenerate(spec, seed) {
    const rng = new Rng(seed);
    const base = sampleBasePoints(spec, rng);
    if (base.length !== spec.basePoints)
        return null;
    const nodes = buildNodes(spec, base);
    const homes = nodes.slice(0, spec.players).map((n) => n.id);
    const perms = buildPerms(spec, nodes.length);
    const edges = buildEdges(nodes, perms, spec);
    if (!edges)
        return null;
    const adj = Array.from({ length: nodes.length }, () => []);
    for (const [a, b] of edges) {
        adj[a].push(b);
        adj[b].push(a);
    }
    assignKinds(nodes, spec, rng);
    // 类型会改变特殊节点的守军，因此先算类型再算守军。
    const dist = bfsDistances(adj, homes);
    assignGarrison(nodes, spec, rng, dist);
    if (!validate(nodes, adj, homes, spec))
        return null;
    return {
        seed,
        mode: spec.mode,
        nodes,
        edges,
        adj,
        homes,
    };
}
/**
 * 生成一张地图。同样的 (mode, seed) 一定得到同一张图。
 * 如果某个种子生成出的地图不满足公平性校验，会按固定序列换种子重试。
 */
export function generateMap(mode, seed) {
    const spec = SPECS[mode];
    const baseSeed = seed >>> 0 || 1;
    for (let attempt = 0; attempt < 64; attempt++) {
        const candidateSeed = (baseSeed + attempt * 7919) >>> 0 || 1;
        const map = tryGenerate(spec, candidateSeed);
        if (map) {
            // 对外保留用户输入的种子，方便「同一种子 = 同一张图」
            return { ...map, seed: baseSeed };
        }
    }
    throw new Error(`无法为种子 ${seed} 生成合格的 ${mode} 地图`);
}
/** 地图上每个玩家的初始中立守军（调试用）。 */
export function neutralTotal(map) {
    return map.nodes.filter((n) => n.kind !== 'home').reduce((sum, n) => sum + n.garrison, 0);
}
export { NEUTRAL };
export const __debug = {
    SPECS,
    sampleBasePoints,
    buildNodes,
    buildPerms,
    buildEdges,
    validate,
    assignKinds,
    assignGarrison,
    bfsDistances,
};
