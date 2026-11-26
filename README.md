# 星流 Starflow

给 AI 写的对战游戏：在图上同时调兵，打掉对方老家。

**在线沙盘**：<https://blackjack513.github.io/ai-game/>

**单挑排行榜**：[LEADERBOARD.md](LEADERBOARD.md)

**四人混战排行榜**：[FFA-LEADERBOARD.md](FFA-LEADERBOARD.md)

---

## 游戏规则

### 目标

- **单挑**：2 人，18 个节点
- **四人混战**：4 人，36 个节点，最后存活者获胜
- 老家被占领的一方立刻失败

地图由种子生成（旋转对称），开局只有一个老家（20 兵），其余节点都是中立守军。

### 回合流程

双方**同时**下令，每回合最多 **5** 条指令 `(起点, 终点, 兵力)`：

1. **下令**：从自己的任意节点向任意节点派兵
2. **行军**：沿「不经过敌方节点的最短路」前进，相邻节点当回合到达，距离 n 需 n−1 回合
3. **结算**：到达的纵队与守军在同一节点上比较兵力
4. **判负**：老家易主即失败
5. **产出**：己方节点产出新兵（当回合新占的节点也算）

### 结算

- 兵力最多的一方获胜
- 剩余兵力 = 本方兵力 − 第二名兵力，其余全灭
- 平局时守方保留节点，但兵力归零
- 单个节点兵力上限 **100**

### 产出

| 节点 | 每回合产出 |
| --- | --- |
| 老家 | 4 |
| 农场 / 矿场 / 研究院 | 2 + ⌊己方同类数 ÷ 2⌋ |
| 瞭望塔 | 2 |
| 兵工厂 | 5 |

### 视野

- 己方节点视野 1 跳，老家 2 跳，瞭望塔 3 跳
- 视野外的敌方节点隐藏兵力（`?`），归属始终公开，中立守军始终公开
- 敌军纵队只要路径经过你的视野就能看到

### 特殊节点

- **瞭望塔**：视野 3 跳
- **兵工厂**：产出 5，守军更硬

### 终局

- 150 回合后：先比节点数，再比总兵力，仍相同判和
- 四人混战：老家被占即淘汰，领地全部中立化

### 非法指令

以下指令会被驳回：超过 5 条、节点不存在、起点不是自己的、兵力不足、重复指令、没有可通行路径、兵力 ≤ 0。

---

## 写一个 Bot

```ts
export interface Order {
  from: number;   // 起点（必须是自己的节点）
  to: number;     // 终点（中立或敌方）
  troops: number; // 派多少兵
}

export interface Bot {
  name: string;
  style?: string;
  decide(view: Observation): Order[] | void;
}
```

每回合调用一次 `decide`，返回这回合的指令（最多 5 条，返回空数组表示不动）。

### Observation

| 字段 | 说明 |
| --- | --- |
| `turn` / `maxTurns` | 当前回合 / 回合上限（150） |
| `mode` | `'duel'` 或 `'ffa'` |
| `you` | 你的玩家编号 |
| `homeNode` | 老家节点 id |
| `nodes` | 全部节点：`{ id, kind, owner, troops, visible, production }` |
| `adj` | 邻接表，`adj[id]` 是相邻节点 id |
| `columns` | 视野内正在行军的纵队 |
| `players` | 各玩家概况 |
| `ordersLeft` / `maxOrders` | 剩余指令数 / 上限（5） |
| `rngSeed` | 本回合的确定性随机种子 |

节点字段说明：

- `kind`：`home` / `farm` / `mine` / `lab` / `watchtower` / `foundry`
- `owner`：`-1` 是中立，否则是玩家编号
- `troops`：视野外的敌人为 `null`，其余是真实兵力

`columns` 里每条纵队：`{ owner, troops, path, departTurn, arriveTurn }`。

### 最小示例

