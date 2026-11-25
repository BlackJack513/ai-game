/**
 * 四人混战排行榜（FFA Ladder）。
 *
 * 默认「平衡轮转」赛制：全部选手都参与，每名选手打相同数量的四人桌，
 * 用贪心让任意两名选手的同场次数尽量接近，成本是 O(选手数 × 每人桌数)，
 * 而不是全组合的 C(n,4)。每桌打 N 局，按场均名次分排名，并用桌级
 * bootstrap 给出置信区间 —— 分差落在区间内的名次视为不可区分。
 *
 *   node scripts/build.mjs
 *   node scripts/ffa-ladder.mjs                          # 平衡轮转，每人 100 桌 × 每桌 20 局
 *   node scripts/ffa-ladder.mjs --tables=200             # 每人 200 桌
 *   node scripts/ffa-ladder.mjs --games=40               # 每桌 40 局（4 的倍数可走完座位整周期）
 *   node scripts/ffa-ladder.mjs --design=full --games=20 # 全组合复核，n=18 时 3060 桌
 *   node scripts/ffa-ladder.mjs --dry-run                # 只看分组均衡度，不跑对局
 *   node scripts/ffa-ladder.mjs --pool=pojun,kimik31pro,tianshu,ziwei,tide,viper
 *   node scripts/ffa-ladder.mjs --workers=8              # 并行进程数（默认 CPU-1）
 *   node scripts/ffa-ladder.mjs --json=work/ffa.json
 *
 * 名次分：第 1 名 3 分、第 2 名 2 分、第 3 名 1 分、第 4 名 0 分；
 * 判定并列第一（winner 为 null）时前两名各 2.5 分。
 * 每局桌内座位按 (桌序号 + 局数) 循环移位，消除出生位偏差。
 *
 * 注意：跑的是 js/ 里的编译产物，改完 src 记得先 node scripts/build.mjs。
 */

import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

import { BOTS } from '../js/bots/index.js';
import { runMatch } from '../js/engine/runner.js';
import { Rng, seedFrom } from '../js/engine/rng.js';

const SELF = fileURLToPath(import.meta.url);
const TABLE_POINTS = [3, 2, 1, 0];
const TIE_POINTS = [2.5, 2.5, 1, 0];
const DEFAULT_KEEP = 8;
const MAX_DESIGN_ATTEMPTS = 24;

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const design = option('design') ?? 'balanced';
if (design !== 'balanced' && design !== 'full') fail('--design 只能是 balanced 或 full');

const gamesPerTable = Number(option('games') ?? (design === 'full' ? 100 : 20));
const tablesPerBot = Number(option('tables') ?? 100);
const keepCount = Number(option('keep') ?? DEFAULT_KEEP);
const bootstrapRounds = Number(option('bootstrap') ?? 2000);
const confidence = Number(option('confidence') ?? 0.95);
const seedOffset = Number(option('offset') ?? 0);
const poolArg = option('pool');
const shardArg = option('shard');
const jsonPath = option('json');
const workerCount = option('workers') ? Number(option('workers')) : undefined;
const dryRun = args.includes('--dry-run');

if (!Number.isInteger(gamesPerTable) || gamesPerTable < 1) fail('--games 必须是正整数');
if (design === 'balanced' && (!Number.isInteger(tablesPerBot) || tablesPerBot < 1)) {
  fail('--tables 必须是正整数（每名选手的出场桌数）');
}
if (!Number.isInteger(keepCount) || keepCount < 1) fail('--keep 必须是正整数');
if (!Number.isInteger(bootstrapRounds) || bootstrapRounds < 0) fail('--bootstrap 必须是非负整数');
if (!(confidence > 0 && confidence < 1)) fail('--confidence 必须在 0 和 1 之间');
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

const poolIndex = new Map(pool.map((bot, index) => [bot.id, index]));
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

/**
 * 平衡轮转：每桌优先挑出场次数最少的选手，并在这批人里挑「与同桌已选
 * 选手同场次数最少」的组合，使任意两人的同场次数尽量均匀。
 */
