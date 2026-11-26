/**
 * 参赛池：按主攻方向把内置 bot 分到单挑池与混战池。
 *
 * - 单挑池：全部内置 bot 都可参加单挑榜（单挑榜本身按排名邀请前十 + 挑战者）。
 * - 混战池：排除明确只打单挑的 bot —— 它们不参加四人混战，
 *   否则只会稀释对阵质量，成为混战评测里的噪声。
 */
import { BOTS } from './index.js';
/** 明确只打单挑、不参加四人混战的 bot。 */
export const DUEL_ONLY_BOT_IDS = ['chengying', 'poyun', 'suanli'];
const duelOnly = new Set(DUEL_ONLY_BOT_IDS);
/** 单挑专用 bot 的完整登记信息，供脚本打印名单。 */
export const DUEL_ONLY_BOTS = BOTS.filter((entry) => duelOnly.has(entry.id));
/** 单挑池：所有内置 bot 都可参加单挑榜。 */
export const DUEL_POOL = BOTS;
/** 混战池：排除单挑专用 bot 后的选手名单。 */
export const FFA_POOL = BOTS.filter((entry) => !duelOnly.has(entry.id));
export function poolFor(track) {
    return track === 'ffa' ? FFA_POOL : DUEL_POOL;
}
export function findInPool(pool, id) {
    return pool.find((entry) => entry.id === id) ?? null;
}
