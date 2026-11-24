/**
 * 前十挑战赛：打榜选手只需和当前排行榜前十名打一轮瑞士轮，
 * 不必等全量循环赛（全员两两对战）跑完。
 *
 *   npm run challenge -- --bot=chengying     # 1 位榜外 bot 挑战前十（共 11 位，每对 1000 场）
 *   npm run challenge -- --games=100         # 每个对阵的场数（默认 1000）
 *   npm run challenge -- --top=10            # 榜单取前 N 名（默认 10）
 *   npm run challenge -- --json=work/challenge.json
 *
 * 前十名单从 LEADERBOARD.md 的「前十名」表格解析，榜单更新后自动跟随；
 * 跑的是 js/ 里的编译产物，改完 src 记得先 node scripts/build.mjs。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BOTS } from '../js/bots/index.js';
import { runMatch } from '../js/engine/runner.js';

const args = process.argv.slice(2);
const readArg = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const gamesPerPair = Number(readArg('games') ?? process.env.GAMES ?? 1000);
const topSize = Number(readArg('top') ?? process.env.TOP ?? 10);
const seedBase = Number(readArg('seed-base') ?? process.env.SEED_BASE ?? 200_000);
const jsonOut = readArg('json') ?? process.env.JSON_OUT;
const botArg = readArg('bot') ?? process.env.BOT;

if (!Number.isInteger(gamesPerPair) || gamesPerPair < 1) {
  console.error('--games 必须是正整数');
  process.exit(1);
}
if (!Number.isInteger(topSize) || topSize < 1 || topSize > BOTS.length - 1) {
  console.error(`--top 必须是 1 到 ${BOTS.length - 1} 之间的整数`);
  process.exit(1);
}

const label = (id) => BOTS.find((bot) => bot.id === id)?.name ?? id;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** 按显示宽度（中日韩字符占 2 格）右侧补空格。 */
function pad(text, width) {
  const w = [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

/** 解析 LEADERBOARD.md「前十名」表格里的选手名，按排名顺序返回。 */
function readTopNames(limit) {
  const text = readFileSync(new URL('../LEADERBOARD.md', import.meta.url), 'utf8');
  const heading = text.indexOf('## 前十名');
  if (heading < 0) fail('LEADERBOARD.md 里找不到「## 前十名」小节');

  const names = [];
  for (const line of text.slice(heading).split(/\r?\n/)) {
    if (names.length >= limit) break;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || !/^\d+$/.test(cells[1])) continue;
    names.push(cells[2]);
  }
  if (names.length < limit) {
    fail(`LEADERBOARD.md 的「前十名」表格只有 ${names.length} 行，不足 ${limit} 名`);
  }
  return names;
}

/** 名字或 id 都能定位到内置 bot。 */
function findBot(token) {
  const key = token.trim();
  return (
    BOTS.find((bot) => bot.name === key) ??
    BOTS.find((bot) => bot.id === key) ??
    BOTS.find((bot) => bot.id.toLowerCase() === key.toLowerCase()) ??
    null
  );
}

const topNames = readTopNames(topSize);
const topBots = topNames.map((name, index) => {
  const bot = findBot(name);
  if (!bot) fail(`排行榜第 ${index + 1} 名「${name}」在内置 bot 里找不到`);
  return bot;
});
const topIds = new Set(topBots.map((bot) => bot.id));

const challengers = botArg
  ? botArg
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => {
        const bot = findBot(token);
        if (!bot) fail(`找不到挑战者「${token}」，可填 bot id 或显示名`);
        if (topIds.has(bot.id)) fail(`「${bot.name}」已在前十名内，不需要挑战自己`);
        return bot;
      })
  : BOTS.filter((bot) => !topIds.has(bot.id));