function buildBalancedAttempt(ids, totalTables, seed) {
  const n = ids.length;
  const rng = new Rng(seedFrom('ffa-balanced', seedOffset, seed, n, totalTables));
  const tieBreak = rng.shuffle(ids.map((_, index) => index));
  const played = new Array(n).fill(0);
  const pair = Array.from({ length: n }, () => new Array(n).fill(0));
  const tables = [];

  while (tables.length < totalTables) {
    const chosen = [];
    const pairLoad = new Array(n).fill(0);

    while (chosen.length < 4) {
      let best = -1;
      if (chosen.length === 0) {
        const fewest = Math.min(...played);
        const candidates = [];
        for (let i = 0; i < n; i++) if (played[i] === fewest) candidates.push(i);
        best = candidates[rng.int(candidates.length)];
        chosen.push(best);
        for (let i = 0; i < n; i++) {
          if (!chosen.includes(i)) pairLoad[i] += pair[best][i];
        }
        continue;
      }
      for (let i = 0; i < n; i++) {
        if (chosen.includes(i)) continue;
        if (best < 0) {
          best = i;
          continue;
        }
        if (played[i] !== played[best]) {
          if (played[i] < played[best]) best = i;
        } else if (pairLoad[i] !== pairLoad[best]) {
          if (pairLoad[i] < pairLoad[best]) best = i;
        } else if (tieBreak[i] < tieBreak[best]) {
          best = i;
        }
      }
      chosen.push(best);
      for (let i = 0; i < n; i++) {
        if (!chosen.includes(i)) pairLoad[i] += pair[best][i];
      }
    }

    for (const i of chosen) played[i]++;
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        pair[chosen[a]][chosen[b]]++;
        pair[chosen[b]][chosen[a]]++;
      }
    }
    tables.push({ index: tables.length, seated: chosen.map((i) => ids[i]) });
  }

  return tables;
}

/** 同场次数越均匀、出场次数越平均，代价越小。 */
function balanceCost(tables, ids) {
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));
  const pair = Array.from({ length: n }, () => new Array(n).fill(0));
  const played = new Array(n).fill(0);
  for (const { seated } of tables) {
    const seats = seated.map((id) => index.get(id));
    for (const i of seats) played[i]++;
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        pair[seats[a]][seats[b]]++;
        pair[seats[b]][seats[a]]++;
      }
    }
  }

  let sum = 0;
  let square = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += pair[i][j];
      square += pair[i][j] * pair[i][j];
      count++;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, square / count - mean * mean) : 0;
  const playSpan = Math.max(...played) - Math.min(...played);
  return playSpan * 1e6 + variance;
}

/** 多起点贪心，取同场分布最均匀的一组分组。 */
function buildBalancedTables(ids, perBot) {
  const totalTables = Math.max(1, Math.round((ids.length * perBot) / 4));
  let best = null;
  let bestCost = Infinity;
  for (let attempt = 0; attempt < MAX_DESIGN_ATTEMPTS; attempt++) {
    const tables = buildBalancedAttempt(ids, totalTables, attempt);
    const cost = balanceCost(tables, ids);
    if (cost < bestCost) {
      bestCost = cost;
      best = tables;
    }
  }
  return best;
}

function buildTables() {
  const ids = pool.map((bot) => bot.id);
  return design === 'full' ? buildGroups(ids) : buildBalancedTables(ids, tablesPerBot);
}

function balanceStats(tables) {
  const n = pool.length;
  const pair = Array.from({ length: n }, () => new Array(n).fill(0));
  const played = new Array(n).fill(0);
  for (const { seated } of tables) {
    const seats = seated.map((id) => poolIndex.get(id));
    for (const i of seats) played[i]++;
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        pair[seats[a]][seats[b]]++;
        pair[seats[b]][seats[a]]++;
      }
    }
  }

  let minPairs = Infinity;
  let maxPairs = -Infinity;
  let pairSum = 0;
  let pairSquare = 0;
  let pairCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const value = pair[i][j];
      minPairs = Math.min(minPairs, value);
      maxPairs = Math.max(maxPairs, value);
      pairSum += value;
      pairSquare += value * value;
      pairCount++;
    }
  }
  const meanPairs = pairCount > 0 ? pairSum / pairCount : 0;
  const pairStdDev =
    pairCount > 0 ? Math.sqrt(Math.max(0, pairSquare / pairCount - meanPairs * meanPairs)) : 0;

  return {
    minPairs,
    maxPairs,
    meanPairs,
    pairStdDev,
    minPlayed: Math.min(...played),
    maxPlayed: Math.max(...played),
    tables: tables.length,
    gamesPerTable,
    gamesPerBot: Math.min(...played) * gamesPerTable,
  };
}

function emptyRow(id) {
  return { id, points: 0, games: 0, firsts: 0, ties: 0, rankSum: 0 };
}

