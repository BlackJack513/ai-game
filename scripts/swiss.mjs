/**
 * 瑞士轮大赛：所有内置 bot 全员编排，任意两名选手恰好相遇一轮，
 * 每个对阵打满 N 场单挑（默认 100 场，席位交替各半），
 * 按瑞士制积分（胜 3 / 平 1 / 负 0）+ 布赫霍尔茨（对手积分和）排名。
 *
 *   node scripts/build.mjs && node scripts/swiss.mjs
 *   node scripts/swiss.mjs --games=100        # 每个对阵的场数
 *   node scripts/swiss.mjs --ffa=5            # 额外枚举全部四人组合，每组合 5 局混战
 *   node scripts/swiss.mjs --offset=9999      # 换一批种子，避免和上次的种子集重复
 *
 * 注意：跑的是 js/ 里的编译产物，改完 src 记得先 node scripts/build.mjs。
 */

import { BOTS } from '../js/bots/index.js';
import { runMatch } from '../js/engine/runner.js';

const args = process.argv.slice(2);
const gamesPerPair = Number(args.find((arg) => arg.startsWith('--games='))?.split('=')[1] ?? 100);
const ffaRounds = Number(args.find((arg) => arg.startsWith('--ffa='))?.split('=')[1] ?? 0);
const seedOffset = Number(args.find((arg) => arg.startsWith('--offset='))?.split('=')[1] ?? 0);

if (!Number.isFinite(gamesPerPair) || gamesPerPair < 1) {
  console.error('--games 必须是正整数');
  process.exit(1);
}

const label = (id) => BOTS.find((bot) => bot.id === id)?.name ?? id;

/** 按显示宽度（中日韩字符占 2 格）右侧补空格。 */
function pad(text, width) {
  const w = [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

/** 轮转编排：奇数人数补一个轮空位，每轮每人最多出场一次，任意两人恰好相遇一次。 */
function scheduleRounds(ids) {
  const list = ids.slice();
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    let bye = null;
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === null) bye = b;
      else if (b === null) bye = a;
      else pairs.push([a, b]);
    }
    rounds.push({ pairs, bye });
    const fixed = list[0];
    const rest = list.slice(1);
    rest.unshift(rest.pop());
    list.splice(0, list.length, fixed, ...rest);
  }
  return rounds;
}

/** @type {Map<string, { id: string; points: number; wins: number; draws: number; losses: number; games: number; opponents: string[] }>} */
const table = new Map(
  BOTS.map((bot) => [
    bot.id,
    { id: bot.id, points: 0, wins: 0, draws: 0, losses: 0, games: 0, opponents: [] },
  ]),
);

const pairKey = (a, b) => [a, b].sort().join('|');
/** @type {Map<string, { a: string; b: string; aWins: number; bWins: number; draws: number; games: number }>} */
const headToHead = new Map();
/** @type {Map<string, { points: number; games: number; wins: number }>} */
const ffa = new Map();

let invalidOrders = 0;
let crashCount = 0;
let thinkTotalMs = 0;
let thinkSamples = 0;
let drawCount = 0;

function soak(result) {
  for (const stat of result.stats) {
    invalidOrders += stat.invalidOrders;
    crashCount += stat.crashes;
    for (const ms of stat.thinkMs) {
      thinkTotalMs += ms;
      thinkSamples++;
    }
  }
}

function playDuel(aId, bId, round, pairIndex) {
  const a = BOTS.find((bot) => bot.id === aId);
  const b = BOTS.find((bot) => bot.id === bId);
  const record = headToHead.get(pairKey(aId, bId)) ?? {
    a: aId,
    b: bId,
    aWins: 0,
    bWins: 0,
    draws: 0,
    games: 0,
  };
  headToHead.set(pairKey(aId, bId), record);

  for (let game = 0; game < gamesPerPair; game++) {
    const flip = game % 2 === 1;
    const first = flip ? b : a;
    const second = flip ? a : b;
    const seed = 1 + ((seedOffset + round * 104_729 + pairIndex * 7_919 + game * 17) % 9_000_000);
    const result = runMatch({
      mode: 'duel',
      seed,
      botIds: [first.id, second.id],
      bots: [first.create(), second.create()],
      names: [first.name, second.name],
    });
    soak(result);

    const left = table.get(first.id);
    const right = table.get(second.id);
    left.games++;
    right.games++;
    record.games++;

    if (result.winner === null) {
      left.points += 1;
      right.points += 1;
      left.draws++;
      right.draws++;
      record.draws++;
      drawCount++;
    } else {
      const winner = result.winner === 0 ? first : second;
      const loser = result.winner === 0 ? second : first;
      table.get(winner.id).wins++;
      table.get(winner.id).points += 3;
      table.get(loser.id).losses++;
      if (winner.id === aId) record.aWins++;
      else record.bWins++;
    }
  }
  table.get(aId).opponents.push(bId);
  table.get(bId).opponents.push(aId);
}

/** 两名选手的直接交手胜场（用于同分时的直胜判定）。 */
function headToHeadWins(id, opponentId) {
  const record = headToHead.get(pairKey(id, opponentId));
  if (!record) return 0;
  return record.a === id ? record.aWins : record.bWins;
}

const rankings = () =>
  [...table.values()]
    .map((row) => ({
      ...row,
      buchholz: row.opponents.reduce((sum, id) => sum + (table.get(id)?.points ?? 0), 0),
    }))
    .sort(
      (x, y) =>
        y.points - x.points ||
        y.buchholz - x.buchholz ||
        headToHeadWins(y.id, x.id) - headToHeadWins(x.id, y.id) ||
        y.wins - x.wins,
    );

