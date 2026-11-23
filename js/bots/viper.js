/**
 * 「毒蛇」—— 侵略偷袭型
 *
 * 风格：不等兵力攒满就出手，专挑防守薄弱的节点；一旦看见敌方老家空虚，
 * 哪怕绕远路也要扑上去。后方几乎不设防。
 * 弱点：前期换家换亏就会崩，遇到龟缩流容易被反打。
 */
import { NEUTRAL } from '../engine/types.js';
import { CommandBuffer, defenseOf, hops, incomingThreat, nodeValue, ownNodes, } from './planner.js';
const STRIKE_RANGE = 3;
export function createViper() {
    return {
        name: '毒蛇',
        style: '侵略偷袭 · 见血封喉',
        decide(view) {
            const buffer = new CommandBuffer(view);
            const mine = ownNodes(view);
            // 1) 老家被打：全力回防（这是唯一会「保守」的情况）
            const home = view.nodes[view.homeNode];
            const homeDanger = incomingThreat(view, view.homeNode);
            if ((home.troops ?? 0) < homeDanger + 4) {
                buffer.sendFromClosest(view.homeNode, homeDanger + 6, 0, 3);
            }
            // 2) 选目标：优先偷老家，其次高产节点，再其次便宜的软柿子
            const targets = view.nodes
                .filter((node) => node.owner >= 0 && node.owner !== view.you)
                .map((node) => {
                const need = defenseOf(node) + 1;
                const dist = mine.reduce((best, entry) => Math.min(best, hops(view, entry.id, node.id)), Infinity);
                const surprise = node.troops === null ? 10 : 0; // 视野外 = 守军未知，值得一赌
                return {
                    node,
                    need,
                    dist,
                    score: nodeValue(node) + surprise - dist * 18 - need * 3,
                };
            })
                .filter((entry) => entry.dist <= STRIKE_RANGE)
                .sort((a, b) => b.score - a.score);
            for (const entry of targets) {
                if (buffer.orders.length >= view.maxOrders - 1)
                    break;
                const keepOf = (nodeId) => (nodeId === view.homeNode ? 3 : 0);
                const sources = mine
                    .filter((node) => buffer.capacity(node.id, keepOf(node.id)) >= entry.need &&
                    hops(view, node.id, entry.node.id) <= STRIKE_RANGE)
                    .sort((a, b) => (b.troops ?? 0) - (a.troops ?? 0));
                if (sources.length === 0)
                    continue;
                // 用一支纵队打穿：从兵力最多的节点压上，必要时再补一刀
                const main = sources[0];
                const keep = keepOf(main.id);
                buffer.send(main.id, entry.node.id, Math.min(buffer.capacity(main.id, keep), entry.need + 2));
                if (entry.node.kind === 'home' && sources[1]) {
                    buffer.send(sources[1].id, entry.node.id, buffer.capacity(sources[1].id, keepOf(sources[1].id)));
                }
            }
            // 3) 没仗打就扩张，但只留 1 个兵守家
            if (buffer.orders.length < view.maxOrders) {
                const neutrals = view.nodes
                    .filter((node) => node.owner === NEUTRAL)
                    .map((node) => ({
                    node,
                    dist: mine.reduce((best, entry) => Math.min(best, hops(view, entry.id, node.id)), Infinity),
                }))
                    .filter((entry) => entry.dist <= 2)
                    .sort((a, b) => defenseOf(a.node) - defenseOf(b.node) || a.dist - b.dist);
                for (const entry of neutrals) {
                    if (buffer.orders.length >= view.maxOrders)
                        break;
                    buffer.sendFromClosest(entry.node.id, defenseOf(entry.node) + 1, 1, 1);
                }
            }
            return buffer.orders;
        },
    };
}
