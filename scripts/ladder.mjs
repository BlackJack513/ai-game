/**
 * 单挑打榜：只邀请当前排行榜前十名与 1 位榜外挑战者（共 11 位），两两各打 1000 场。
 *
 *   npm run ladder -- --bot=<id>         # 前十 + 1 位挑战者，共 11 位（每对 1000 场）
 *   npm run ladder                       # 只复核当前前十名（10 位）
 *   npm run ladder -- --all              # 全部内置 bot（调试用，不用于打榜）
 *   node scripts/ladder.mjs --games=20   # 每对 20 场
 *   node scripts/ladder.mjs --json=work/ladder.json
 *
 * 第 10 名以后的 bot 不参与打榜。同一对局固定种子，并交替先后手；跑的是 js/ 里的编译产物。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BOTS } from '../js/bots/index.js';
import { runMatch } from '../js/engine/runner.js';

const args = process.argv.slice(2);
const readArg = (name) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const games = Number(readArg('games') ?? process.env.GAMES ?? 1000);
const seedBase = Number(readArg('seed-base') ?? process.env.SEED_BASE ?? 100_000);
const jsonOut = readArg('json') ?? process.env.JSON_OUT;
const botArg = readArg('bot') ?? process.env.BOT;
const runAll = args.includes('--all') || process.env.ALL === '1';

const label = (id) => BOTS.find((bot) => bot.id === id)?.name ?? id;

function fail(message) {
  console.error(message);
  process.exit(1);
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

let participants;
if (runAll) {
  participants = BOTS;
} else {
  const topBots = readTopNames(10).map((name, index) => {
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
    : [];
  if (new Set(challengers.map((bot) => bot.id)).size !== challengers.length) {
    fail('--bot 里有重复的选手');
  }
  if (challengers.length > 1) fail('打榜只邀请 1 位榜外挑战者');
  participants = [...topBots, ...challengers];
}

const rows = new Map(
  participants.map((bot) => [
    bot.id,
    { id: bot.id, wins: 0, draws: 0, losses: 0, games: 0, points: 0, vs: new Map() },
  ]),
);

let invalid = 0;
let crashes = 0;
const started = Date.now();

const pairs = [];
for (let i = 0; i < participants.length; i++) {
  for (let j = i + 1; j < participants.length; j++) pairs.push([i, j]);
}

console.log(
  `\n单挑打榜：${participants.length} 位选手 · ${pairs.length} 对 · 每对 ${games} 场（交替先后手）`,
);
console.log(` 参赛：${participants.map((bot) => bot.name).join('、')}`);
if (!runAll) {
  console.log(
    participants.length > 10
      ? ' 只有当前前十名与挑战者参与，第 10 名以后不进入打榜'
      : ' 只有当前前十名参与，第 10 名以后不进入打榜',
  );
}

let done = 0;
for (const [i, j] of pairs) {
  const a = participants[i];
  const b = participants[j];
  for (let game = 0; game < games; game++) {
    const first = game % 2 === 1 ? b : a;
    const second = game % 2 === 1 ? a : b;
    const seed = 1 + ((seedBase + i * 7_919 + j * 104_729 + game * 31) % 9_000_000);
    const result = runMatch({
      mode: 'duel',
      seed,
      botIds: [first.id, second.id],
      bots: [first.create(), second.create()],
      names: [first.name, second.name],
    });
    for (const stat of result.stats) {
      invalid += stat.invalidOrders;
      crashes += stat.crashes;
    }
    const seatA = first.id === a.id ? 0 : 1;
    const rowA = rows.get(a.id);
    const rowB = rows.get(b.id);
    rowA.games++;
    rowB.games++;
    let vsA = rowA.vs.get(b.id);
    if (!vsA) {
      vsA = { wins: 0, draws: 0, losses: 0 };
      rowA.vs.set(b.id, vsA);
    }
    let vsB = rowB.vs.get(a.id);
    if (!vsB) {
      vsB = { wins: 0, draws: 0, losses: 0 };
      rowB.vs.set(a.id, vsB);
    }
    if (result.winner === null) {
      rowA.draws++;
      rowB.draws++;
      rowA.points += 1;
      rowB.points += 1;
      vsA.draws++;
      vsB.draws++;
    } else if (result.winner === seatA) {
      rowA.wins++;
      rowB.losses++;
      rowA.points += 3;
      vsA.wins++;
      vsB.losses++;
    } else {
      rowB.wins++;
      rowA.losses++;
      rowB.points += 3;
      vsB.wins++;
      vsA.losses++;
    }
    done++;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`  ${label(a.id)} vs ${label(b.id)} 完成 · ${done}/${pairs.length * games} 局 · ${elapsed}s`);
}

const ranked = [...rows.values()].sort(
  (x, y) => y.points - x.points || y.wins - x.wins || x.losses - y.losses,
);

console.log('\n' + '─'.repeat(78));
console.log(' 排名  选手              场次    胜    平    负   胜率     积分');
ranked.forEach((row, index) => {
  const name = label(row.id);
  const width = [...name].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  const rate = ((row.wins / row.games) * 100).toFixed(1);
  console.log(
    ` ${String(index + 1).padStart(4)}  ${name}${' '.repeat(Math.max(0, 16 - width))}` +
      `  ${String(row.games).padStart(4)}  ${String(row.wins).padStart(4)}  ${String(row.draws).padStart(4)}` +
      `  ${String(row.losses).padStart(4)}  ${rate.padStart(5)}%  ${String(row.points).padStart(5)}` +
      (index === 9 ? '  ← 打榜线' : ''),
  );
});
console.log(
  `\n 非法指令 ${invalid} · 崩溃 ${crashes} · 总耗时 ${((Date.now() - started) / 1000).toFixed(0)}s`,
);

if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        gamesPerPair: games,
        mode: runAll ? 'all' : 'ranked',
        participants: participants.map((bot) => ({ id: bot.id, name: bot.name })),
        rankings: ranked.map((row) => ({
          ...row,
          name: label(row.id),
          vs: Object.fromEntries(row.vs),
        })),
      },
      null,
      2,
    ),
  );
  console.log(` 数据已写入 ${jsonOut}`);
}