if (challengers.length === 0) {
  console.error('没有可挑战的选手：榜外没有内置 bot，请用 --bot=<id> 指定挑战者');
  process.exit(1);
}
if (new Set(challengers.map((bot) => bot.id)).size !== challengers.length) {
  console.error('--bot 里有重复的选手');
  process.exit(1);
}
if (challengers.length > 1) {
  fail(
    `打榜只邀请 1 位榜外挑战者，当前榜外有 ${challengers.length} 位（${challengers
      .map((bot) => bot.id)
      .join(', ')}），请用 --bot=<id> 指定`,
  );
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

const participants = [...topBots, ...challengers];
const challengerIds = new Set(challengers.map((bot) => bot.id));

/** @type {Map<string, { id: string; points: number; wins: number; draws: number; losses: number; games: number; opponents: string[] }>} */
const table = new Map(
  participants.map((bot) => [
    bot.id,
    { id: bot.id, points: 0, wins: 0, draws: 0, losses: 0, games: 0, opponents: [] },
  ]),
);

const pairKey = (a, b) => [a, b].sort().join('|');
/** @type {Map<string, { a: string; b: string; aWins: number; bWins: number; draws: number }>} */
const headToHead = new Map();

let invalidOrders = 0;
let crashCount = 0;
let thinkTotalMs = 0;
let thinkSamples = 0;
let drawCount = 0;

function playDuel(aId, bId, round, pairIndex) {
  const a = BOTS.find((bot) => bot.id === aId);
  const b = BOTS.find((bot) => bot.id === bId);
  const record = headToHead.get(pairKey(aId, bId)) ?? {
    a: aId,
    b: bId,
    aWins: 0,
    bWins: 0,
    draws: 0,
  };
  headToHead.set(pairKey(aId, bId), record);

  for (let game = 0; game < gamesPerPair; game++) {
    const flip = game % 2 === 1;
    const first = flip ? b : a;
    const second = flip ? a : b;
    const seed = 1 + ((seedBase + round * 104_729 + pairIndex * 7_919 + game * 17) % 9_000_000);
    const result = runMatch({
      mode: 'duel',
      seed,
      botIds: [first.id, second.id],
      bots: [first.create(), second.create()],
      names: [first.name, second.name],
    });

    for (const stat of result.stats) {
      invalidOrders += stat.invalidOrders;
      crashCount += stat.crashes;
      for (const ms of stat.thinkMs) {
        thinkTotalMs += ms;
        thinkSamples++;
      }
    }

    const left = table.get(first.id);
    const right = table.get(second.id);
    left.games++;
    right.games++;

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
      if (winner.id === record.a) record.aWins++;
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

const topRank = new Map(topBots.map((bot, index) => [bot.id, index + 1]));
const challengerNames = challengers.map((bot) => bot.name).join(' / ');

console.log(
  `\n前十挑战赛 · 挑战者 ${challengerNames} · 对手 ${topSize} 名（来自 LEADERBOARD.md） · 每台 ${gamesPerPair} 场单挑`,
);
console.log(`席位交替，消除先手偏差；每名挑战者与前十名各相遇一轮。\n`);

const rounds = scheduleRounds(participants.map((bot) => bot.id));
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
    const mark = (id) => (challengerIds.has(id) ? `★${label(id)}` : label(id));
    console.log(
      `   ${pad(mark(aId), 18)}${String(left).padStart(4)} : ${String(right).padEnd(4)}${pad(mark(bId), 18)}${record.draws ? `（平 ${record.draws}）` : ''}`,
    );
  });
});

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const final = rankings();

console.log('\n' + '─'.repeat(52));
console.log(' 挑战赛总排名（★ 为挑战者，胜 3 / 平 1 / 负 0）');
console.log(
  ` ${pad('排名', 7)}${pad('选手', 20)}${pad('积分', 7)}${pad('胜', 5)}${pad('平', 5)}${pad('负', 5)}${pad('胜率', 8)}布赫霍尔茨`,
);
final.forEach((row, index) => {
  const rate = ((row.wins / Math.max(1, row.games)) * 100).toFixed(1);
  const name = `${challengerIds.has(row.id) ? '★' : ''}${label(row.id)}`;
  console.log(
    ` ${pad(`${index + 1}.`, 7)}${pad(name, 20)}${pad(String(row.points), 7)}${pad(String(row.wins), 5)}${pad(String(row.draws), 5)}${pad(String(row.losses), 5)}${pad(`${rate}%`, 8)}${row.buchholz}`,
  );
});

console.log('\n' + '─'.repeat(52));
console.log(' 挑战者对前十战绩（目标：打败任意一位）');

const verdicts = new Map();
for (const challenger of challengers) {
  console.log(
    ` ${pad(challenger.name, 18)}${pad('对手', 20)}${pad('榜位', 7)}${pad('胜', 5)}${pad('平', 5)}${pad('负', 5)}胜率`,
  );
  for (const opponent of topBots) {
    const record = headToHead.get(pairKey(challenger.id, opponent.id));
    const mine = record ? (record.a === challenger.id ? record.aWins : record.bWins) : 0;
    const theirs = record ? (record.a === challenger.id ? record.bWins : record.aWins) : 0;
    const draws = record?.draws ?? 0;
    const rate = ((mine / Math.max(1, mine + theirs + draws)) * 100).toFixed(1);
    if (mine > theirs) verdicts.set(challenger.id, [...(verdicts.get(challenger.id) ?? []), opponent.name]);
    console.log(
      ` ${pad('', 18)}${pad(opponent.name, 20)}${pad(`第 ${topRank.get(opponent.id)}`, 7)}${pad(String(mine), 5)}${pad(String(draws), 5)}${pad(String(theirs), 5)}${rate}%${mine > theirs ? '  ✓ 击败' : ''}`,
    );
  }
}

console.log('\n' + '─'.repeat(52));
for (const challenger of challengers) {
  const beaten = verdicts.get(challenger.id) ?? [];
  console.log(
    beaten.length > 0
      ? ` ${challenger.name}：击败了 ${beaten.join('、')} —— 达成「打败前十名任意一位」的目标`
      : ` ${challenger.name}：未击败任何前十名选手`,
  );
}

console.log(
  `\n 共 ${rounds.reduce((sum, round) => sum + round.pairs.length, 0) * gamesPerPair} 场单挑 · 平局 ${drawCount} · 非法指令 ${invalidOrders} · 崩溃 ${crashCount} · 平均决策 ${(thinkTotalMs / Math.max(1, thinkSamples)).toFixed(2)}ms · 耗时 ${elapsed}s`,
);

if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        gamesPerPair,
        top: topBots.map((bot) => ({ id: bot.id, name: bot.name, rank: topRank.get(bot.id) })),
        challengers: challengers.map((bot) => ({ id: bot.id, name: bot.name })),
        rankings: final.map((row) => ({
          ...row,
          name: label(row.id),
          challenger: challengerIds.has(row.id),
        })),
        headToHead: Object.fromEntries(headToHead),
        verdicts: Object.fromEntries(verdicts),
      },
      null,
      2,
    ),
  );
  console.log(` 数据已写入 ${jsonOut}`);
}