/**
 * 单挑天梯：所有内置 bot 两两对战，生成排行榜数据。
 *
 *   npm run ladder                       # 每对 100 场，共 5500 局
 *   node scripts/ladder.mjs --games=20   # 每对 20 场
 *   node scripts/ladder.mjs --json=work/ladder.json
 *
 * 同一对局固定种子，并交替先后手；跑的是 js/ 里的编译产物。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BOTS } from '../js/bots/index.js';
import { runMatch } from '../js/engine/runner.js';

const args = process.argv.slice(2);
const games = Number(
  args.find((arg) => arg.startsWith('--games='))?.split('=')[1] ?? process.env.GAMES ?? 100,
);
const seedBase = Number(
  args.find((arg) => arg.startsWith('--seed-base='))?.split('=')[1] ?? process.env.SEED_BASE ?? 100_000,
);
const jsonOut = args.find((arg) => arg.startsWith('--json='))?.split('=')[1] ?? process.env.JSON_OUT;

const label = (id) => BOTS.find((bot) => bot.id === id)?.name ?? id;

const rows = new Map(
  BOTS.map((bot) => [
    bot.id,
    { id: bot.id, wins: 0, draws: 0, losses: 0, games: 0, points: 0, vs: new Map() },
  ]),
);

let invalid = 0;
let crashes = 0;
const started = Date.now();

const pairs = [];
for (let i = 0; i < BOTS.length; i++) {
  for (let j = i + 1; j < BOTS.length; j++) pairs.push([i, j]);
}

console.log(
  `\n单挑天梯：${BOTS.length} 位选手 · ${pairs.length} 对 · 每对 ${games} 场（交替先后手）`,
);

let done = 0;
for (const [i, j] of pairs) {
  const a = BOTS[i];
  const b = BOTS[j];
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
      `  ${String(row.losses).padStart(4)}  ${rate.padStart(5)}%  ${String(row.points).padStart(5)}`,
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
      ranked.map((row) => ({ ...row, vs: Object.fromEntries(row.vs) })),
      null,
      2,
    ),
  );
  console.log(` 数据已写入 ${jsonOut}`);
}