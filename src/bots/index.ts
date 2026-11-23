/**
 * 内置 bot 清单：四个陪练 + 一个「新兵」示例。
 * 前端用 id 选择对手，对局记录里也只存 id。
 */

import type { Bot } from '../engine/types.js';
import { createTide } from './tide.js';
import { createViper } from './viper.js';
import { createTurtle } from './turtle.js';
import { createRookie } from './rookie.js';
import { createGlm53 } from './glm53.js';
import { createZhanluDeepseek } from './zhanlu-deepseek.js';
import { createDshDeepseek } from './dsh-deepseek.js';
import { createDeepseekAndThy } from './deepseek-and-thy.js';

export interface BotEntry {
  id: string;
  name: string;
  style: string;
  /** 该 bot 的默认配色 */
  color: string;
  create: () => Bot;
}

export const BOTS: BotEntry[] = [
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
  {
    id: 'glm53',
    name: 'GLM53',
    style: '全局调度 · 攻守兼备',
    color: '#a78bfa',
    create: createGlm53,
  },
  {
    id: 'zhanlu-deepseek',
    name: 'zhanluDeepseek',
    style: '精确结算 · 全局调度',
    color: '#f97316',
    create: createZhanluDeepseek,
  },
  {
    id: 'dsh-deepseek',
    name: 'DSH DeepSeek',
    style: '贪婪征服 · 精简高效',
    color: '#22d3ee',
    create: createDshDeepseek,
  },
  {
    id: 'deepseek-and-thy',
    name: 'deepseekAndThy',
    style: '经济冲刺 · 跨回合合击',
    color: '#e879f9',
    create: createDeepseekAndThy,
  },
];

export function createBot(id: string): Bot | null {
  return BOTS.find((entry) => entry.id === id)?.create() ?? null;
}

export function botEntry(id: string): BotEntry | null {
  return BOTS.find((entry) => entry.id === id) ?? null;
}
