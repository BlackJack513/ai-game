/**
 * 对局运行器：把引擎 + bot 串起来，产出可回放的逐回合快照。
 *
 * 同一份 (mode, seed, botIds) 永远得到同一局比赛 —— 这是做排行榜和
 * 「对战代码仓库」的基础。
 */
import { alivePlayers, createGame, nodeCount, observe, playTurn, playerProduction, totalTroops, } from './sim.js';
import { MODE_LABEL, RULES, } from './types.js';
function snapshot(state, orders, events, turn) {
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
function score(state, playerId) {
    const info = state.players[playerId];
    if (!info.alive)
        return -(info.eliminatedTurn ?? 0) * 100;
    return 1_000_000 + nodeCount(state, playerId) * 1000 + totalTroops(state, playerId);
}
export class Match {
    state;
    frames = [];
    bots;
    stats;
    maxTurns;
    botIds;
    broken;
    over = false;
    winner = null;
    ranking = [];
    endReason = '';
    constructor(options) {
        this.state = createGame(options.mode, options.seed, options.names ?? []);
        this.bots = options.bots;
        this.botIds = options.botIds;
        this.maxTurns = options.maxTurns ?? RULES.maxTurns;
        this.stats = options.bots.map(() => ({ thinkMs: [], invalidOrders: 0, crashes: 0 }));
        this.broken = options.bots.map(() => false);
        // 第 1 回合开始前的初始画面
        this.frames.push(snapshot(this.state, [], [], 0));
    }
    get finished() {
        return this.over;
    }
    result() {
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
    step() {
        if (this.over)
            return false;
        const orders = [];
        const inputs = [];
        for (const player of this.state.players) {
            if (!player.alive)
                continue;
            const bot = this.bots[player.id];
            const bag = this.stats[player.id];
            let submitted = [];
            if (bot && !this.broken[player.id]) {
                const t0 = performance.now();
                try {
                    const view = observe(this.state, player.id);
                    submitted = bot.decide(view) ?? [];
                }
                catch (error) {
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
    run() {
        while (this.step()) {
            /* 继续 */
        }
        return this.result();
    }
    checkFinished() {
        const alive = alivePlayers(this.state);
        const mode = this.state.map.mode;
        if (mode === 'duel') {
            if (alive.length <= 1) {
                this.finish(alive.length === 1 ? '老家被攻陷' : '双方老家同时被攻陷');
                return;
            }
        }
        else if (alive.length <= 1) {
            this.finish(alive.length === 1 ? '最后的幸存者' : '同归于尽');
            return;
        }
        if (this.state.turn > this.maxTurns) {
            this.finish('回合上限，比节点数');
        }
    }
    finish(reason) {
        this.over = true;
        this.endReason = reason;
        const ids = this.state.players.map((player) => player.id);
        ids.sort((a, b) => score(this.state, b) - score(this.state, a));
        this.ranking = ids;
        const first = ids[0];
        const second = ids[1];
        const tie = second !== undefined &&
            this.state.players[first].alive === this.state.players[second].alive &&
            nodeCount(this.state, first) === nodeCount(this.state, second) &&
            totalTroops(this.state, first) === totalTroops(this.state, second);
        this.winner = tie ? null : first;
    }
}
export function runMatch(options) {
    return new Match(options).run();
}