function playTables(tables) {
  const rows = new Map(pool.map((bot) => [bot.id, emptyRow(bot.id)]));
  const tableScores = [];
  let invalidOrders = 0;
  let crashes = 0;
  let thinkMsSum = 0;
  let thinkSamples = 0;
  let tieCount = 0;

  for (const { index, seated } of tables) {
    const seats = seated.map((id) => poolIndex.get(id));
    const sums = new Map();

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
        const points = pointsByRank[rank];
        row.points += points;
        row.games++;
        row.rankSum += rank + 1;
        if (tie && rank === 0) row.ties++;
        if (result.winner === seat) row.firsts++;
        sums.set(bot.id, (sums.get(bot.id) ?? 0) + points);
      });
    }

    tableScores.push({
      index,
      players: seats,
      scores: seated.map((id) => (sums.get(id) ?? 0) / gamesPerTable),
    });
  }

  return {
    rows: [...rows.values()],
    tableScores,
    tables: tables.length,
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
  target.tableScores.push(...source.tableScores);
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
        y.averagePoints - x.averagePoints ||
        x.averageRank - y.averageRank ||
        y.firstRate - x.firstRate ||
        y.games - x.games,
    );
}

function quantile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** 桌级 bootstrap：桌是独立采样单元，局只是桌内的重复测量。 */
function bootstrapIntervals(tableScores) {
  const n = pool.length;
  const rounds = bootstrapRounds;
  if (rounds < 2 || tableScores.length === 0) {
    return pool.map(() => [Number.NaN, Number.NaN]);
  }

  const rng = new Rng(seedFrom('ffa-bootstrap', seedOffset, tableScores.length, rounds));
  const draws = Array.from({ length: n }, () => new Float64Array(rounds));
  const total = new Float64Array(n);
  const count = new Uint32Array(n);
  const tableCount = tableScores.length;

  for (let round = 0; round < rounds; round++) {
    total.fill(0);
    count.fill(0);
    for (let t = 0; t < tableCount; t++) {
      const table = tableScores[rng.int(tableCount)];
      for (let k = 0; k < table.players.length; k++) {
        const index = table.players[k];
        total[index] += table.scores[k];
        count[index]++;
      }
    }
    for (let i = 0; i < n; i++) {
      draws[i][round] = count[i] > 0 ? total[i] / count[i] : 0;
    }
  }

  const alpha = (1 - confidence) / 2;
  return draws.map((draw) => {
    const sorted = Array.from(draw).sort((x, y) => x - y);
    return [quantile(sorted, alpha), quantile(sorted, 1 - alpha)];
  });
}

function printDesign(allTables) {
  const stats = balanceStats(allTables);
  const gamesTotal = stats.tables * gamesPerTable;
  const perBotText =
    stats.minPlayed === stats.maxPlayed
      ? `${stats.minPlayed} 桌（${stats.gamesPerBot} 局）`
      : `${stats.minPlayed}–${stats.maxPlayed} 桌`;
  console.log(`\n四人混战排行榜 · ${design === 'full' ? '全组合' : '平衡轮转'} · ${pool.length} 名选手`);
  console.log(
    ` ${stats.tables} 桌 × 每桌 ${gamesPerTable} 局 = ${gamesTotal} 局 · 每人约 ${perBotText}`,
  );
  console.log(
    ` 同场均衡：任意两名选手同场 ${stats.minPairs === stats.maxPairs ? stats.minPairs : `${stats.minPairs}–${stats.maxPairs}`} 次（均值 ${stats.meanPairs.toFixed(2)}，σ ${stats.pairStdDev.toFixed(2)}）`,
  );
  console.log(` 名次分：第 1 名 3 / 第 2 名 2 / 第 3 名 1 / 第 4 名 0（并列第一各 2.5 分）`);
  console.log(
    ` 排名口径：场均分 → 平均名次 → 第一率 · 桌级 bootstrap ${bootstrapRounds} 次（${(confidence * 100).toFixed(0)}% 区间）\n`,
  );
  if (dryRun) {
    console.log(' 前 5 桌预览：');
    for (const table of allTables.slice(0, 5)) {
      console.log(`  ${String(table.index + 1).padStart(3)}. ${table.seated.map(label).join(' · ')}`);
    }
    console.log('\n--dry-run 只检查分组，不跑对局。\n');
  }
}

