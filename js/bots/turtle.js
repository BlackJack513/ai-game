/**
 * 「磐石」—— 龟缩反击型
 *
 * 风格：前 40 回合几乎不出手，把每个节点都堆到接近上限；
 * 等攒够一波，就带着全部家当直扑敌方老家。擅长惩罚冒进的对手。
 * 弱点：中期地盘小、产出低，遇到稳健扩张型会被慢慢蚕食。
 */
import { NEUTRAL } from '../engine/types.js';
import { CommandBuffer, defenseOf, hops, incomingThreat, nodeValue, ownNodes, } from './planner.js';
/** 攒到这个兵力才发动总攻 */
const PUSH_THRESHOLD = 20;
export function createTurtle() {
    return {
        name: '磐石',
        style: '龟缩反击 · 一击必杀',
        decide(view) {
            const buffer = new CommandBuffer(view);
            const mine = ownNodes(view);
            // 1) 有人打上门：优先补防，把兵压到受威胁的节点
            const threatTotal = mine.reduce((sum, node) => sum + incomingThreat(view, node.id), 0);
            if (threatTotal > 0) {
                const menaced = mine
                    .map((node) => ({ node, danger: incomingThreat(view, node.id) }))
                    .filter((entry) => entry.danger > 0)
                    .sort((a, b) => b.danger - a.danger);
                for (const { node, danger } of menaced) {
                    if (buffer.orders.length >= 3)
                        break;
                    if ((node.troops ?? 0) >= danger + 2)
                        continue;
                    buffer.sendFromClosest(node.id, danger - (node.troops ?? 0) + 4, 1, 3);
                }
            }
            // 2) 反击：对手前线留下的空心节点，见一个吃一个
            if (buffer.orders.length < view.maxOrders) {
                const weak = view.nodes
                    .filter((node) => node.owner >= 0 && node.owner !== view.you && defenseOf(node) <= 4)
                    .sort((a, b) => nodeValue(b) - nodeValue(a));
                for (const target of weak) {
                    if (buffer.orders.length >= view.maxOrders)
                        break;
                    const source = mine
                        .map((node) => ({ node, dist: hops(view, node.id, target.id) }))
                        .filter((item) => Number.isFinite(item.dist) &&
                        item.dist <= 2 &&
                        buffer.capacity(item.node.id, 2) >= defenseOf(target) + 2)
                        .sort((a, b) => a.dist - b.dist)[0];
                    if (!source)
                        continue;
                    buffer.send(source.node.id, target.id, defenseOf(target) + 2);
                }
            }
            // 3) 总攻：任何一个节点攒到阈值，就带着它附近的兵一起扑向最近的敌方老家
            const enemies = view.nodes.filter((node) => node.kind === 'home' && node.owner >= 0 && node.owner !== view.you);
            const stack = mine
                .filter((node) => (node.troops ?? 0) >= PUSH_THRESHOLD)
                .sort((a, b) => (b.troops ?? 0) - (a.troops ?? 0))[0];
            if (stack && enemies.length > 0) {
                const target = enemies
                    .map((node) => ({ node, dist: hops(view, stack.id, node.id) }))
                    .filter((entry) => Number.isFinite(entry.dist))
                    .sort((a, b) => a.dist - b.dist)[0];
                if (target) {
                    buffer.send(stack.id, target.node.id, buffer.capacity(stack.id, 2));
                    // 沿途能跟上的部队一起压上
                    const followers = mine
                        .filter((node) => node.id !== stack.id && buffer.capacity(node.id, 1) >= 6)
                        .sort((a, b) => hops(view, a.id, target.node.id) - hops(view, b.id, target.node.id));
                    for (const node of followers.slice(0, 2)) {
                        buffer.send(node.id, target.node.id, buffer.capacity(node.id, 1));
                    }
                    return buffer.orders;
                }
            }
            // 4) 平时只吃「家门口」的软柿子，且保留足够守军
            if (buffer.orders.length < view.maxOrders) {
                const easy = view.nodes
                    .filter((node) => node.owner === NEUTRAL &&
                    defenseOf(node) <= 5 &&
                    mine.some((entry) => hops(view, entry.id, node.id) <= 2))
                    .sort((a, b) => defenseOf(a) - defenseOf(b));
                for (const node of easy) {
                    if (buffer.orders.length >= view.maxOrders)
                        break;
                    const source = mine
                        .map((entry) => ({ entry, dist: hops(view, entry.id, node.id) }))
                        .filter((item) => Number.isFinite(item.dist) && buffer.capacity(item.entry.id, 4) >= defenseOf(node) + 1)
                        .sort((a, b) => a.dist - b.dist)[0];
                    if (!source)
                        continue;
                    buffer.send(source.entry.id, node.id, defenseOf(node) + 1);
                }
            }
            return buffer.orders;
        },
    };
}
