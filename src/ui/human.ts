/**
 * 真人玩家的出兵草稿。
 *
 * 计算机 AI 每回合一次性返回指令，真人则需要「看看局面 → 下几条令 → 结束回合」。
 * 这个类只做一件事：维护当前回合的待发指令，并在提交前按引擎规则做一次预校验，
 * 让点击操作获得即时反馈，而不是等回合结算时才看到「指令被驳回」。
 */

import { findPath } from '../engine/sim.js';
import { RULES, type GameState, type Order } from '../engine/types.js';

export interface PlannedOrder {
  from: number;
  to: number;
  troops: number;
  /** 引擎寻路结果，供渲染器画出待发箭头 */
  path: number[];
}

export interface PlanResult {
  ok: boolean;
  error?: string;
}

export class HumanPlan {
  /** 玩家编号：真人固定坐 0 号位。 */
  readonly player = 0;

  selected: number | null = null;
  orders: PlannedOrder[] = [];

  constructor(private readonly state: GameState) {}

  get maxOrders(): number {
    return RULES.maxOrders;
  }

  /** 选中一个己方节点作为出兵起点；再点一次取消。 */
  select(nodeId: number | null): void {
    if (nodeId === null) {
      this.selected = null;
      return;
    }
    const node = this.state.nodes[nodeId];
    if (!node || node.owner !== this.player) return;
    this.selected = this.selected === nodeId ? null : nodeId;
  }

  /** 节点当前兵力扣除本回合已下达指令后的余额。 */
  availableAt(nodeId: number): number {
    const node = this.state.nodes[nodeId];
    if (!node || node.owner !== this.player) return 0;
    const committed = this.orders.reduce(
      (sum, order) => (order.from === nodeId ? sum + order.troops : sum),
      0,
    );
    return Math.max(0, node.troops - committed);
  }

  /** 已选起点时，列出所有可下令的目标（寻路可达、且没有重复指令）。 */
  targets(): number[] {
    const from = this.selected;
    if (from === null) return [];
    const list: number[] = [];
    for (let id = 0; id < this.state.nodes.length; id++) {
      if (id === from) continue;
      if (this.orders.some((order) => order.from === from && order.to === id)) continue;
      if (findPath(this.state, from, id)) list.push(id);
    }
    return list;
  }

  /** 添加一条指令。所有规则限制在这里先检查一遍。 */
  add(to: number, troops: number): PlanResult {
    const from = this.selected;
    if (from === null) return { ok: false, error: '先点一个你的节点' };
    if (from === to) return { ok: false, error: '起点和终点不能相同' };
    if (this.orders.length >= RULES.maxOrders) {
      return { ok: false, error: `每回合最多 ${RULES.maxOrders} 条指令` };
    }
    if (this.orders.some((order) => order.from === from && order.to === to)) {
      return { ok: false, error: '这条路线已经下令了' };
    }

    const path = findPath(this.state, from, to);
    if (!path) return { ok: false, error: '没有可通行的路径' };

    const available = this.availableAt(from);
    const amount = Math.floor(troops);
    if (!Number.isFinite(amount) || amount < 1) return { ok: false, error: '兵力必须 ≥ 1' };
    if (amount > available) return { ok: false, error: `该节点只剩 ${available} 兵可用` };

    this.orders.push({ from, to, troops: amount, path });
    return { ok: true };
  }

  remove(index: number): void {
    if (index < 0 || index >= this.orders.length) return;
    this.orders.splice(index, 1);
  }

  clear(): void {
    this.orders = [];
  }

  /** 提交给引擎前把草稿转成纯指令（丢掉 path 等仅供展示的字段）。 */
  toOrders(): Order[] {
    return this.orders.map(({ from, to, troops }) => ({ from, to, troops }));
  }
}
