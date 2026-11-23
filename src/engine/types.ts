/**
 * 星流 Starflow — 核心类型与规则常量
 *
 * 设计约束：引擎必须完全确定性。同一份 (模式, 种子) 生成的初始局面永远相同，
 * 同一串指令永远推导出同一个结果。这样回放只需要「种子 + 指令日志」。
 */

export type Mode = 'duel' | 'ffa';

export type NodeKind = 'home' | 'farm' | 'mine' | 'lab' | 'watchtower' | 'foundry';

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
} as const;

export const KIND_LABEL: Record<NodeKind, string> = {
  home: '老家',
  farm: '农场',
  mine: '矿场',
  lab: '研究院',
  watchtower: '瞭望塔',
  foundry: '兵工厂',
};

export const KIND_GLYPH: Record<NodeKind, string> = {
  home: '家',
  farm: '农',
  mine: '矿',
  lab: '研',
  watchtower: '塔',
  foundry: '厂',
};

export const MODE_LABEL: Record<Mode, string> = {
  duel: '单挑',
  ffa: '四人混战',
};

// ---------------------------------------------------------------------------
// 指令
// ---------------------------------------------------------------------------

export interface Order {
  from: number;
  to: number;
  troops: number;
}

export interface Rejection {
  order: unknown;
  reason: string;
}

// ---------------------------------------------------------------------------
// 地图
// ---------------------------------------------------------------------------

export interface MapNode {
  id: number;
  /** 归一化坐标，0..1 */
  x: number;
  y: number;
  kind: NodeKind;
  /** 初始中立守军（老家为初始兵力） */
  garrison: number;
}

export interface GameMap {
  seed: number;
  mode: Mode;
  nodes: MapNode[];
  edges: Array<[number, number]>;
  adj: number[][];
  /** 各玩家老家节点 id，下标即玩家 id */
  homes: number[];
}

// ---------------------------------------------------------------------------
// 对局状态
// ---------------------------------------------------------------------------

export interface NodeState {
  owner: number;
  troops: number;
}

/** 一支正在行军中的纵队。 */
export interface Column {
  id: number;
  owner: number;
  troops: number;
  /** 完整路径，path[0] 为起点、path[末] 为终点 */
  path: number[];
  departTurn: number;
  arriveTurn: number;
}

export interface PlayerInfo {
  id: number;
  name: string;
  alive: boolean;
  eliminatedTurn: number | null;
}

export interface GameState {
  map: GameMap;
  /** 从 1 开始 */
  turn: number;
  nodes: NodeState[];
  columns: Column[];
  players: PlayerInfo[];
  nextColumnId: number;
}

// ---------------------------------------------------------------------------
// 事件（用于日志与回放）
// ---------------------------------------------------------------------------

export type GameEvent =
  | { turn: number; type: 'capture'; node: number; from: number; to: number }
  | { turn: number; type: 'eliminated'; player: number; killer: number }
  | { turn: number; type: 'invalid'; player: number; reason: string }
  | { turn: number; type: 'wave'; player: number; from: number; to: number; troops: number };

// ---------------------------------------------------------------------------
// 观察：bot 每回合收到的、经过战争迷雾过滤的世界快照
// ---------------------------------------------------------------------------

export interface ObsNode {
  id: number;
  kind: NodeKind;
  owner: number;
  /** null 表示视野外：只知道归属，不知道兵力 */
  troops: number | null;
  /** 是否在当前视野内 */
  visible: boolean;
  /** 该节点每回合产出（归属公开，因此可以直接给出） */
  production: number;
}

export interface ObsColumn {
  owner: number;
  troops: number;
  path: number[];
  departTurn: number;
  arriveTurn: number;
}

export interface ObsPlayer {
  id: number;
  name: string;
  alive: boolean;
  nodes: number;
  /** 每回合总产出，公开信息 */
  production: number;
  /** 只有自己才知道自己的总兵力 */
  totalTroops: number | null;
  eliminatedTurn: number | null;
}

export interface Observation {
  turn: number;
  maxTurns: number;
  mode: Mode;
  /** 我是几号玩家 */
  you: number;
  homeNode: number;
  nodes: ObsNode[];
  adj: number[][];
  columns: ObsColumn[];
  players: ObsPlayer[];
  ordersLeft: number;
  maxOrders: number;
  /** 由 (对局种子, 回合, 玩家) 推导出的确定性随机种子，供 bot 使用 */
  rngSeed: number;
}

/** 一个参赛 AI 需要实现的唯一接口。 */
export interface Bot {
  readonly name: string;
  /** 人类可读的风格描述，显示在 UI 上 */
  readonly style?: string;
  /** 每回合调用一次，返回最多 maxOrders 条指令 */
  decide(view: Observation): Order[] | void;
}
