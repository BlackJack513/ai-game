/**
 * 真人玩家的出兵草稿。
 *
 * 计算机 AI 每回合一次性返回指令，真人则需要「看看局面 → 下几条令 → 结束回合」。
 * 这个类只做一件事：维护当前回合的待发指令，并在提交前按引擎规则做一次预校验，
 * 让点击操作获得即时反馈，而不是等回合结算时才看到「指令被驳回」。
 *
 * 一条指令的流程固定为：点起点 → 点终点 → 输入兵力确认。
 * 确认后起点自动清空，直接点下一个起点即可，不用再点一次起点取消。
 */
import { findPath } from '../engine/sim.js';
import { RULES } from '../engine/types.js';
export class HumanPlan {
    state;
    player;
    selected = null;
    pending = null;
    orders = [];
    /** `player` 为真人座位：本地挑战固定 0，联机时由房间分配。 */
    constructor(state, player = 0) {
        this.state = state;
        this.player = player;
    }
    get maxOrders() {
        return RULES.maxOrders;
    }
    /**
     * 选中一个己方节点作为出兵起点；再点一次取消。
     * 换起点或取消时，尚未确认的目标也一并丢弃。
     */
    select(nodeId) {
        this.pending = null;
        if (nodeId === null) {
            this.selected = null;
            return;
        }
        const node = this.state.nodes[nodeId];
        if (!node || node.owner !== this.player)
            return;
        this.selected = this.selected === nodeId ? null : nodeId;
    }
    /** 取消当前整条指令（起点 + 目标）。 */
    cancel() {
        this.selected = null;
        this.pending = null;
    }
    /** 节点当前兵力扣除本回合已下达指令后的余额。 */
    availableAt(nodeId) {
        const node = this.state.nodes[nodeId];
        if (!node || node.owner !== this.player)
            return 0;
        const committed = this.orders.reduce((sum, order) => (order.from === nodeId ? sum + order.troops : sum), 0);
        return Math.max(0, node.troops - committed);
    }
    /** 已选起点时，列出所有可下令的目标（寻路可达、且没有重复指令）。 */
    targets() {
        const from = this.selected;
        if (from === null)
            return [];
        const list = [];
        for (let id = 0; id < this.state.nodes.length; id++) {
            if (id === from)
                continue;
            if (this.orders.some((order) => order.from === from && order.to === id))
                continue;
            if (findPath(this.state, from, id))
                list.push(id);
        }
        return list;
    }
    /** 选好目标，等待输入兵力。所有规则限制在这里先检查一遍。 */
    begin(to) {
        const from = this.selected;
        if (from === null)
            return { ok: false, error: '先点一个你的节点' };
        if (from === to)
            return { ok: false, error: '起点和终点不能相同' };
        if (this.orders.length >= RULES.maxOrders) {
            return { ok: false, error: `每回合最多 ${RULES.maxOrders} 条指令` };
        }
        if (this.orders.some((order) => order.from === from && order.to === to)) {
            return { ok: false, error: '这条路线已经下令了' };
        }
        if (this.availableAt(from) < 1)
            return { ok: false, error: '该节点已经没有可调的兵' };
        const path = findPath(this.state, from, to);
        if (!path)
            return { ok: false, error: '没有可通行的路径' };
        this.pending = { from, to, path };
        return { ok: true };
    }
    /** 确认兵力，把等待中的指令落成待发指令，并自动清空起点。 */
    commit(troops) {
        const pending = this.pending;
        if (!pending)
            return { ok: false, error: '还没有选择目标节点' };
        const available = this.availableAt(pending.from);
        const amount = Math.floor(troops);
        if (!Number.isFinite(amount) || amount < 1)
            return { ok: false, error: '兵力必须 ≥ 1' };
        if (amount > available)
            return { ok: false, error: `该节点只剩 ${available} 兵可用` };
        this.orders.push({ ...pending, troops: amount });
        this.selected = null;
        this.pending = null;
        return { ok: true };
    }
    remove(index) {
        if (index < 0 || index >= this.orders.length)
            return;
        this.orders.splice(index, 1);
    }
    clear() {
        this.orders = [];
    }
    /** 提交给引擎前把草稿转成纯指令（丢掉 path 等仅供展示的字段）。 */
    toOrders() {
        return this.orders.map(({ from, to, troops }) => ({ from, to, troops }));
    }
}