```ts
import type { Bot, Observation, Order } from '../engine/types.js';

export function createMyBot(): Bot {
  return {
    name: '我的 Bot',
    style: '一路平推',
    decide(view: Observation): Order[] {
      const orders: Order[] = [];
      for (const node of view.nodes) {
        if (node.owner !== view.you || orders.length >= view.maxOrders) continue;

        // 找相邻的中立点
        const target = view.adj[node.id]
          .map((id) => view.nodes[id])
          .find((n) => n.owner === -1);
        if (!target) continue;

        const troops = (node.troops ?? 0) - 1; // 留 1 兵看家
        if (troops > 0) orders.push({ from: node.id, to: target.id, troops });
      }
      return orders;
    },
  };
}
```

要求：纯函数，不改 `view`，不依赖外部状态，单次决策建议 50ms 内。抛异常只记一次 crash，之后该玩家自动超时。

### 两条榜单，任选战场

游戏有两种模式，对应两条**互相独立**的榜单，你可以只专注其中一条，也可以两条都打：

| 榜单 | 模式 | 榜单规模 | 打榜方式 |
| --- | --- | --- | --- |
| [单挑排行榜](LEADERBOARD.md) | 2 人对战 | 前 **10** 名 | 前十 + 1 位挑战者，两两各打 1000 场 |
| [四人混战排行榜](FFA-LEADERBOARD.md) | 4 人乱战 | 前 **8** 名 | 全员参与，平衡轮转（每人 100 桌 × 每桌 20 局） |

- **只打单挑**：只为 2 人对战设计策略，只参与单挑榜排名；
- **只打混战**：只为 4 人乱战设计策略，只参与混战榜排名；
- **两个都打**：同一个 bot（或同一套思路的两个版本）两条榜都投，两条榜分别独立排名、分别评测。

只专注一条榜**完全不会吃亏**：另一条榜不测、不扣分、不影响排名。本项目的宗旨是**玩得开心**，不要求全能选手——喜欢正面硬刚就做单挑，喜欢多线周旋就做混战，两条都想玩就都投。投稿时在模板里写明主攻方向（单挑 / 混战 / 双榜），维护者按对应赛制评测。

### 挑战排行榜

[单挑排行榜](LEADERBOARD.md) 只邀请**当前前十名 + 1 位榜外挑战者**（共 11 位），两两各打 1000 场（交替先后手、固定种子）生成；第 10 名以后的 bot 不再参与打榜。只想专注单挑的话，看这一节就够了。

新 bot 的目标是**打败前十名中的任意一位**：先 `npm run challenge -- --bot=<id>` 让这位榜外 bot 与当前前十名打一轮瑞士轮（十名对手各 1000 场，交替先后手、固定种子），看清自己与每位前十名的对战胜率，再针对性迭代。

**更新排行榜必须和前十名两两打满 1000 场**：每次更新 [LEADERBOARD.md](LEADERBOARD.md) 前，都要让新/变更的选手与当前前十名完成每对 1000 场的完整轮转，共 11 位、55 对、55000 场；打榜线为第 10 名，落榜者退出后续打榜。

```bash
npm run ladder -- --bot=<id>          # 打榜：前十 + 1 位挑战者，共 11 位（默认每对各 1000 场）
npm run challenge -- --bot=<id>       # 只看挑战者对前十的逐场战绩（同样 11 位）
npm run challenge -- --games=100      # 调整每个对阵的场数（默认 1000）
```

前十名名单从 [LEADERBOARD.md](LEADERBOARD.md) 的「前十名」表格读取，榜单更新后命令会自动跟随。

**不可以参考前十名 bot 的代码**（包括 `src/bots/` 源码与 `js/bots/` 编译产物），只能从规则出发独立设计，并靠运行结果获取反馈。

### 四人混战排行榜

[四人混战排行榜](FFA-LEADERBOARD.md) 展示**前八名**，但评测时**所有 bot 都参与**。四人混战里策略会互相克制（A 压 B、B 压 C、C 又压 A），只在「当前前八 + 新 bot」的小池子里比较，会让曾经一次小样本失手就落榜的 bot 永远没有翻身机会。所以赛制改为全员平衡轮转：

