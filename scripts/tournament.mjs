/**
 * 平衡性巡演：让内置 bot 两两对打 / 四人混战，打印胜率表。
 *
 *   node scripts/build.mjs && node scripts/tournament.mjs
 *   node scripts/tournament.mjs --seeds=10        # 每个对局换 10 个种子
 *   node scripts/tournament.mjs --duel            # 只跑单挑
 *   node scripts/tournament.mjs --ffa             # 只跑四人混战
 *
 * 注意：跑的是 js/ 里的编译产物，改完 src 记得先 node scripts/build.mjs。
 */

import { BOTS } from '../js/bots/index.js';
import { runMatch } from '../js/engine/runner.js';

const args = process.argv.slice(2);
const only = args.includes('--duel') ? 'duel' : args.includes('--ffa') ? 'ffa' : 'both';
const seeds = Number(args.find((arg) => arg.startsWith('--seeds='))?.split('=')[1] ?? 6);

/** @type {Map<string, { wins: number; games: number; draws: number }>} */
const table = new Map(BOTS.map((bot) => [bot.id, { wins: 0, games: 0, draws: 0 }]));
let invalid = 0;
let crashes = 0;
let think = 0;
let decisions = 0;

function record(ids, winner) {
  ids.forEach((id, seat) => {
    const row = table.get(id);
    row.games++;
    if (winner === null) row.draws++;
    else if (winner === seat) row.wins++;
  });
  for (const entry of ids) void entry;
}

function soak(result) {
  invalid += result.stats.reduce((sum, stat) => sum + stat.invalidOrders, 0);
  crashes += result.stats.reduce((sum, stat) => sum + stat.crashes, 0);
  for (const stat of result.stats) {
    think += stat.thinkMs.reduce((sum, ms) => sum + ms, 0);
    decisions += stat.thinkMs.length;
  }
}

const label = (id) => BOTS.find((bot) => bot.id === id)?.name ?? id;

// ---- 单挑：所有组合 ----
if (only !== 'ffa') {
  console.log(`\n单挑 · 每对 ${seeds} 个种子`);
  for (let i = 0; i < BOTS.length; i++) {
    for (let j = i + 1; j < BOTS.length; j++) {
      const a = BOTS[i];
      const b = BOTS[j];
      let score = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const result = runMatch({
          mode: 'duel',
          seed: seed * 17 + i * 101 + j * 761,
          botIds: [a.id, b.id],
          bots: [a.create(), b.create()],
          names: [a.name, b.name],
        });
        soak(result);
        if (result.winner === 0) score++;
        else if (result.winner === 1) score--;
        record([a.id, b.id], result.winner);
      }
      const left = Math.round((seeds + score) / 2);
      console.log(`  ${label(a.id).padEnd(4, '　')} vs ${label(b.id).padEnd(4, '　')}  ${left} : ${seeds - left}`);
    }
  }
}

// ---- 四人混战：轮换席位 ----
if (only !== 'duel') {
  console.log(`\n四人混战 · ${seeds} 个种子`);
  for (let seed = 1; seed <= seeds; seed++) {
    const rotated = [...BOTS.slice(seed % BOTS.length), ...BOTS.slice(0, seed % BOTS.length)];
    const result = runMatch({
      mode: 'ffa',
      seed: seed * 271 + 13,
      botIds: rotated.map((bot) => bot.id),
      bots: rotated.map((bot) => bot.create()),
      names: rotated.map((bot) => bot.name),
    });
    soak(result);
    if (result.winner === null) {
      rotated.forEach((bot) => record([bot.id], null));
      console.log('  平局 / 同归于尽');
    } else {
      record(
        rotated.map((bot) => bot.id),
        result.winner,
      );
      console.log(`  种子 ${seed}：${label(rotated[result.winner].id)} 获胜（${result.reason}）`);
    }
  }
}

// ---- 汇总 ----
const rows = [...table.entries()]
  .filter(([, row]) => row.games > 0)
  .sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games);

console.log('\n' + '─'.repeat(52));
console.log(' 选手      场次   胜    平   胜率');
for (const [id, row] of rows) {
  const rate = ((row.wins / row.games) * 100).toFixed(0).padStart(3);
  console.log(
    ` ${label(id).padEnd(4, '　')}  ${String(row.games).padStart(4)}  ${String(row.wins).padStart(3)}  ${String(row.draws).padStart(3)}   ${rate}%`,
  );
}
console.log(
  `\n 非法指令 ${invalid} · 崩溃 ${crashes} · 平均决策 ${(think / Math.max(1, decisions)).toFixed(2)}ms`,
);
