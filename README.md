# 星流 Starflow

> 一张图上，两条星流对撞。**极简规则，无限博弈**——给 AI 写的对战游戏。

星流是一个**同时回合制**的兵力流动战：双方各自守住一颗老家，从老家出发抢占地盘、集结兵力、在对手看不到的地方调兵遣将，最后把对方老家打下来。

写一个 bot 只需要**一个函数**：看到当前局面，返回这一回合要下发的指令。

- 🎮 **在线沙盘**：<https://blackjack513.github.io/ai-game/>（打开即开一局，可换种子、切四人混战、开战争迷雾）
- 📜 **规则速查**：见下方 [游戏规则](#游戏规则)，网页里点右上角「规则」也能看
- 🤖 **Bot API**：见 [写一个 Bot](#写一个-bot)
- 📮 **提交你的 Bot**：见 [提交方式](#提交你的-bot)

---

## 目录

- [为什么是这款游戏](#为什么是这款游戏)
- [快速开始](#快速开始)
- [游戏规则](#游戏规则)
- [写一个 Bot](#写一个-bot)
- [提交你的 Bot](#提交你的-bot)
- [项目结构](#项目结构)
- [开发](#开发)
- [路线图](#路线图)

---

## 为什么是这款游戏

AI 写对战 bot，最容易掉进的坑是：**规则越复杂，代码越趋同**。大家都会写「先造经济、再爆兵、最后 A 过去」，剩下的只是数值调参。

星流反其道而行，用四条规则榨出深度：

1. **同时下令**——你看不到对手这一回合发了什么。读心、诈术、骗兵、双线偷袭全部成立。
2. **每回合最多 5 条指令**——地盘大不等于操作多。你必须取舍：这 5 条兵，是抢矿、补防，还是偷家？
3. **战争迷雾**——只公开归属，不公开兵力。侦察与信息差是真正的资源。
4. **确定性**——无浮点随机，回放 = 种子 + 指令日志。同一局永远可复现，方便复盘和调参。

对人和 AI 都友好：观众在一屏内能看懂九成战况；参赛者半小时能写出第一个能跑的 bot。

---

## 快速开始

需要 Node.js 18+（开发时用的是 24）。

```bash
npm install --ignore-scripts   # 只依赖 typescript 与 jsdom
npm run build                  # 把 src/ 编译到 js/
npm run serve                  # http://127.0.0.1:5173/
```

改代码时用：

```bash
npm run watch   # 监听 src/ 变化自动重编译，并起本地服务器
npm test        # 38 项自测：地图、结算、视野、回放一致性
npm run smoke   # 用 jsdom 驱动真实前端跑一遍交互
```

跑一场离线锦标赛（全部内置 bot 互打）：

```bash
npm run tournament -- --seeds=8                # 单挑 + 四人混战
npm run tournament -- --seeds=50 --duel        # 只跑单挑
```

> `js/` 是编译产物，**直接提交进仓库**，这样 GitHub Pages 不需要任何构建步骤。改完 `src/` 记得 `npm run build` 并把 `js/` 一起提交。

---

## 游戏规则

### 目标

守住自己的**老家**，打掉对手的老家。老家被占领的一方立刻失败。

- **单挑（duel）**：2 人，18 个节点
- **四人混战（ffa）**：4 人，36 个节点，最后存活者获胜

地图由种子生成，旋转对称，双方开局完全公平。开局你只有一个老家（20 兵），其余节点都是中立守军。

### 一个回合

每回合双方**同时**行动，互不可见：

1. **下令**：从自己的任意节点，向图上的任意节点派出任意数量的兵（每回合最多 **5** 条指令）
2. **出兵**：兵变成一支纵队，沿「不经过敌方节点的最短路」前进
3. **结算**：抵达的纵队与守军在同一节点上比较兵力
4. **判负**：老家易主即失败
5. **产出**：所有己方节点产出新兵（当回合新占的节点也算）

**行军时间**：相邻节点当回合到达；距离 2 的节点下一回合到达，依此类推。

### 结算规则（核心）

同一节点上，**兵力最多的一方获胜**：

```
剩余兵力 = 本方可战兵力 − 第二多方的兵力
```

- 其余各方（含守军）全部阵亡
- **平局时守方保留节点**，但兵力归零
- 中立节点平局时仍归中立、兵力归零
- 单个节点兵力上限 **100**

也就是说，**10 打 10 是送**，**10 打 9 只剩 1**。集中兵力才有意义——但集结又会被对手看见。

### 产出

每个己方节点在回合结束时产出新兵：

| 节点类型 | 产出 | 说明 |
| --- | --- | --- |
| 老家 | 4 | 每个玩家一个，被占即败 |
| 农场 / 矿场 / 研究院 | 2 + ⌊己方同类数 ÷ 2⌋ | 三类普通节点，同类越多产出越高 |
| 瞭望塔 | 2 | 视野 3 跳（普通节点 1 跳，老家 2 跳） |
| 兵工厂 | 2 + 3 = 5 | 高产，但攻占时守军 ×2 |

普通节点分三类，**同类节点越多，每个的产出越高**。所以「占满一种类型」是滚雪球的关键，而对手也知道该来断你的矿。

### 视野与迷雾

- 己方节点视野 **1 跳**，老家 **2 跳**，瞭望塔 **3 跳**
- 迷雾只隐藏**兵力**：敌人的归属永远公开，但视野外的兵力显示为 `?`（bot 里是 `null`）
- 中立节点的守军始终公开
- 敌军纵队只要**路径经过你的视野**就能被你看到——所以大规模调兵很难完全隐藏

### 特殊节点

- **瞭望塔**：视野 3 跳，最好的侦察点，但产出低
- **兵工厂**：产出 5，全场最高，但守军更硬（攻占成本更高）

> 赛季 2 会加入「星门」（传送节点）与「空投」，让地图出现第三种打法。

### 终局

- 老家被占 → 立即失败（单挑里双方老家同回合被占则判和）
- 四人混战：老家被占即淘汰，其领地全部中立化
- 150 回合仍无胜负：先比**节点数**，再比**总兵力**，仍然相同判和

终点故意惩罚龟缩：不扩张的一方会在节点数上输掉。

### 非法指令

以下指令会被驳回（当回合作废，不算崩溃）：超过 5 条、节点不存在、起点不是你的、兵力不足、重复指令、没有可通行路径、兵力 ≤ 0。

---

## 写一个 Bot

Bot 就是一个函数：

```ts
export interface Order {
  from: number;   // 起点节点 id（必须是你自己的节点）
  to: number;     // 终点节点 id（可以是中立或敌方）
  troops: number; // 派多少兵
}

export interface Bot {
  name: string;
  style?: string;                    // 一句话风格，会显示在对战界面
  decide(view: Observation): Order[] | void;
}
```

`decide` 每回合被调用一次，返回这一回合要下发的指令（最多 5 条，返回空数组表示什么都不做）。

### Observation（你的视野）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `turn` | `number` | 当前回合（从 1 开始） |
| `maxTurns` | `number` | 回合上限（150） |
| `mode` | `'duel' \| 'ffa'` | 对局模式 |
| `you` | `number` | 你的玩家编号（0 起） |
| `homeNode` | `number` | 你老家的节点 id |
| `nodes` | `ObsNode[]` | 全部节点 |
| `adj` | `number[][]` | 邻接表，`adj[id]` 是相邻节点 |
| `columns` | `ObsColumn[]` | 你视野内正在行军的纵队 |
| `players` | `ObsPlayer[]` | 各玩家概况 |
| `ordersLeft` | `number` | 本回合剩余指令数 |
| `maxOrders` | `number` | 每回合指令上限（5） |
| `rngSeed` | `number` | 本回合给你准备的确定性随机种子 |

`ObsNode`：`{ id, kind, owner, troops, visible, production }`

- `kind`：`'home' | 'farm' | 'mine' | 'lab' | 'watchtower' | 'foundry'`
- `owner`：`-1` 表示中立，否则是玩家编号
- `troops`：**视野外敌人为 `null`**，其余都是真实数字
- `production`：该节点每回合的基础产出（不含同类加成）

`ObsColumn`：`{ owner, troops, path, departTurn, arriveTurn }` —— 路径经过你视野的敌军纵队也会出现，这是你唯一的预警。

### 示例：一个能跑的极简 Bot

下面这个 bot 每回合挑 2 跳内最划算的中立点，每个节点留 1 兵，其余全派出去：

```ts
import type { Bot, Observation, Order } from '../engine/types.js';

export function createRusher(): Bot {
  return {
    name: 'Rusher',
    style: '无脑扩张',
    decide(view: Observation): Order[] {
      const orders: Order[] = [];
      const sent = new Map<number, number>(); // 目标节点 → 本回合已经派过去的兵

      for (const node of view.nodes) {
        if (node.owner !== view.you) continue;
        if (orders.length >= view.maxOrders) break;

        // 只打「和自己相邻」的中立点，优先产出高的
        const target = view.adj[node.id]
          .map((id) => view.nodes[id])
          .filter((n) => n.owner === -1)
          .sort((a, b) => b.production - a.production)[0];
        if (!target) continue;

        const spare = (node.troops ?? 0) - 1; // 每个节点留 1 兵看家
        if (spare <= 0) continue;

        // 中立节点的守军永远可见；凑够守军 +1 就能拿下
        const already = sent.get(target.id) ?? 0;
        const need = (target.troops ?? 4) + 1 - already;
        if (need <= 0) continue;

        const troops = Math.min(spare, need);
        orders.push({ from: node.id, to: target.id, troops });
        sent.set(target.id, already + troops);
      }
      return orders;
    },
  };
}
```

完整的四个陪练 bot 在 [`src/bots/`](src/bots/)：

| Bot | 风格 | 思路 |
| --- | --- | --- |
| **潮汐** `tide` | 稳健扩张 · 步步为营 | 补防 → 抢高产出中立点 → 优势推进 → 后方集结 |
| **毒蛇** `viper` | 侵略偷袭 · 见血封喉 | 找视野外的软目标，双线纵队直扑老家 |
| **磐石** `turtle` | 龟缩反击 · 一击必杀 | 守家、吃弱节点，攒到 20 兵以上再总攻 |
| **新兵** `rookie` | 最简示例 · 全线压上 | 最朴素的写法的参考实现 |

8 个种子的巡演胜率：毒蛇 69% / 潮汐 56% / 磐石 44% / 新兵 6%，三者互为克制（毒蛇克磐石、磐石克潮汐、潮汐克毒蛇）。

### 约定与限制

- `decide` 必须是**纯函数**：不要修改 `view`，不要依赖外部状态（将来的沙箱会强制）
- 每次决策建议 **< 50ms**（现在的内置 bot 大约 0.04ms）
- 抛异常不会让整局崩溃：会被记录为一次 crash，该玩家之后只会提交空指令
- 想让同一套代码在不同对局里表现不同？用 `view.rngSeed`，它是确定性的
- 调试利器：固定种子 + `node scripts/tournament.mjs`，再对照网页回放

---

## 提交你的 Bot

现在采用 **Issue 提交** 的方式：

1. 打开 [提交 Bot 的 Issue 模板](https://github.com/BlackJack513/ai-game/issues/new?template=bot-submission.yml)
2. 填上 bot 名字、一句话风格、完整代码
3. 维护者会把它放进 `src/bots/`，跑一遍自测与平衡巡演，然后合并
4. 合并后它就会出现在网页的选手列表里，所有人可以拿它练手

代码请用 TypeScript，遵循 `Bot` 接口，**只依赖 `view`**（不要 import 引擎内部模块以外的本地文件，单文件提交最好）。

> 下一阶段会在网页里做「粘贴代码 → 直接对战」的 Web Worker 沙箱，免去提交合并的等待。见 [路线图](#路线图)。

---

## 项目结构

```
.
├── index.html            # 单页应用
├── style.css             # 观战界面样式
├── js/                   # 编译产物（提交进仓库，Pages 直接可用）
├── src/
│   ├── engine/
│   │   ├── types.ts      # 规则常量、状态与观察类型
│   │   ├── rng.ts        # 确定性随机数
│   │   ├── mapgen.ts     # 旋转对称地图生成器
│   │   ├── sim.ts        # 规则引擎：回合、结算、视野
│   │   └── runner.ts     # 对局运行器：跑完整局、记录逐帧回放
│   ├── bots/             # 陪练 bot（planner.ts 是公共工具）
│   ├── ui/render.ts      # Canvas 渲染：节点、边、纵队动画、迷雾
│   └── main.ts           # 观战应用：播放、单步、倍速、战报
├── scripts/
│   ├── build.mjs         # TypeScript 编译器 API 编译（无需打包器）
│   ├── dev.mjs           # 监听 + 重编译 + 本地服务器
│   ├── serve.mjs         # 零依赖静态服务器
│   ├── selftest.ts       # 38 项规则自测
│   └── tournament.mjs    # 离线锦标赛
└── .github/              # Issue 模板与 Pages 部署
```

引擎是**零依赖纯 TypeScript**，不碰 DOM；浏览器和 Node 都能跑。

---

## 开发

```bash
npm run build     # 编译 src/ → js/
npm run check     # 只做类型检查（tsc --noEmit）
npm test          # 编译并运行 38 项自测
npm run watch     # 开发模式：监听 + 服务器
```

设计原则：

- **确定性**：所有随机都来自种子；回放 = 种子 + 指令日志，逐帧可复现
- **零后端**：整局对局在浏览器里同步跑完，Pages 直接托管
- **引擎与表现分离**：`engine/` 不进 DOM，`ui/` 只读快照
- **可读优先**：一屏看懂九成战况（当前驻军、产出、行军方向一目了然）

---

## 路线图

- [x] 规则引擎、随机地图、战争迷雾、特殊节点
- [x] 单挑 / 四人混战、观战沙盘、逐帧回放
- [x] 四个陪练 bot 与离线锦标赛
- [x] Issue 提交 bot
- [ ] 网页内粘贴代码直接对战（Web Worker 沙箱 + 每回合限时）
- [ ] 在线匹配、ELO 天梯、排行榜
- [ ] 回放分享链接、战报卡片
- [ ] 赛季 2：星门（传送）、空投、地形

---

## License

[MIT](LICENSE)
