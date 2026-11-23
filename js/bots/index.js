/**
 * 内置 bot 清单：三个陪练 + 一个「新兵」示例。
 * 前端用 id 选择对手，对局记录里也只存 id。
 */
import { createTide } from './tide.js';
import { createViper } from './viper.js';
import { createTurtle } from './turtle.js';
import { createRookie } from './rookie.js';
export const BOTS = [
    {
        id: 'tide',
        name: '潮汐',
        style: '稳健扩张 · 步步为营',
        color: '#38bdf8',
        create: createTide,
    },
    {
        id: 'viper',
        name: '毒蛇',
        style: '侵略偷袭 · 见血封喉',
        color: '#fb7185',
        create: createViper,
    },
    {
        id: 'turtle',
        name: '磐石',
        style: '龟缩反击 · 一击必杀',
        color: '#fbbf24',
        create: createTurtle,
    },
    {
        id: 'rookie',
        name: '新兵',
        style: '最简示例 · 全线压上',
        color: '#34d399',
        create: createRookie,
    },
];
export function createBot(id) {
    return BOTS.find((entry) => entry.id === id)?.create() ?? null;
}
export function botEntry(id) {
    return BOTS.find((entry) => entry.id === id) ?? null;
}
