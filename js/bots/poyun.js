/**
 * 破云 —— 单挑专精 bot（专门针对破军）
 *
 * 核心思路（从规则独立推导）：
 *  1. 破军老家只留极少兵，靠三个邻点同回合回防；先砸掉它最强的邻点，
 *     就切断了一路回防，并在其家门口建立桥头堡。
 *  2. 桥头堡就地生产，同时把其余邻点拆掉，进一步掏空回防来源。
 *  3. 第 5 回合起从所有桥头堡全力斩首；之后每回合持续攻击。
 *
 * 纯函数，只依赖 view，不跨回合保存状态。
 */
function bfsDist(adj, src) {
    const d = new Array(adj.length).fill(1e9);
    d[src] = 0;
    const q = [src];
    for (let i = 0; i < q.length; i++) {
        for (const v of adj[q[i]]) {
            if (d[v] === 1e9) {
                d[v] = d[q[i]] + 1;
                q.push(v);
            }
        }
    }
    return d;
}
/** 引擎的可通行判定：可穿己方与中立节点，不能穿其他敌方节点（终点本身例外）。 */
function reachable(view, from, to, me) {
    const seen = new Array(view.nodes.length).fill(false);
    seen[from] = true;
    const q = [from];
    for (let i = 0; i < q.length; i++) {
        for (const v of view.adj[q[i]]) {
            if (seen[v])
                continue;
            if (v === to)
                return true;
            if (view.nodes[v].owner !== -1 && view.nodes[v].owner !== me)
                continue;
            seen[v] = true;
            q.push(v);
        }
    }
    return false;
}
/** 桥头堡评分：守军越高越好（通常意味着兵工厂/瞭望塔本身产能高），同分取离我方更近者。 */
function bridgeScore(view, ring, dist, home, me) {
    let best;
    for (const id of ring) {
        if (!reachable(view, home, id, me))
            continue; // 部分邻点只连敌方老家，无路可达
        if (best === undefined) {
            best = id;
            continue;
        }
        const g = (view.nodes[id].troops ?? 0) - (view.nodes[best].troops ?? 0);
        if (g > 0 || (g === 0 && dist[id] < dist[best]))
            best = id;
    }
    return best;
}
export function createPoyun() {
    return {
        name: '破云',
        style: '破环断援 · 桥头蓄势 · 贴脸斩首',
        decide(view) {
            if (view.mode !== 'duel')
                return [];
            const me = view.you;
            const home = view.homeNode;
            const foeHome = view.nodes.find((n) => n.kind === 'home' && n.id !== home).id;
            const orders = [];
            const ring = view.adj[foeHome];
            const dist = bfsDist(view.adj, home);
            // 回合 1：全兵砸向破军最强的家门口邻点。
            if (view.turn === 1) {
                const target = bridgeScore(view, ring, dist, home, me);
                const garrison = view.nodes[home].troops ?? 0;
                if (target !== undefined && garrison > 0) {
                    orders.push({ from: home, to: target, troops: garrison });
                }
                return orders;
            }
            const mineRing = ring.filter((id) => view.nodes[id].owner === me);
            const enemyRing = ring.filter((id) => view.nodes[id].owner !== me);
            // 回合 2–4：从桥头堡拆掉其余邻点，最少兵力够用即可。
            if (view.turn < 5) {
                const spent = new Map();
                for (const src of mineRing) {
                    if (orders.length >= view.maxOrders)
                        break;
                    const targets = view.adj[src]
                        .filter((id) => enemyRing.includes(id))
                        .sort((a, b) => (view.nodes[a].troops ?? 0) - (view.nodes[b].troops ?? 0));
                    for (const to of targets) {
                        if (orders.length >= view.maxOrders)
                            break;
                        const avail = (view.nodes[src].troops ?? 0) - (spent.get(src) ?? 0);
                        const need = (view.nodes[to].troops ?? 0) + 1;
                        if (avail > need + 1) {
                            orders.push({ from: src, to, troops: need });
                            spent.set(src, (spent.get(src) ?? 0) + need);
                        }
                    }
                }
                // 桥头堡全丢时的兜底：从任何己方邻点重新打回去
                if (orders.length === 0 && mineRing.length === 0) {
                    for (const src of view.nodes) {
                        if (orders.length >= view.maxOrders)
                            break;
                        if (src.owner !== me)
                            continue;
                        const to = view.adj[src.id].find((id) => enemyRing.includes(id));
                        if (to === undefined)
                            continue;
                        const need = (view.nodes[to].troops ?? 0) + 1;
                        if ((src.troops ?? 0) > need)
                            orders.push({ from: src.id, to, troops: need });
                    }
                }
                return orders;
            }
            // 回合 5 起：所有桥头堡全力斩首。
            for (const r of mineRing) {
                const troops = view.nodes[r].troops ?? 0;
                if (troops > 0)
                    orders.push({ from: r, to: foeHome, troops });
            }
            return orders;
        },
    };
}
