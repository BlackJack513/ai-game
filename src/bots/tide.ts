/**
 * 「潮汐」—— 稳健扩张型
 *
 * 风格：先把家门口的地盘吃干抹净，攒够优势才推；老家永远留足守军。
 * 弱点：节奏慢，遇到偷袭型要挨一波打才反应过来。
 */

import { NEUTRAL, type Bot, type Observation, type Order } from '../engine/types.js';
import {
  CommandBuffer,
  defenseOf,
  garrisonKeep,
  hops,
  incomingThreat,
  isFrontline,
  nodeValue,
  ownNodes,
} from './planner.js';

const EXPAND_RANGE = 3;
/** 本土优势够大才发动进攻 */
const ATTACK_SURPLUS = 6;

export function createTide(): Bot {
  return {
    name: '潮汐',
    style: '稳健扩张 · 步步为营',

    decide(view: Observation): Order[] {
      const buffer = new CommandBuffer(view);
      const mine = ownNodes(view);

      // 1) 补防：挡不住的前线节点，立刻从最近的友军调兵
      const urgent = mine
        .map((node) => ({
          node,
          danger: incomingThreat(view, node.id) + (isFrontline(view, node) ? 2 : 0),
        }))
        .filter((entry) => entry.danger > (entry.node.troops ?? 0))
        .sort((a, b) => b.danger - a.danger);

      for (const { node, danger } of urgent) {
        if (buffer.orders.length >= 2) break;
        buffer.sendFromClosest(node.id, danger - (node.troops ?? 0) + 4, 2, 2);
      }

      // 2) 扩张：按「产出高 / 守军少 / 距离近」给中立节点打分
      const candidates = view.nodes
        .filter((node) => node.owner === NEUTRAL)
        .map((node) => ({
          node,
          dist: mine.reduce((best, entry) => Math.min(best, hops(view, entry.id, node.id)), Infinity),
        }))
        .filter((entry) => entry.dist <= EXPAND_RANGE)
        .map((entry) => {
          const need = defenseOf(entry.node) + 1;
          return {
            ...entry,
            need,
            score: entry.node.production * 6 + 16 - entry.dist * 5 - need * 1.5,
          };
        })
        .sort((a, b) => b.score - a.score);

      for (const entry of candidates) {
        if (buffer.orders.length >= view.maxOrders) break;
        const canPay = mine.some(
          (node) =>
            buffer.capacity(node.id, garrisonKeep(view, node)) >= entry.need &&
            hops(view, node.id, entry.node.id) <= EXPAND_RANGE,
        );
        if (!canPay) continue;
        buffer.sendFromClosest(entry.node.id, entry.need, 2, 2);
      }

      // 3) 优势推进：前线富余兵力足够吃掉相邻敌军时才动手
      const attacks: Array<{ from: number; target: number; need: number; value: number; surplus: number }> = [];
      for (const node of mine) {
        const keep = garrisonKeep(view, node);
        for (const id of view.adj[node.id]) {
          const target = view.nodes[id];
          if (target.owner < 0 || target.owner === view.you) continue;
          const need = defenseOf(target) + 1;
          const surplus = buffer.capacity(node.id, keep) - ATTACK_SURPLUS;
          if (surplus >= need) {
            attacks.push({ from: node.id, target: id, need, value: nodeValue(target), surplus });
          }
        }
      }
      attacks.sort((a, b) => b.value - a.value || b.surplus - a.surplus);
      for (const attack of attacks) {
        if (buffer.orders.length >= view.maxOrders) break;
        buffer.send(attack.from, attack.target, attack.surplus);
      }

      // 4) 后方余兵向前线集结，为下一波进攻做准备
      if (buffer.orders.length < view.maxOrders) {
        const rear = mine
          .filter((node) => !isFrontline(view, node) && buffer.capacity(node.id, 3) >= 5)
          .sort((a, b) => (b.troops ?? 0) - (a.troops ?? 0));
        const front = mine
          .filter((node) => isFrontline(view, node))
          .sort((a, b) => b.production - a.production);
        if (front.length > 0) {
          for (const node of rear) {
            if (buffer.orders.length >= view.maxOrders) break;
            buffer.send(node.id, front[0].id, buffer.capacity(node.id, 3));
          }
        }
      }

      return buffer.orders;
    },
  };
}
