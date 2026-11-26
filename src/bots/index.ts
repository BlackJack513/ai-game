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
import { createTianshu } from './tianshu.js';
import { createZiwei } from './ziwei.js';
import { createPojun } from './pojun.js';
import { createChengying } from './chengying.js';
import { createZhanluStarflow } from './zhanlu-starflow.js';
import { createLongyuan } from './longyuan.js';
import { createKimik31pro } from './kimik31pro.js';
import { createZhanluDeepseekFfa } from './zhanlu-deepseek-ffa.js';
import { createHy4Flash } from './hy4flash.js';
import { createKimik31proFfa } from './kimik31pro-ffa.js';
import { createHy4FlashFfa } from './hy4flash-ffa.js';
import { createLiekong } from './liekong.js';
import { createZhanluSilkworm } from './jiance.js';
import { createJingtun } from './jingtun.js';
import { createHy4BlitzFfa } from './hy4blitz-ffa.js';
import { createPoyun } from './poyun.js';
import { createSuanli } from './suanli.js';
import { createDafeiyu } from './dafeiyu.js';

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
  {
    id: 'tianshu',
    name: '天枢',
    style: '精确推演 · 协同绝杀',
    color: '#c084fc',
    create: createTianshu,
  },
  {
    id: 'ziwei',
    name: '紫微',
    style: '可反应安全 · 精确斩首',
    color: '#818cf8',
    create: createZiwei,
  },
  {
    id: 'pojun',
    name: '破军',
    style: '多线抢产 · 合兵攻家',
    color: '#ef4444',
    create: createPojun,
  },
  {
    id: 'chengying',
    name: '承影',
    style: '精确结算 · 梯度补给 · 蓄势斩首',
    color: '#facc15',
    create: createChengying,
  },
  {
    id: 'zhanlu-starflow',
    name: '湛卢星流',
    style: '经济滚雪球 · 视野预警 · 精准掠夺 · 蓄势斩首',
    color: '#2dd4bf',
    create: createZhanluStarflow,
  },
  {
    id: 'longyuan',
    name: '龙渊',
    style: '镜像推演 · 视野压制 · 波次斩首',
    color: '#94a3b8',
    create: createLongyuan,
  },
  {
    id: 'kimik31pro',
    name: 'Kimi K3.1',
    style: '经济竞速 · 风险调度 · 同步合击 · 精准斩首',
    color: '#60a5fa',
    create: createKimik31pro,
  },
  {
    id: 'zhanlu-deepseek-ffa',
    name: '湛卢混战',
    style: '经济压制 · 控图视野 · 多源合击 · 蓄势斩首',
    color: '#84cc16',
    create: createZhanluDeepseekFfa,
  },
  {
    id: 'hy4flash',
    name: 'hy4flash',
    style: '抢产扩军 · 协同斩首 · 可视防御',
    color: '#f43f5e',
    create: createHy4Flash,
  },
  {
    id: 'kimik31pro-ffa',
    name: 'kimik31pro-ffa',
    style: '混战专精 · 安全扩张 · 动态防御 · 终局抢点',
    color: '#0ea5e9',
    create: createKimik31proFfa,
  },
  {
    id: 'hy4flash-ffa',
    name: 'hy4flash-ffa',
    style: '混战专精 · 威胁感知 · 经济扩张 · 同回合合击 · 伺机斩首',
    color: '#f472b6',
    create: createHy4FlashFfa,
  },
  {
    id: 'liekong',
    name: '裂空',
    style: '经济滚雪球 · 视野预警 · 多源合击 · 终局斩首',
    color: '#d946ef',
    create: createLiekong,
  },
  {
    id: 'jiance',
    name: '简策',
    style: '分兵扩产 · 抢产优先 · 见缝蚕食',
    color: '#14b8a6',
    create: createZhanluSilkworm,
  },
  {
    id: 'jingtun',
    name: '鲸吞',
    style: '极致产能 · 全兵上岗 · 以战养战',
    color: '#a3e635',
    create: createJingtun,
  },
  {
    id: 'hy4blitz-ffa',
    name: 'hy4blitz-ffa',
    style: '混战专精 · 极限扩产 · 近家清剿 · 重兵围歼 · 条件斩首',
    color: '#f59e0b',
    create: createHy4BlitzFfa,
  },
  {
    id: 'poyun',
    name: '破云',
    style: '破环断援 · 桥头蓄势 · 贴脸斩首',
    color: '#dc2626',
    create: createPoyun,
  },
  {
    id: 'suanli',
    name: '算力',
    style: '自适应开局 · 精确调度 · 协同斩首',
    color: '#7c3aed',
    create: createSuanli,
  },
  {
    id: 'dafeiyu',
    name: '大肥鱼',
    style: '家门口抢产 · 余粮前置 · 见空即斩',
    color: '#0891b2',
    create: createDafeiyu,
  },
];

export function createBot(id: string): Bot | null {
  return BOTS.find((entry) => entry.id === id)?.create() ?? null;
}

export function botEntry(id: string): BotEntry | null {
  return BOTS.find((entry) => entry.id === id) ?? null;
}