// ---- 子进程分片模式 ----
const allTables = buildTables();
const shardMatch = shardArg?.match(/^(\d+)\/(\d+)$/);
if (shardMatch) {
  const shardIndex = Number(shardMatch[1]);
  const shardTotal = Number(shardMatch[2]);
  const tables = allTables.filter((table) => table.index % shardTotal === shardIndex);
  process.send(playTables(tables), () => process.exit(0));
} else {
  runLadder(allTables);
}

function runLadder(tables) {
  const totalTables = tables.length;
  const workers = Math.max(1, Math.min(workerCount ?? cpus().length - 1, totalTables));
  const started = Date.now();

  printDesign(tables);

  if (dryRun) return;

  const totals = {
    rows: new Map(pool.map((bot) => [bot.id, emptyRow(bot.id)])),
    tableScores: [],
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
    aggregate(playTables(tables));
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
    // 分片完成顺序不固定，先按桌序号排序，保证 bootstrap 结果可复现
    const orderedScores = [...totals.tableScores].sort((x, y) => x.index - y.index);
    const intervals = bootstrapIntervals(orderedScores);

    console.log('\n' + '─'.repeat(104));
    console.log(' 四人混战排行榜（全员平衡轮转 · 场均名次分 · 桌级 bootstrap 区间）');
    console.log(
      ` ${pad('排名', 7)}${pad('选手', 18)}${pad('场均分', 9)}${pad('区间', 20)}${pad('总积分', 10)}${pad('第一率', 8)}${pad('平均名次', 10)}出场桌`,
    );
    ranked.forEach((row, index) => {
      const [low, high] = intervals[poolIndex.get(row.id)];
      const next = ranked[index + 1];
      const [nextLow, nextHigh] =
        next !== undefined ? intervals[poolIndex.get(next.id)] : [Number.NaN, Number.NaN];
      const overlapNext =
        Number.isFinite(low) &&
        Number.isFinite(high) &&
        Number.isFinite(nextLow) &&
        Number.isFinite(nextHigh) &&
        high >= nextLow &&
        low <= nextHigh;
      const marker = overlapNext ? ' ≈' : '';
      const intervalText = Number.isFinite(low) ? `[${low.toFixed(2)}, ${high.toFixed(2)}]` : '—';
      console.log(
        ` ${pad(`${index + 1}.${marker}`, 7)}${pad(label(row.id), 18)}${pad(row.averagePoints.toFixed(3), 9)}${pad(intervalText, 20)}${pad(row.points.toFixed(1), 10)}${pad(`${(row.firstRate * 100).toFixed(1)}%`, 8)}${pad(row.averageRank.toFixed(2), 10)}${row.games}${index < keepCount ? '  ← 前八' : ''}`,
      );
    });

    const stats = balanceStats(tables);
    console.log('\n' + '─'.repeat(104));
    console.log(
      ` 共 ${totals.tables} 桌 · ${totals.tables * gamesPerTable} 局 · 并列第一 ${totals.tieCount} 局 · 非法指令 ${totals.invalidOrders} · 崩溃 ${totals.crashes} · 平均决策 ${(totals.thinkMsSum / Math.max(1, totals.thinkSamples)).toFixed(2)}ms · 耗时 ${elapsed.toFixed(1)}s`,
    );
    console.log(
      ` 同场 ${stats.minPairs === stats.maxPairs ? stats.minPairs : `${stats.minPairs}–${stats.maxPairs}`} 次/对（均值 ${stats.meanPairs.toFixed(2)}，σ ${stats.pairStdDev.toFixed(2)}）· 每人 ${stats.minPlayed === stats.maxPlayed ? stats.minPlayed : `${stats.minPlayed}–${stats.maxPlayed}`} 桌 · ≈ 表示与下一名的区间重叠`,
    );

    if (jsonPath) {
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            design,
            gamesPerTable,
            tablesPerBot: design === 'balanced' ? tablesPerBot : null,
            seedOffset,
            pool: poolIds,
            keep: keepCount,
            tablePoints: TABLE_POINTS,
            tiePoints: TIE_POINTS,
            confidence,
            bootstrapRounds,
            balance: stats,
            totals: {
              tables: totals.tables,
              games: totals.tables * gamesPerTable,
              ties: totals.tieCount,
              invalidOrders: totals.invalidOrders,
              crashes: totals.crashes,
            },
            rankings: ranked.map((row, index) => {
              const [low, high] = intervals[poolIndex.get(row.id)];
              return {
                rank: index + 1,
                name: label(row.id),
                ...row,
                intervalLow: Number.isFinite(low) ? low : null,
                intervalHigh: Number.isFinite(high) ? high : null,
              };
            }),
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
