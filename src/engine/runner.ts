/**
 * 对局运行器：把引擎 + bot 串起来，产出可回放的逐回合快照。
 *
 * 同一份 (mode, seed, botIds) 永远得到同一局比赛 —— 这是做排行榜和
 * 「对战代码仓库」的基础。
 */

import {
  alivePlayers,
  createGame,
  nodeCount,
  observe,
  playTurn,
  playerProduction,
  totalTroops,
} from './sim.js';
import {
  MODE_LABEL,
  RULES,
  type Bot,
  type GameEvent,
  type GameMap,
  type GameState,
  type Mode,
  type Order,
} from './types.js';

export interface FrameColumn {
  owner: number;
  troops: number;
  path: number[];
  departTurn: number;
  arriveTurn: number;
}

export interface FrameOrder {
  player: number;
  orders: Order[];
  rejected: number;
}

export interface FramePlayer {
  id: number;
  name: string;
  alive: boolean;
  nodes: number;
  production: number;
  troops: number;
  eliminatedTurn: number | null;
}

/** 一个回合结束时的完整局面快照，前端只靠它就能画出整局比赛。 */
export interface Frame {
  turn: number;
  nodes: Array<{ owner: number; troops: number }>;
  columns: FrameColumn[];
  players: FramePlayer[];
  /** 本回合各玩家提交并生效的指令 */
  orders: FrameOrder[];
  events: GameEvent[];
}

export interface BotStats {
  /** 每回合决策耗时（毫秒） */
  thinkMs: number[];
  invalidOrders: number;
  crashes: number;
}

export interface MatchResult {
  mode: Mode;
  seed: number;
  /** 本局使用的地图（回放只靠它 + frames 就能完整还原画面） */
  map: GameMap;
  botIds: string[];
  names: string[];
  frames: Frame[];
  winner: number | null;
  ranking: number[];
  reason: string;
  stats: BotStats[];
}

export interface RunOptions {
  mode: Mode;
  seed: number;
  botIds: string[];
  bots: Bot[];
  names?: string[];
  maxTurns?: number;
}

function snapshot(state: GameState, orders: FrameOrder[], events: GameEvent[], turn: number): Frame {
  return {
    turn,
    nodes: state.nodes.map((node) => ({ owner: node.owner, troops: node.troops })),
    columns: state.columns.map((column) => ({
      owner: column.owner,
      troops: column.troops,
      path: column.path.slice(),
      departTurn: column.departTurn,
      arriveTurn: column.arriveTurn,
    })),
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      alive: player.alive,
      nodes: nodeCount(state, player.id),
      production: playerProduction(state, player.id),
      troops: totalTroops(state, player.id),
      eliminatedTurn: player.eliminatedTurn,
    })),
    orders,
    events,
  };
}

function score(state: GameState, playerId: number): number {
  const info = state.players[playerId];
  if (!info.alive) return -(info.eliminatedTurn ?? 0) * 100;
  return 1_000_000 + nodeCount(state, playerId) * 1000 + totalTroops(state, playerId);
}

export class Match {
  readonly state: GameState;
  readonly frames: Frame[] = [];
  readonly bots: Bot[];
  readonly stats: BotStats[];
  private readonly maxTurns: number;
  private readonly botIds: string[];
  private broken: boolean[];
  private over = false;
  private winner: number | null = null;
  private ranking: number[] = [];
  private endReason = '';

  constructor(options: RunOptions) {
    this.state = createGame(options.mode, options.seed, options.names ?? []);
    this.bots = options.bots;
    this.botIds = options.botIds;
    this.maxTurns = options.maxTurns ?? RULES.maxTurns;
    this.stats = options.bots.map(() => ({ thinkMs: [], invalidOrders: 0, crashes: 0 }));
    this.broken = options.bots.map(() => false);
    // 第 1 回合开始前的初始画面
    this.frames.push(snapshot(this.state, [], [], 0));
  }

  get finished(): boolean {
    return this.over;
  }

  result(): MatchResult {
    return {
      mode: this.state.map.mode,
      seed: this.state.map.seed,
      map: this.state.map,
      botIds: this.botIds.slice(),
      names: this.state.players.map((player) => player.name),
      frames: this.frames,
      winner: this.winner,
      ranking: this.ranking.slice(),
      reason: this.endReason || MODE_LABEL[this.state.map.mode],
      stats: this.stats,
    };
  }

  /** 跑一个回合。返回 false 表示对局已结束。 */
  step(): boolean {
    if (this.over) return false;

    const orders: FrameOrder[] = [];
    const inputs: Array<{ player: number; orders: unknown }> = [];

    for (const player of this.state.players) {
      if (!player.alive) continue;
      const bot = this.bots[player.id];
      const bag = this.stats[player.id];
      let submitted: unknown = [];
      if (bot && !this.broken[player.id]) {
        const t0 = performance.now();
        try {
          const view = observe(this.state, player.id);
          submitted = bot.decide(view) ?? [];
        } catch (error) {
          bag.crashes++;
          this.broken[player.id] = true;
          submitted = [];
          console.error(`[bot ${player.name}] 决策时抛出异常：`, error);
        }
        bag.thinkMs.push(performance.now() - t0);
      }
      inputs.push({ player: player.id, orders: submitted });
    }

    const outcome = playTurn(this.state, inputs);

    for (const set of outcome.orderSets) {
      this.stats[set.player].invalidOrders += set.rejected.length;
      orders.push({ player: set.player, orders: set.orders, rejected: set.rejected.length });
    }

    this.frames.push(snapshot(this.state, orders, outcome.events, outcome.turn));
    this.checkFinished();
    return !this.over;
  }

  /** 一路跑到结束（同步版本，用于自测与命令行）。 */
  run(): MatchResult {
    while (this.step()) {
      /* 继续 */
    }
    return this.result();
  }

  private checkFinished(): void {
    const alive = alivePlayers(this.state);
    const mode = this.state.map.mode;

    if (mode === 'duel') {
      if (alive.length <= 1) {
        this.finish(
          alive.length === 1 ? '老家被攻陷' : '双方老家同时被攻陷',
        );
        return;
      }
    } else if (alive.length <= 1) {
      this.finish(alive.length === 1 ? '最后的幸存者' : '同归于尽');
      return;
    }

    if (this.state.turn > this.maxTurns) {
      this.finish('回合上限，比节点数');
    }
  }

  private finish(reason: string): void {
    this.over = true;
    this.endReason = reason;
    const ids = this.state.players.map((player) => player.id);
    ids.sort((a, b) => score(this.state, b) - score(this.state, a));
    this.ranking = ids;

    const first = ids[0];
    const second = ids[1];
    const tie =
      second !== undefined &&
      this.state.players[first].alive === this.state.players[second].alive &&
      nodeCount(this.state, first) === nodeCount(this.state, second) &&
      totalTroops(this.state, first) === totalTroops(this.state, second);
    this.winner = tie ? null : first;
  }
}

export function runMatch(options: RunOptions): MatchResult {
  return new Match(options).run();
}
