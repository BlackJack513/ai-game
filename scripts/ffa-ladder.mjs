/**
 * 四人混战排行榜（FFA Ladder）：枚举参赛选手的全部四人组合，
 * 每个组合跑满 N 局混战（默认 100 局），按终局名次给梯度积分排出榜单，只保留前八名。
 *
 *   node scripts/build.mjs
 *   node scripts/ffa-ladder.mjs                     # 全体 bot，每桌 100 局
 *   node scripts/ffa-ladder.mjs --games=20          # 每桌场数
 *   node scripts/ffa-ladder.mjs --pool=pojun,kimik31pro,tianshu,ziwei,tide,viper
 *   node scripts/ffa-ladder.mjs --workers=8         # 并行进程数（默认 CPU-1）
 *   node scripts/ffa-ladder.mjs --json=work/ffa.json
 *
 * 名次分：第 1 名 3 分、第 2 名 2 分、第 3 名 1 分、第 4 名 0 分；
 * 判定并列第一（winner 为 null）时前两名各 2.5 分。
 * 每局桌内座位按 (组合序号 + 局数) 循环移位，消除出生位偏差。
 *
 * 注意：跑的是 js/ 里的编译产物，改完 src 记得先 node scripts/build.mjs。
 */

import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

import { BOTS } from '../js/bots/index.js';
import { runMatch } from '../js/engine/runner.js';

const SELF = fileURLToPath(import.meta.url);
const TABLE_POINTS = [3, 2, 1, 0];
const TIE_POINTS = [2.5, 2.5, 1, 0];
const KEEP = 8;
const KEEP_LABEL = '八';

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const gamesPerTable = Number(option('games') ?? 100);
const seedOffset = Number(option('offset') ?? 0);
const poolArg = option('pool');
const shardArg = option('shard');
const jsonPath = option('json');
const workerCount = option('workers') ? Number(option('workers')) : undefined;

if (!Number.isInteger(gamesPerTable) || gamesPerTable < 1) fail('--games 必须是正整数');
if (!Number.isFinite(seedOffset)) fail('--offset 必须是数字');

const poolIds = poolArg
  ? poolArg.split(',').map((id) => id.trim()).filter(Boolean)
  : BOTS.map((bot) => bot.id);
if (new Set(poolIds).size !== poolIds.length) fail('--pool 里有重复的选手');
if (poolIds.length < 4) fail('四人混战至少需要 4 名选手');

const pool = poolIds.map((id) => {
  const bot = BOTS.find((entry) => entry.id === id);
  if (!bot) fail(`未知选手：${id}（可选：${BOTS.map((entry) => entry.id).join(', ')}）`);
  return bot;
});

const label = (id) => pool.find((bot) => bot.id === id)?.name ?? id;

/** 按显示宽度（中日韩字符占 2 格）右侧补空格。 */
function pad(text, width) {
  const w = [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - w));
}