console.log(`\n瑞士轮大赛 · ${BOTS.length} 名选手 · 每轮每台打 ${gamesPerPair} 场单挑`);
console.log(`席位交替，消除先手偏差；任意两名选手恰好相遇一轮。\n`);

const rounds = scheduleRounds(BOTS.map((bot) => bot.id));
const started = Date.now();

rounds.forEach((round, roundIndex) => {
  const order = new Map(rankings().map((row, index) => [row.id, index]));
  const pairs = round.pairs
    .slice()
    .sort((x, y) => {
      const rank = (pair) => Math.min(order.get(pair[0]) ?? 0, order.get(pair[1]) ?? 0);
      return rank(x) - rank(y);
    });

  console.log(`${'─'.repeat(52)}`);
  console.log(` 第 ${roundIndex + 1} 轮` + (round.bye ? ` · ${label(round.bye)} 轮空` : ''));

  pairs.forEach(([aId, bId], pairIndex) => {
    playDuel(aId, bId, roundIndex, pairIndex);
    const record = headToHead.get(pairKey(aId, bId));
    const left = record.a === aId ? record.aWins : record.bWins;
    const right = record.a === aId ? record.bWins : record.aWins;
    console.log(
      `   ${pad(label(aId), 16)}${String(left).padStart(4)} : ${String(right).padEnd(4)}${pad(label(bId), 16)}${record.draws ? `（平 ${record.draws}）` : ''}`,
    );
  });
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const final = rankings();

console.log('\n' + '─'.repeat(52));
console.log(' 瑞士制总排名（胜 3 / 平 1 / 负 0，同分看布赫霍尔茨 → 直胜 → 胜场）');
console.log(
  ` ${pad('排名', 7)}${pad('选手', 18)}${pad('积分', 7)}${pad('胜', 5)}${pad('平', 5)}${pad('负', 5)}${pad('胜率', 8)}布赫霍尔茨`,
);
final.forEach((row, index) => {
  const rate = ((row.wins / Math.max(1, row.games)) * 100).toFixed(1);
  console.log(
    ` ${pad(`${index + 1}.`, 7)}${pad(label(row.id), 18)}${pad(String(row.points), 7)}${pad(String(row.wins), 5)}${pad(String(row.draws), 5)}${pad(String(row.losses), 5)}${pad(`${rate}%`, 8)}${row.buchholz}`,
  );
});

console.log('\n' + '─'.repeat(52));
console.log(' 对阵总表（左侧选手视角）');
for (const row of final) {
  const lines = [];
  for (const opponent of BOTS) {
    if (opponent.id === row.id) continue;
    const record = headToHead.get(pairKey(row.id, opponent.id));
    if (!record) continue;
    const mine = record.a === row.id ? record.aWins : record.bWins;
    const theirs = record.a === row.id ? record.bWins : record.aWins;
    lines.push(`${label(opponent.id)} ${mine}:${theirs}`);
  }
  console.log(` ${pad(label(row.id), 16)}${lines.join('   ')}`);
}

// ---- 可选的四人混战巡演：枚举全部四人组合 ----
if (ffaRounds > 0) {
  const groups = [];
  const pick = (start, chosen) => {
    if (chosen.length === 4) {
      groups.push(chosen.slice());
      return;
    }
    for (let i = start; i < BOTS.length; i++) {
      chosen.push(BOTS[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);

  console.log('\n' + '─'.repeat(52));
  console.log(` 四人混战巡演 · ${groups.length} 个组合 × 每组合 ${ffaRounds} 局`);
  groups.forEach((seated, groupIndex) => {
    for (let round = 0; round < ffaRounds; round++) {
      const result = runMatch({
        mode: 'ffa',
        seed: 1 + ((seedOffset + groupIndex * 977 + round * 271 + 13) % 9_000_000),
        botIds: seated.map((bot) => bot.id),
        bots: seated.map((bot) => bot.create()),
        names: seated.map((bot) => bot.name),
      });
      soak(result);
      seated.forEach((bot, index) => {
        const row = ffa.get(bot.id) ?? { points: 0, games: 0, wins: 0 };
        row.games++;
        if (result.winner === index) {
          row.wins++;
          row.points += 3;
        } else if (result.winner === null) {
          row.points += 1;
        }
        ffa.set(bot.id, row);
      });
    }
    const names = seated.map((bot) => label(bot.id)).join(' / ');
    console.log(`   ${pad(names, 46)}完成 ${ffaRounds} 局`);
  });
  const ffaRows = [...ffa.entries()].sort((a, b) => b[1].points - a[1].points || b[1].wins - a[1].wins);
  console.log(' 混战积分（胜 3 / 平 1）：');
  for (const [id, row] of ffaRows) {
    const rate = ((row.wins / Math.max(1, row.games)) * 100).toFixed(1);
    console.log(
      `   ${pad(label(id), 18)}${pad(`${row.points} 分`, 9)}${pad(`${row.wins}/${row.games} 胜`, 12)}${rate}%`,
    );
  }
}

console.log('\n' + '─'.repeat(52));
const duelGames = ((BOTS.length * (BOTS.length - 1)) / 2) * gamesPerPair;
console.log(
  ` 共 ${duelGames} 场单挑 · 平局 ${drawCount} · 非法指令 ${invalidOrders} · 崩溃 ${crashCount} · 平均决策 ${(thinkTotalMs / Math.max(1, thinkSamples)).toFixed(2)}ms · 耗时 ${elapsed}s`,
);