- **全员参与**：不设打榜线，所有登记在册的 bot 每期都重新评测，榜单只展示前八名；
- **平衡轮转**：为每名选手安排相同数量的四人桌（默认 **100 桌**），用贪心让任意两名选手的同场次数尽量相等（22 人时每对 13–16 次），成本是 O(选手数 × 每人桌数)，不再随人数组合爆炸；
- **每桌局数**：默认 **20 局**，取 4 的倍数可走完座位整周期；每局桌内座位按「桌序号 + 局数」轮换，固定种子，结果可复现；
- **积分**：按终局名次第 1/2/3/4 名分别 3/2/1/0 分（并列第一各 2.5 分），按**场均分 → 平均名次 → 第一率**排序；
- **误差**：输出桌级 bootstrap 95% 置信区间，两名相邻选手的区间重叠时标 `≈`，表示这一名之差在采样误差内不可区分。

```bash
npm run ffa                                    # 全员平衡轮转：每人 100 桌 × 每桌 20 局，22 人约 4 分钟
npm run ffa -- --tables=300 --games=40         # 加密复核，用于定榜或争议名次
npm run ffa -- --design=full --games=20        # 全组合复核（22 人 7315 桌）
npm run ffa -- --dry-run                       # 只看分组均衡度，不跑对局
npm run ffa -- --pool=<id1>,<id2>,<id3>,<id4>  # 指定参赛名单（至少 4 人）
```

### AI 参赛纪律（请自觉遵守）

用 AI 编写 bot 时，请把比赛当作「闭卷考试」：

- **可以看**：本 README、`src/engine/`（规则与类型）、`src/bots/index.ts`（注册方式）、`scripts/` 里的构建与评测脚本；
- **不可以看**：其他 bot 的代码，包括 `src/bots/` 下除自己文件外的任何文件，以及 `js/bots/` 中对应的编译产物；
- **只能通过运行来获取反馈**：用 `npm test`、`npm run tournament`、`npm run swiss`、`npm run ffa`、`npm run challenge`、`npm run ladder` 等命令跑测试与对战，根据胜率、非法指令和崩溃统计迭代自己的策略；
- **不要变相偷看**：不复制、改写、拼接他人的实现或策略结构，也不要试图从评测输出反推别人的源码。

这样做的目的是让每个 AI 都从规则出发独立设计策略，保证对局与投稿的公平性。这是对参赛者的自律要求，仓库不做强制检查。

---

## 提交代码

1. 打开 [Bot 提交模板](https://github.com/BlackJack513/ai-game/issues/new?template=bot-submission.yml)
2. 填写名字、一句话风格、**主攻方向（单挑 / 混战 / 双榜）**、完整代码
3. 维护者跑自测，再按主攻方向评测：单挑榜跑 11 位打榜（每对 1000 场），混战榜全员平衡轮转（每人 100 桌 × 每桌 20 局），双榜则两项都跑；确认后合并，之后会出现在网页的选手列表里

单榜投稿与双榜投稿一视同仁：只打一个榜的 bot 只在对应榜单上排名，另一个榜的评测完全不参与。

代码要求：单个 TypeScript 文件，实现 `Bot` 接口，只依赖 `view`，同意以 MIT 协议收录。

---

## 本地运行

```bash
npm install --ignore-scripts
npm run build
npm run serve   # http://127.0.0.1:5173/
```

`npm test` 跑规则自测，`npm run tournament -- --seeds=8` 跑内置 bot 的离线锦标赛，`npm run challenge -- --bot=<id>` 让一位榜外 bot 与前十名打一轮瑞士轮（默认为每对 1000 场），`npm run ladder -- --bot=<id>` 跑 11 位打榜循环赛并生成排行榜（默认为每对 1000 场）。

---

## License

[MIT](LICENSE)
