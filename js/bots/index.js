/**
 * 内置 bot 清单：四个陪练 + 一个「新兵」示例。
 * 前端用 id 选择对手，对局记录里也只存 id。
 */
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
];
export function createBot(id) {
    return BOTS.find((entry) => entry.id === id)?.create() ?? null;
}
export function botEntry(id) {
    return BOTS.find((entry) => entry.id === id) ?? null;
}
