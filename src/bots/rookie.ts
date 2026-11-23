/**
 * 「新兵」——最短的可用 bot，也是写自己 bot 的起点（README 里的示例就是它）。
 *
 * 策略只有一条：
 *   每回合最多发 3 条指令：每个我方节点留 1 兵看家，把兵派向「2 跳内最划算」的中立点。
 *
 * 它没有记忆、没有防守、没有配合——正因如此，它只有 40 行，很适合当模板。
 * 所有信息都来自 decide(view) 的参数，绝对不能访问引擎内部状态：
 *   引擎只会在「你该看到的东西」上填真实数字，其余是 null。
 */

import type { Bot, Observation, Order } from '../engine/types.js';
import { NEUTRAL } from '../engine/types.js';
import { buildPath, defenseOf, hops, nodeValue, ownNodes } from './planner.js';

export function createRookie(): Bot {
  return {
    name: '新兵',
    style: '最简示例 · 全线压上',
    decide(view: Observation): Order[] {
      const orders: Order[] = [];

      for (const mine of ownNodes(view)) {
        if (orders.length >= 3) break;

        const spare = (mine.troops ?? 0) - 1; // 留 1 兵看家
        if (spare < 1) continue;

        // 在 3 跳内找一个目标：价值高、路近、守军弱
        let best: { id: number; score: number; need: number } | null = null;
        for (const target of view.nodes) {
          if (target.owner !== NEUTRAL) continue; // 只打中立点，最简单的策略

          const dist = hops(view, mine.id, target.id);
          if (!Number.isFinite(dist) || dist > 2) continue;

          const need = defenseOf(target) + 1; // 视野外的守军按 4 估算
          if (need > spare) continue;

          const score = nodeValue(target) - dist * 20 - need * 4;
          if (!best || score > best.score) best = { id: target.id, score, need };
        }

        if (!best) continue;
        if (!buildPath(view, mine.id, best.id)) continue;

        orders.push({ from: mine.id, to: best.id, troops: Math.min(spare, best.need) });
      }

      return orders;
    },
  };
}