/** 枚举全部四人组合，附带组合序号（决定种子与座位轮换）。 */
function buildGroups(ids) {
  const groups = [];
  const pick = (start, chosen) => {
    if (chosen.length === 4) {
      groups.push(chosen.slice());
      return;
    }
    for (let i = start; i < ids.length; i++) {
      chosen.push(ids[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return groups.map((seated, index) => ({ index, seated }));
}

function emptyRow(id) {
  return { id, points: 0, games: 0, firsts: 0, ties: 0, rankSum: 0 };
}

function playGroups(groups) {
  const rows = new Map(pool.map((bot) => [bot.id, emptyRow(bot.id)]));
  let invalidOrders = 0;
  let crashes = 0;
  let thinkMsSum = 0;
  let thinkSamples = 0;
  let tieCount = 0;

  for (const { index, seated } of groups) {
    for (let game = 0; game < gamesPerTable; game++) {
      const shift = (index + game) % 4;
      const order = [...seated.slice(shift), ...seated.slice(0, shift)].map((id) =>
        pool.find((bot) => bot.id === id),
      );
      const seed = 1 + ((seedOffset + index * 977 + game * 271 + 13) % 9_000_000);
      const result = runMatch({
        mode: 'ffa',
        seed,
        botIds: order.map((bot) => bot.id),
        bots: order.map((bot) => bot.create()),
        names: order.map((bot) => bot.name),
      });

      for (const stat of result.stats) {
        invalidOrders += stat.invalidOrders;
        crashes += stat.crashes;
        for (const ms of stat.thinkMs) {
          thinkMsSum += ms;
          thinkSamples++;
        }
      }

      const tie = result.winner === null;
      if (tie) tieCount++;
      const pointsByRank = tie ? TIE_POINTS : TABLE_POINTS;

      result.ranking.forEach((seat, rank) => {
        const bot = order[seat];
        const row = rows.get(bot.id);
        row.points += pointsByRank[rank];
        row.games++;
        row.rankSum += rank + 1;
        if (tie && rank === 0) row.ties++;
        if (result.winner === seat) row.firsts++;
      });
    }
  }

  return {
    rows: [...rows.values()],
    tables: groups.length,
    invalidOrders,
    crashes,
    thinkMsSum,
    thinkSamples,
    tieCount,
  };
}

function mergeInto(target, source) {
  target.tables += source.tables;
  target.invalidOrders += source.invalidOrders;
  target.crashes += source.crashes;
  target.thinkMsSum += source.thinkMsSum;
  target.thinkSamples += source.thinkSamples;
  target.tieCount += source.tieCount;
  for (const row of source.rows) {
    const into = target.rows.get(row.id);
    into.points += row.points;
    into.games += row.games;
    into.firsts += row.firsts;
    into.ties += row.ties;
    into.rankSum += row.rankSum;
  }
}

function rankRows(rows) {
  return [...rows]
    .map((row) => ({
      ...row,
      averageRank: row.rankSum / Math.max(1, row.games),
      averagePoints: row.points / Math.max(1, row.games),
      firstRate: row.firsts / Math.max(1, row.games),
    }))
    .sort(
      (x, y) =>
        y.points - x.points ||
        x.averageRank - y.averageRank ||
        y.firsts / Math.max(1, y.games) - x.firsts / Math.max(1, x.games) ||
        y.games - x.games,
    );
}

// ---- 子进程分片模式 ----
const shardMatch = shardArg?.match(/^(\d+)\/(\d+)$/);
if (shardMatch) {
  const shardIndex = Number(shardMatch[1]);
  const shardTotal = Number(shardMatch[2]);
  const groups = buildGroups(pool.map((bot) => bot.id)).filter(
    (group) => group.index % shardTotal === shardIndex,
  );
  process.send(playGroups(groups), () => process.exit(0));
} else {
  runLadder();
}

function runLadder() {
  const totalTables = buildGroups(pool.map((bot) => bot.id)).length;
  const totalGames = totalTables * gamesPerTable;
  const workers = Math.max(1, Math.min(workerCount ?? cpus().length - 1, totalTables));
  const started = Date.now();

  console.log(`\n四人混战排行榜 · ${pool.length} 名选手 · ${totalTables} 桌 × 每桌 ${gamesPerTable} 局 = ${totalGames} 局`);
  console.log(`名次分：第 1 名 3 / 第 2 名 2 / 第 3 名 1 / 第 4 名 0（并列第一各 2.5 分）· 并行 ${workers} 进程\n`);

  const totals = {
    rows: new Map(pool.map((bot) => [bot.id, emptyRow(bot.id)])),
    tables: 0,
    invalidOrders: 0,
    crashes: 0,
    thinkMsSum: 0,
    thinkSamples: 0,
    tieCount: 0,
  };

  const childArgs = args.filter((arg) => !arg.startsWith('--shard=') && !arg.startsWith('--json='));
  const children = [];
  const finishedAt = [];

  const aggregate = (partial) => mergeInto(totals, partial);

  if (workers === 1) {
    aggregate(playGroups(buildGroups(pool.map((bot) => bot.id))));
  } else {
    for (let shardIndex = 0; shardIndex < workers; shardIndex++) {
      const shardStarted = Date.now();
      const child = fork(SELF, [...childArgs, `--shard=${shardIndex}/${workers}`], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      child.on('message', (partial) => {
        aggregate(partial);
        finishedAt.push(shardIndex);
        console.log(
          ` 分片 ${finishedAt.length}/${workers} 完成 · ${partial.tables} 桌 ${partial.tables * gamesPerTable} 局 · ${((Date.now() - shardStarted) / 1000).toFixed(0)}s`,
        );
      });
      child.on('error', (error) => fail(`子进程出错：${error.message}`));
      children.push(child);
    }
  }

  const waitForChildren = () =>
    Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            child.on('exit', (code) => resolve(code));
          }),
      ),
    );

  const printReport = () => {
    const elapsed = (Date.now() - started) / 1000;
    const ranked = rankRows([...totals.rows.values()]);

    console.log('\n' + '─'.repeat(92));
    console.log(' 四人混战排行榜（名次梯度积分，同分看平均名次 → 第一率）');
    console.log(
      ` ${pad('排名', 7)}${pad('选手', 18)}${pad('积分', 9)}${pad('场均分', 9)}${pad('第一', 7)}${pad('平均名次', 10)}${pad('出场', 8)}第一率`,
    );
    ranked.forEach((row, index) => {
      console.log(
        ` ${pad(`${index + 1}.`, 7)}${pad(label(row.id), 18)}${pad(row.points.toFixed(1), 9)}${pad(row.averagePoints.toFixed(3), 9)}${pad(String(row.firsts), 7)}${pad(row.averageRank.toFixed(2), 10)}${pad(String(row.games), 8)}${(row.firstRate * 100).toFixed(1)}%${index < KEEP ? `  ← 前${KEEP_LABEL}` : ''}`,
      );
    });

    console.log('\n' + '─'.repeat(92));
    console.log(
      ` 共 ${totals.tables} 桌 · ${totals.tables * gamesPerTable} 局 · 并列第一 ${totals.tieCount} 局 · 非法指令 ${totals.invalidOrders} · 崩溃 ${totals.crashes} · 平均决策 ${(totals.thinkMsSum / Math.max(1, totals.thinkSamples)).toFixed(2)}ms · 耗时 ${elapsed.toFixed(1)}s`,
    );

    if (jsonPath) {
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            gamesPerTable,
            seedOffset,
            pool: poolIds,
            keep: KEEP,
            tablePoints: TABLE_POINTS,
            tiePoints: TIE_POINTS,
            totals: {
              tables: totals.tables,
              games: totals.tables * gamesPerTable,
              ties: totals.tieCount,
              invalidOrders: totals.invalidOrders,
              crashes: totals.crashes,
            },
            rankings: ranked.map((row, index) => ({ rank: index + 1, name: label(row.id), ...row })),
          },
          null,
          2,
        ),
      );
      console.log(` 明细已写入 ${jsonPath}`);
    }
  };

  if (workers === 1) {
    printReport();
    return;
  }

  waitForChildren().then((codes) => {
    if (codes.some((code) => code !== 0)) fail('有分片异常退出，结果不完整');
    if (finishedAt.length !== workers) fail('有分片未回报结果，结果不完整');
    printReport();
  });
}