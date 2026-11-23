/**
 * 星流 Starflow — 核心类型与规则常量
 *
 * 设计约束：引擎必须完全确定性。同一份 (模式, 种子) 生成的初始局面永远相同，
 * 同一串指令永远推导出同一个结果。这样回放只需要「种子 + 指令日志」。
 */
/** 中立势力在 owner 字段中的取值。 */
export const NEUTRAL = -1;
export const RULES = {
    /** 单节点兵力上限 */
    maxTroops: 100,
    /** 老家初始兵力 */
    homeStart: 20,
    /** 老家每回合产出 */
    homeProduction: 4,
    /** 普通节点基础产出 */
    baseProduction: 2,
    /** 兵工厂的额外产出 */
    foundryBonus: 3,
    /** 老家视野半径（跳） */
    homeVision: 2,
    /** 瞭望塔视野半径（跳） */
    watchtowerVision: 3,
    /** 普通节点视野半径（跳） */
    normalVision: 1,
    /** 每回合最多指令数 */
    maxOrders: 5,
    /** 动画基准：一回合多少秒（仅表现层使用，不影响模拟） */
    turnSeconds: 1.6,
    /** 回合上限 */
    maxTurns: 150,
};
export const KIND_LABEL = {
    home: '老家',
    farm: '农场',
    mine: '矿场',
    lab: '研究院',
    watchtower: '瞭望塔',
    foundry: '兵工厂',
};
export const KIND_GLYPH = {
    home: '家',
    farm: '农',
    mine: '矿',
    lab: '研',
    watchtower: '塔',
    foundry: '厂',
};
export const MODE_LABEL = {
    duel: '单挑',
    ffa: '四人混战',
};
