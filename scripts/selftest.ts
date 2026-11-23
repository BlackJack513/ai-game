/** 测试脚本跑在 Node 里，这里只用到 process.exit */
declare const process: { exit(code?: number): never };

/**
 * 规则自测：地图生成 / 战斗结算 / 寻路行军 / 指令校验 / 视野迷雾 / 回放确定性
 *
 * 运行：npm test
 * 这个文件同时是「规则的可执行文档」——每个用例都对应规则里的一句话。
 */

import { BOTS, createBot } from '../src/bots/index.js';
import { generateMap } from '../src/engine/mapgen.js';
import { Match, runMatch } from '../src/engine/runner.js';
import {
  createGame,
  findPath,
  observe,
  playTurn,
  playerProduction,
  productionForKind,
  resolveCombat,
  totalTroops,
  travelTurns,
  validateOrders,
  visionSet,
} from '../src/engine/sim.js';
import {
  NEUTRAL,
  RULES,
  type Bot,
  type GameMap,
  type GameState,
  type Mode,
  type NodeKind,
  type Order,
} from '../src/engine/types.js';

// ---------------------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------------------

let passed = 0;
const failures: Array<{ name: string; message: string }> = [];
let currentSection = '';

function section(name: string): void {
  currentSection = name;
  console.log(`\n${name}`);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name: `${currentSection} / ${name}`, message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

function deepEq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}：\n      期望 ${b}\n      实际 ${a}`);
}

// ---------------------------------------------------------------------------
// 手工地图：规则用例不依赖随机地图生成
// ---------------------------------------------------------------------------

interface MapSpec {
  mode?: Mode;
  kinds: NodeKind[];
  edges: Array<[number, number]>;
  homes: number[];
}

function makeMap(spec: MapSpec): GameMap {
  const count = spec.kinds.length;
  const nodes = spec.kinds.map((kind, id) => {
    const angle = (id / count) * Math.PI * 2;
    return {
      id,
      x: 0.5 + Math.cos(angle) * 0.3,
      y: 0.5 + Math.sin(angle) * 0.3,
      kind,
      garrison: 4,
    };
  });
  const adj: number[][] = spec.kinds.map(() => []);
  for (const [a, b] of spec.edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return {
    seed: 12345,
    mode: spec.mode ?? 'duel',
    nodes,
    edges: spec.edges.map(([a, b]) => [a, b] as [number, number]),
    adj,
    homes: spec.homes.slice(),
  };
}

function makeState(spec: MapSpec): GameState {
  const map = makeMap(spec);
  return {
    map,
    turn: 1,
    nodes: map.nodes.map((node) => ({ owner: NEUTRAL, troops: node.garrison })),
    columns: [],
    players: map.homes.map((_, id) => ({ id, name: `P${id}`, alive: true, eliminatedTurn: null })),
    nextColumnId: 1,
  };
}

function put(state: GameState, id: number, owner: number, troops: number): void {
  state.nodes[id].owner = owner;
  state.nodes[id].troops = troops;
}

/** 相邻三点：0 - 1 - 2，老家在 0 与 2 */
function lineState(): GameState {
  return makeState({
    kinds: ['home', 'farm', 'home'],
    edges: [
      [0, 1],
      [1, 2],
    ],
    homes: [0, 2],
  });
}

function advance(state: GameState, orders: Array<{ player: number; orders: Order[] }>) {
  return playTurn(
    state,
    orders.map((entry) => ({ player: entry.player, orders: entry.orders })),
  );
}

function idleBots(count: number): Bot[] {
  return Array.from({ length: count }, (_, id) => ({ name: `idle-${id}`, decide: () => [] }));
}

// ---------------------------------------------------------------------------
// 1. 地图生成
// ---------------------------------------------------------------------------

section('1. 地图生成');

function countKinds(map: GameMap): Record<NodeKind, number> {
  const counts: Record<NodeKind, number> = {
    home: 0,
    farm: 0,
    mine: 0,
    lab: 0,
    watchtower: 0,
    foundry: 0,
  };
  for (const node of map.nodes) counts[node.kind]++;
  return counts;
}

function checkConnectivity(map: GameMap): void {
  const seen = new Set<number>([0]);
  const queue = [0];
  for (let qi = 0; qi < queue.length; qi++) {
    for (const next of map.adj[queue[qi]]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  eq(seen.size, map.nodes.length, '地图必须连通');
}

function checkEdges(map: GameMap): void {
  const seen = new Set<string>();
  for (const [a, b] of map.edges) {
    assert(a !== b, `自环边 ${a}-${b}`);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    assert(!seen.has(key), `重复边 ${key}`);
    seen.add(key);
    assert(map.adj[a].includes(b), `边 ${a}-${b} 在 adj[${a}] 缺失`);
    assert(map.adj[b].includes(a), `边 ${a}-${b} 在 adj[${b}] 缺失`);
  }
  for (const node of map.nodes) {
    assert(map.adj[node.id].length >= 1, `节点 ${node.id} 是孤点`);
  }
}

function bfsDistance(map: GameMap, from: number, to: number): number {
  const dist = new Array<number>(map.nodes.length).fill(-1);
  dist[from] = 0;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    for (const next of map.adj[queue[qi]]) {
      if (dist[next] !== -1) continue;
      dist[next] = dist[queue[qi]] + 1;
      queue.push(next);
    }
  }
  return dist[to];
}

function checkSymmetry(map: GameMap, rotate: (x: number, y: number) => [number, number]): void {
  for (const node of map.nodes) {
    const [rx, ry] = rotate(node.x, node.y);
    const found = map.nodes.some(
      (other) =>
        other.kind === node.kind && Math.abs(other.x - rx) < 1e-9 && Math.abs(other.y - ry) < 1e-9,
    );
    assert(found, `节点 ${node.id}(${node.kind}) 旋转后没有同类型的对称点`);
  }
}

test('同一个种子生成完全相同的地图（含坐标与边）', () => {
  const a = generateMap('duel', 424242);
  const b = generateMap('duel', 424242);
  deepEq(b.nodes, a.nodes, '节点应完全一致');
  deepEq(b.edges, a.edges, '边应完全一致');
  eq(b.seed, 424242, '地图应保留玩家给的种子');
});

test('不同种子生成不同的地图', () => {
  const a = generateMap('duel', 1);
  const b = generateMap('duel', 2);
  assert(
    a.nodes.some((node, id) => node.x !== b.nodes[id].x || node.y !== b.nodes[id].y),
    '两个种子的节点坐标不应完全相同',
  );
});

test('单挑地图结构：18 节点 / 2 老家 / 4+4+4 普通点 / 塔与厂各 2', () => {
  const map = generateMap('duel', 7);
  eq(map.nodes.length, 18, '节点数');
  eq(map.homes.length, 2, '老家数');
  const counts = countKinds(map);
  eq(counts.home, 2, '老家');
  eq(counts.farm, 4, '农场');
  eq(counts.mine, 4, '矿场');
  eq(counts.lab, 4, '研究院');
  eq(counts.watchtower, 2, '瞭望塔');
  eq(counts.foundry, 2, '兵工厂');
  for (const home of map.homes) eq(map.nodes[home].kind, 'home', `节点 ${home} 应是老家`);
  checkEdges(map);
  checkConnectivity(map);
});

test('四人混战地图结构：36 节点 / 4 老家 / 普通点各 8 / 塔与厂各 4', () => {
  const map = generateMap('ffa', 11);
  eq(map.nodes.length, 36, '节点数');
  eq(map.homes.length, 4, '老家数');
  const counts = countKinds(map);
  eq(counts.home, 4, '老家');
  eq(counts.farm, 8, '农场');
  eq(counts.mine, 8, '矿场');
  eq(counts.lab, 8, '研究院');
  eq(counts.watchtower, 4, '瞭望塔');
  eq(counts.foundry, 4, '兵工厂');
  checkEdges(map);
  checkConnectivity(map);
});

test('地图中心对称：单挑 180°、混战 90° 保持节点类型', () => {
  const duel = generateMap('duel', 99);
  checkSymmetry(duel, (x, y) => [1 - x, 1 - y]);
  const ffa = generateMap('ffa', 99);
  checkSymmetry(ffa, (x, y) => [1 - y, x]);
});

test('两老家最短距离：单挑 ≥ 4 边，混战 ≥ 3 边', () => {
  for (const seed of [3, 17, 88]) {
    const duel = generateMap('duel', seed);
    assert(
      bfsDistance(duel, duel.homes[0], duel.homes[1]) >= 4,
      `duel 种子 ${seed} 的两老家太近`,
    );

    const ffa = generateMap('ffa', seed);
    for (let i = 0; i < ffa.homes.length; i++) {
      for (let j = i + 1; j < ffa.homes.length; j++) {
        assert(
          bfsDistance(ffa, ffa.homes[i], ffa.homes[j]) >= 3,
          `ffa 种子 ${seed} 的 ${i}-${j} 老家太近`,
        );
      }
    }
  }
});

test('20 个随机种子全部能出合法地图', () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (const mode of ['duel', 'ffa'] as const) {
      const map = generateMap(mode, seed);
      eq(map.mode, mode, `${mode}/${seed} 模式`);
      checkEdges(map);
      checkConnectivity(map);
      for (const node of map.nodes) {
        assert(node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1, `节点 ${node.id} 越界`);
      }
    }
  }
});

test('中立守军随距离递增并落在 3..10', () => {
  const map = generateMap('duel', 2024);
  for (const node of map.nodes) {
    if (map.homes.includes(node.id)) {
      eq(node.garrison, RULES.homeStart, '老家初始兵力');
      continue;
    }
    assert(
      node.garrison >= 3 && node.garrison <= 10,
      `节点 ${node.id}（${node.kind}）守军 ${node.garrison} 超出范围`,
    );
  }
});

test('createGame 布阵：老家归位、20 兵，其余中立', () => {
  const state = createGame('duel', 5, ['甲', '乙']);
  eq(state.turn, 1, '初始回合');
  eq(state.players.length, 2, '玩家数');
  state.map.homes.forEach((home, id) => {
    eq(state.nodes[home].owner, id, `老家 ${home} 归属`);
    eq(state.nodes[home].troops, RULES.homeStart, `老家 ${home} 兵力`);
  });
  state.nodes.forEach((node, id) => {
    if (!state.map.homes.includes(id)) eq(node.owner, NEUTRAL, `节点 ${id} 应中立`);
  });
});

// ---------------------------------------------------------------------------
// 2. 战斗结算（纯函数）
// ---------------------------------------------------------------------------

section('2. 战斗结算：强者通吃，剩余 = 最多 − 第二多');

test('守方兵力更多：守方保留，剩余为差值', () => {
  const result = resolveCombat(0, 5, [{ owner: 1, troops: 3 }]);
  eq(result.owner, 0, '归属');
  eq(result.troops, 2, '剩余兵力');
  eq(result.winner, 0, '胜者');
  eq(result.tied, false, '是否平局');
});

test('攻方兵力更多：攻方占领，剩余为差值', () => {
  const result = resolveCombat(0, 3, [{ owner: 1, troops: 5 }]);
  eq(result.owner, 1, '归属');
  eq(result.troops, 2, '剩余兵力');
});

test('同一玩家的多支纵队先合并再比较', () => {
  const merged = resolveCombat(0, 10, [
    { owner: 1, troops: 4 },
    { owner: 1, troops: 5 },
  ]);
  eq(merged.owner, 0, '10 vs 9，守方胜');
  eq(merged.troops, 1, '剩余 1');
});

test('平局：守方保留节点，兵力归零', () => {
  const result = resolveCombat(0, 5, [{ owner: 1, troops: 5 }]);
  eq(result.owner, 0, '守方保留');
  eq(result.troops, 0, '归零');
  eq(result.tied, true, '标记平局');
});

test('中立点平局：仍是中立，兵力归零', () => {
  const result = resolveCombat(NEUTRAL, 4, [{ owner: 0, troops: 4 }]);
  eq(result.owner, NEUTRAL, '中立点不应被占领');
  eq(result.troops, 0, '归零');
});

test('中立点被攻破：按兵力差占领', () => {
  const result = resolveCombat(NEUTRAL, 4, [{ owner: 0, troops: 7 }]);
  eq(result.owner, 0, '归属');
  eq(result.troops, 3, '剩余');
});

test('三方混战：第二名的兵力决定胜者剩余', () => {
  const result = resolveCombat(0, 0, [
    { owner: 1, troops: 6 },
    { owner: 2, troops: 4 },
  ]);
  eq(result.owner, 1, '6 兵者胜');
  eq(result.troops, 2, '剩余 6 − 4');
});

test('兵力上限 100', () => {
  const result = resolveCombat(NEUTRAL, 0, [{ owner: 0, troops: 150 }]);
  eq(result.troops, RULES.maxTroops, '结算后不超过上限');
});

// ---------------------------------------------------------------------------
// 3. 寻路与行军
// ---------------------------------------------------------------------------

section('3. 寻路与行军：相邻当回合到达');

test('相邻 = 0 回合，隔一个点 = 1 回合', () => {
  eq(travelTurns([0, 1]), 0, '相邻');
  eq(travelTurns([0, 1, 2]), 1, '两跳');
  eq(travelTurns([0, 1, 2, 3]), 2, '三跳');
});

test('可以穿过己方与中立节点，不能穿过敌方节点', () => {
  const state = makeState({
    kinds: ['home', 'farm', 'farm', 'home'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
    homes: [0, 3],
  });
  put(state, 0, 0, 10);
  put(state, 3, 1, 10);
  deepEq(findPath(state, 0, 3), [0, 1, 2, 3], '中立节点可通行');

  put(state, 1, 1, 10); // 敌方堵住唯一通路
  eq(findPath(state, 0, 3), null, '敌方节点不可穿过');
  deepEq(findPath(state, 0, 1), [0, 1], '但目标本身可以是敌方节点');
  eq(findPath(state, 0, 0), null, '起点终点相同应返回 null');
  eq(findPath(state, 2, 3), null, '中立起点不能出兵');
});

// ---------------------------------------------------------------------------
// 4. 一回合的完整流程
// ---------------------------------------------------------------------------

section('4. 回合流程：同时下令 → 出兵 → 结算 → 判负 → 产出');

test('相邻进攻当回合结算，新占节点当回合产出', () => {
  const state = lineState();
  put(state, 0, 0, 10);
  put(state, 2, 1, 10);
  put(state, 1, NEUTRAL, 3);

  advance(state, [
    { player: 0, orders: [{ from: 0, to: 1, troops: 8 }] },
    { player: 1, orders: [] },
  ]);

  // 8 打 3 → 占 5 兵；随后农场产出 2+floor(1/2)=2
  eq(state.nodes[1].owner, 0, '节点 1 归属');
  eq(state.nodes[1].troops, 7, '5 兵 + 农场产出 2');
  // 老家 10−8+4
  eq(state.nodes[0].troops, 6, '老家剩余 + 产出');
  eq(state.turn, 2, '回合数 +1');
});

test('两跳的行军当回合只出兵，下一回合才结算', () => {
  const state = lineState();
  put(state, 0, 0, 10);
  put(state, 1, 0, 10);
  put(state, 2, 1, 5);

  advance(state, [
    { player: 0, orders: [{ from: 0, to: 2, troops: 4 }] },
    { player: 1, orders: [] },
  ]);

  eq(state.columns.length, 1, '纵队应还在路上');
  eq(state.columns[0].arriveTurn, 2, '到达回合');
  eq(state.columns[0].path.length, 3, '路径 0-1-2');
  eq(state.nodes[0].troops, 10, '出兵扣 4 后老家再产出 4');

  advance(state, [
    { player: 0, orders: [] },
    { player: 1, orders: [] },
  ]);

  eq(state.columns.length, 0, '第二回合到达');
  eq(state.nodes[2].owner, 1, '5+4 产出 vs 4，守方胜');
  eq(state.nodes[2].troops, 9, '9−4=5 剩余，再加老家产出 4');
});

test('偷家：老家被占，该玩家立即淘汰', () => {
  const state = lineState();
  put(state, 0, 0, 20);
  put(state, 2, 1, 3);
  put(state, 1, NEUTRAL, 4);

  advance(state, [{ player: 0, orders: [{ from: 0, to: 2, troops: 18 }] }]);
  const outcome = advance(state, [{ player: 0, orders: [] }]);

  eq(state.nodes[2].owner, 0, '老家易主');
  eq(state.players[1].alive, false, '玩家 1 淘汰');
  eq(state.players[1].eliminatedTurn, 2, '淘汰回合');
  assert(
    outcome.events.some((event) => event.type === 'eliminated' && event.player === 1),
    '应产生 eliminated 事件',
  );
  assert(
    outcome.events.some((event) => event.type === 'capture' && event.node === 2),
    '应产生 capture 事件',
  );
});

test('四人混战：被淘汰者的领地立即中立化', () => {
  const state = makeState({
    mode: 'ffa',
    kinds: ['home', 'home', 'home', 'home', 'farm', 'farm'],
    edges: [
      [0, 4],
      [1, 4],
      [2, 5],
      [3, 5],
      [4, 5],
    ],
    homes: [0, 1, 2, 3],
  });
  put(state, 0, 0, 100);
  put(state, 1, 1, 5);
  put(state, 2, 2, 10);
  put(state, 3, 3, 10);
  put(state, 5, 1, 7);
  put(state, 4, NEUTRAL, 4);

  advance(state, [{ player: 0, orders: [{ from: 0, to: 1, troops: 60 }] }]);
  advance(state, [{ player: 0, orders: [] }]);

  eq(state.players[1].alive, false, '玩家 1 淘汰');
  eq(state.nodes[1].owner, 0, '被占的老家归攻方');
  eq(state.nodes[5].owner, NEUTRAL, '其它领地中立化');
  eq(state.nodes[5].troops, 0, '中立化后兵力归零');
  eq(state.players[2].alive, true, '其它玩家不受影响');
});

test('产出：同类节点越多产得越快，上限 100', () => {
  eq(productionForKind('home', { home: 1, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 }), 4, '老家');
  eq(
    productionForKind('foundry', { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 1 }),
    5,
    '兵工厂',
  );
  eq(
    productionForKind('watchtower', { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 1, foundry: 0 }),
    2,
    '瞭望塔',
  );
  const zero = { home: 0, farm: 1, mine: 0, lab: 0, watchtower: 0, foundry: 0 };
  eq(productionForKind('farm', zero), 2, '1 个农场');
  eq(productionForKind('farm', { ...zero, farm: 3 }), 3, '3 个农场');
  eq(productionForKind('farm', { ...zero, farm: 6 }), 5, '6 个农场');

  const state = lineState();
  put(state, 0, 0, 1);
  put(state, 1, 0, 1);
  put(state, 2, 1, 1);
  eq(playerProduction(state, 0), 4 + 2, '老家 4 + 农场 2');

  put(state, 2, 0, 98);
  advance(state, []);
  eq(state.nodes[2].troops, RULES.maxTroops, '产出不越过上限');
});

test('指令校验：上限 5 条、起点归属、兵力、重复、无路可走', () => {
  const state = makeState({
    kinds: ['home', 'farm', 'farm', 'farm', 'farm', 'farm', 'home'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
    ],
    homes: [0, 6],
  });
  put(state, 0, 0, 30);

  const many = validateOrders(
    state,
    0,
    [1, 2, 3, 4, 5, 6].map((to) => ({ from: 0, to, troops: 1 })),
  );
  eq(many.orders.length, 5, '只接受 5 条');
  eq(many.rejected.length, 1, '第 6 条被驳回');
  eq(many.rejected[0].reason, '每回合最多 5 条指令', '驳回原因');

  const dup = validateOrders(state, 0, [
    { from: 0, to: 6, troops: 1 },
    { from: 0, to: 6, troops: 1 },
  ]);
  eq(dup.orders.length, 1, '重复指令只留一条');
  eq(dup.rejected[0].reason, '重复指令', '重复原因');

  const poor = validateOrders(state, 0, [{ from: 0, to: 6, troops: 99 }]);
  eq(poor.rejected[0].reason, '该节点可用兵力不足', '兵力不足');

  const foreign = validateOrders(state, 0, [{ from: 1, to: 6, troops: 1 }]);
  eq(foreign.rejected[0].reason, '起点不是你的节点', '起点归属');

  const blocked = makeState({
    kinds: ['home', 'farm', 'home'],
    edges: [
      [0, 1],
      [1, 2],
    ],
    homes: [0, 2],
  });
  put(blocked, 0, 0, 10);
  put(blocked, 1, 1, 10);
  const noPath = validateOrders(blocked, 0, [{ from: 0, to: 2, troops: 1 }]);
  eq(noPath.rejected[0].reason, '没有可通行的路径', '无路可走');
});

// ---------------------------------------------------------------------------
// 5. 视野与迷雾
// ---------------------------------------------------------------------------

section('5. 视野：普通 1 跳 / 老家 2 跳 / 瞭望塔 3 跳');

function viewState(kind: NodeKind): GameState {
  return makeState({
    kinds: [kind, 'farm', 'farm', 'farm', 'farm', 'home'],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ],
    homes: [0, 5],
  });
}

test('老家视野 2 跳，瞭望塔 3 跳，普通节点 1 跳', () => {
  const home = viewState('home');
  put(home, 0, 0, 20);
  deepEq(visionSet(home, 0), [true, true, true, false, false, false], '老家 2 跳');

  const tower = viewState('watchtower');
  put(tower, 0, 0, 5);
  deepEq(visionSet(tower, 0), [true, true, true, true, false, false], '瞭望塔 3 跳');

  const farm = viewState('farm');
  put(farm, 0, 0, 5);
  deepEq(visionSet(farm, 0), [true, true, false, false, false, false], '普通 1 跳');
});

test('迷雾：视野外敌方兵力隐藏，中立守军与归属公开', () => {
  const state = viewState('home');
  put(state, 0, 0, 20);
  put(state, 4, 1, 9);
  put(state, 3, NEUTRAL, 4);

  const view = observe(state, 0);
  eq(view.nodes[4].visible, false, '节点 4 在视野外');
  eq(view.nodes[4].troops, null, '视野外敌方兵力应为 null');
  eq(view.nodes[4].owner, 1, '归属仍然公开');
  eq(view.nodes[3].troops, 4, '中立守军公开');
  eq(view.players[1].totalTroops, null, '别人的总兵力不可见');
  eq(view.players[0].totalTroops, totalTroops(state, 0), '自己的总兵力可见');
  eq(view.turn, state.turn, '观察回合');
  eq(view.maxOrders, RULES.maxOrders, '指令上限');
});

test('纵队只要经过视野内节点就可见', () => {
  const state = viewState('home');
  put(state, 0, 0, 20);
  put(state, 4, 1, 9);
  state.columns.push(
    { id: 1, owner: 1, troops: 5, path: [5, 4], departTurn: 1, arriveTurn: 1 },
    { id: 2, owner: 1, troops: 6, path: [4, 2], departTurn: 1, arriveTurn: 1 },
  );

  const view = observe(state, 0);
  eq(view.columns.length, 1, '只看得到经过视野的那支');
  eq(view.columns[0].troops, 6, '可见纵队的兵力');
});

// ---------------------------------------------------------------------------
// 6. 回放确定性与裁判
// ---------------------------------------------------------------------------

section('6. 回放确定性与终局判定');

function botOrThrow(id: string): Bot {
  const bot = createBot(id);
  assert(bot !== null, `缺少陪练 bot：${id}`);
  return bot;
}

test('相同种子 + 相同 bot = 完全相同的对局（可回放）', () => {
  const options = {
    mode: 'duel' as const,
    seed: 777,
    botIds: ['tide', 'viper'],
    bots: [botOrThrow('tide'), botOrThrow('viper')],
    names: ['潮汐', '毒蛇'],
  };
  const first = runMatch(options);
  const second = runMatch({ ...options, bots: [botOrThrow('tide'), botOrThrow('viper')] });

  deepEq(second.frames, first.frames, '逐帧快照应完全一致');
  eq(second.winner, first.winner, '胜者一致');
  eq(second.reason, first.reason, '结束原因一致');
  assert(first.frames.length > 3, '对局至少跑了几个回合');
});

test('帧号与事件回合号一致（回放不会错位）', () => {
  const result = runMatch({
    mode: 'duel',
    seed: 31,
    botIds: ['tide', 'turtle'],
    bots: [botOrThrow('tide'), botOrThrow('turtle')],
  });

  result.frames.forEach((frame, index) => {
    eq(frame.turn, index, `第 ${index} 帧的回合号`);
    for (const event of frame.events) eq(event.turn, frame.turn, '事件的回合号');
  });
  eq(result.frames[0].nodes.length, result.map.nodes.length, '初始帧节点数');
});

test('陪练 bot 不产生非法指令、不崩溃', () => {
  const result = runMatch({
    mode: 'ffa',
    seed: 12,
    botIds: ['tide', 'viper', 'turtle', 'tide'],
    bots: [botOrThrow('tide'), botOrThrow('viper'), botOrThrow('turtle'), botOrThrow('tide')],
  });
  for (const [index, stats] of result.stats.entries()) {
    eq(stats.invalidOrders, 0, `玩家 ${index} 的非法指令`);
    eq(stats.crashes, 0, `玩家 ${index} 的崩溃次数`);
    assert(stats.thinkMs.every((ms) => ms >= 0), `玩家 ${index} 的耗时必须非负`);
  }
  eq(result.ranking.length, 4, '四人排名');
  deepEq([...result.ranking].sort((a, b) => a - b), [0, 1, 2, 3], '排名是 0..3 的排列');
});

test('回合上限：打满后比节点数决定胜负', () => {
  const result = runMatch({
    mode: 'duel',
    seed: 5,
    botIds: ['idle', 'idle'],
    bots: idleBots(2),
    maxTurns: 20,
  });
  eq(result.reason, '回合上限，比节点数', '结束原因');
  eq(result.frames.length, 21, '初始帧 + 20 回合');
  eq(result.frames[20].turn, 20, '最后一帧回合号');
  // 对称地图上双方都不动，节点数与兵力相同 → 判和
  eq(result.winner, null, '完全同分应判和');
});

test('Match.step 逐回合推进，结束后不再变化', () => {
  const match = new Match({
    mode: 'duel',
    seed: 8,
    botIds: ['viper', 'tide'],
    bots: [botOrThrow('viper'), botOrThrow('tide')],
  });
  let steps = 0;
  while (!match.finished && steps < 200) {
    match.step();
    steps++;
  }
  assert(match.finished, '对局应结束');
  eq(match.frames.length, steps + 1, '帧数 = 步数 + 1');
  eq(match.step(), false, '结束后 step 返回 false');
});

test('四人混战必然产生冠军或明确的结束原因', () => {
  const result = runMatch({
    mode: 'ffa',
    seed: 90,
    botIds: ['viper', 'turtle', 'tide', 'turtle'],
    bots: [botOrThrow('viper'), botOrThrow('turtle'), botOrThrow('tide'), botOrThrow('turtle')],
  });
  assert(result.reason.length > 0, '必须有结束原因');
  assert(result.winner !== null || result.reason.includes('同归于尽'), '应产生冠军或同归于尽');
  const champion = result.ranking[0];
  assert(result.winner === null || result.winner === champion, '冠军应排在第一位');
});

test('bot 崩溃不会中断比赛', () => {
  const bad: Bot = {
    name: 'boom',
    decide: () => {
      throw new Error('故意崩溃');
    },
  };
  const result = runMatch({
    mode: 'duel',
    seed: 6,
    botIds: ['boom', 'tide'],
    bots: [bad, botOrThrow('tide')],
  });
  eq(result.stats[0].crashes, 1, '只记录一次崩溃');
  eq(result.stats[0].thinkMs.length, 1, '崩溃后不再决策');
  eq(result.winner, 1, '对手获胜');
});

// ---------------------------------------------------------------------------
// 7. 陪练 bot 名册
// ---------------------------------------------------------------------------

section('7. 陪练 bot 名册');

test('内置 bot 都能创建且风格互补（4 陪练 + 1 示例 + 2 挑战者）', () => {
  eq(BOTS.length, 7, '内置 bot 数量');
  for (const entry of BOTS) {
    const bot = botOrThrow(entry.id);
    eq(bot.name, entry.name, `${entry.id} 的名称`);
    assert(entry.style.length > 0, `${entry.id} 缺少风格描述`);
    assert(/^#[0-9a-f]{6}$/i.test(entry.color), `${entry.id} 颜色格式`);
  }
});

test('兵力始终在 0..100 且没有负数', () => {
  const result = runMatch({
    mode: 'duel',
    seed: 44,
    botIds: ['tide', 'turtle'],
    bots: [botOrThrow('tide'), botOrThrow('turtle')],
  });
  for (const frame of result.frames) {
    for (const node of frame.nodes) {
      assert(node.troops >= 0 && node.troops <= RULES.maxTroops, `第 ${frame.turn} 回合节点兵力 ${node.troops}`);
    }
    for (const player of frame.players) {
      assert(player.troops >= 0, `第 ${frame.turn} 回合玩家 ${player.id} 总兵力为负`);
    }
  }
});

test('nodeCount 与快照一致', () => {
  const result = runMatch({
    mode: 'ffa',
    seed: 21,
    botIds: ['tide', 'viper', 'turtle', 'viper'],
    bots: [botOrThrow('tide'), botOrThrow('viper'), botOrThrow('turtle'), botOrThrow('viper')],
  });
  const last = result.frames[result.frames.length - 1];
  for (const player of last.players) {
    const owned = last.nodes.filter((node) => node.owner === player.id).length;
    eq(player.nodes, owned, `玩家 ${player.id} 的节点数`);
  }
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('\n' + '─'.repeat(60));
if (failures.length === 0) {
  console.log(`✓ 全部通过：${passed} 项`);
  process.exit(0);
}

console.log(`✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
for (const failure of failures) {
  console.log(`  - ${failure.name}: ${failure.message.split('\n')[0]}`);
}
process.exit(1);
