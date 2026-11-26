/**
 * 星流 Starflow —— 浏览器观战应用。
 *
 * 纯前端：开局 → 引擎跑完整局（同步，几十毫秒）→ 逐帧回放。
 * 因此暂停、单步、拖动进度条都只是「换一帧来画」。
 */

import { BOTS, botEntry, createBot } from './bots/index.js';
import { Match, runMatch, type Frame, type MatchResult } from './engine/runner.js';
import { computeVision, productionForKind } from './engine/sim.js';
import { KIND_LABEL, MODE_LABEL, RULES, type Bot, type GameEvent, type Mode, type NodeKind } from './engine/types.js';
import { HumanPlan } from './ui/human.js';
import { BoardRenderer } from './ui/render.js';

const STORAGE_KEY = 'starflow.settings.v1';
const PLAYER_COLORS = ['#38bdf8', '#fb7185', '#fbbf24', '#a78bfa'];
/** 1× 时每回合一帧的展示时长 */
const BASE_TURN_MS = 900;
const SPEEDS = [0.5, 1, 2, 4];

type Seat = 'watch' | 'human';

interface Settings {
  mode: Mode;
  seat: Seat;
  seed: number;
  slots: string[];
  fog: boolean;
  speed: number;
}

const DEFAULTS: Settings = {
  mode: 'duel',
  seat: 'watch',
  seed: 2049,
  slots: ['tide', 'viper', 'turtle', 'rookie'],
  fog: false,
  speed: 1,
};

function defaultSettings(): Settings {
  return { ...DEFAULTS, slots: ['tide', 'viper', 'turtle', 'tide'] };
}

function loadSettings(): Settings {
  const fallback = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const mode: Mode = parsed.mode === 'ffa' ? 'ffa' : 'duel';
    const seat: Seat = parsed.seat === 'human' ? 'human' : 'watch';
    const slots = Array.isArray(parsed.slots) ? parsed.slots.filter((id): id is string => typeof id === 'string') : [];
    return {
      mode,
      seat,
      seed: typeof parsed.seed === 'number' && Number.isFinite(parsed.seed) ? Math.trunc(parsed.seed) : fallback.seed,
      slots: slots.length >= 4 ? slots.slice(0, 4) : fallback.slots,
      fog: Boolean(parsed.fog),
      speed: SPEEDS.includes(parsed.speed as number) ? (parsed.speed as number) : 1,
    };
  } catch {
    return fallback;
  }
}

const settings: Settings = loadSettings();

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式下忽略 */
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少元素 #${id}`);
  return node as T;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

// ---------------------------------------------------------------------------
// 元素
// ---------------------------------------------------------------------------

const canvas = el<HTMLCanvasElement>('board');
const renderer = new BoardRenderer(canvas);
const slotsEl = el<HTMLDivElement>('slots');
const seedInput = el<HTMLInputElement>('seed');
const fogInput = el<HTMLInputElement>('fog');
const scrub = el<HTMLInputElement>('scrub');
const logEl = el<HTMLDivElement>('log');
const scoreEl = el<HTMLDivElement>('score');
const banner = el<HTMLDivElement>('banner');
const tooltip = el<HTMLDivElement>('tooltip');
const stageEmpty = el<HTMLDivElement>('stage-empty');
const playButton = el<HTMLButtonElement>('btn-play');
const commandEl = el<HTMLDivElement>('command');
const commandBar = el<HTMLDivElement>('command-bar');
const orderCount = el<HTMLSpanElement>('order-count');
const cmdHint = el<HTMLParagraphElement>('cmd-hint');
const cmdTroopsRow = el<HTMLDivElement>('cmd-troops-row');
const cmdTroops = el<HTMLInputElement>('cmd-troops');
const confirmOrderButton = el<HTMLButtonElement>('btn-confirm-order');
const cmdList = el<HTMLUListElement>('cmd-list');
const cmdWarn = el<HTMLDivElement>('cmd-warn');
const cmdSummary = el<HTMLDivElement>('cmd-summary');
const endTurnButton = el<HTMLButtonElement>('btn-end-turn');

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let match: MatchResult | null = null;
let frameIndex = 0;
let progress = 0;
let playing = false;
let hover: number | null = null;
let lastTime = performance.now();
/** 真人对局：非空表示当前这局由玩家 0 亲自下令。 */
let live: Match | null = null;
let plan: HumanPlan | null = null;
let targetsCache: number[] = [];

interface ScoreRow {
  row: HTMLElement;
  stats: HTMLElement;
  bar: HTMLElement;
}

let scoreRows: ScoreRow[] = [];

const logState = { upto: 0, empty: true };

function slotCount(): number {
  return settings.mode === 'duel' ? 2 : 4;
}

function currentSlots(): string[] {
  return settings.slots.slice(0, slotCount());
}

function isHumanMatch(): boolean {
  return live !== null;
}

function fogEnabled(): boolean {
  return isHumanMatch() || settings.fog;
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

function renderSlots(): void {
  slotsEl.innerHTML = '';
  const count = slotCount();
  for (let index = 0; index < count; index += 1) {
    const slot = document.createElement('div');
    slot.className = 'slot';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = PLAYER_COLORS[index];
    dot.style.color = PLAYER_COLORS[index];

    // 真人出战：1 号位固定是玩家自己，不参与 AI 选择
    if (settings.seat === 'human' && index === 0) {
      slot.classList.add('me');
      const name = document.createElement('span');
      name.className = 'slot-name';
      name.textContent = '你';
      const style = document.createElement('span');
      style.className = 'slot-style';
      style.textContent = '真人玩家 · 战争迷雾视角';
      slot.append(dot, name, style);
      slotsEl.append(slot);
      continue;
    }

    const select = document.createElement('select');
    select.setAttribute('aria-label', `玩家 ${index + 1} 的 AI`);
    for (const entry of BOTS) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name;
      select.append(option);
    }

    const current = settings.slots[index] ?? BOTS[index % BOTS.length].id;
    if (!BOTS.some((entry) => entry.id === current)) {
      settings.slots[index] = BOTS[index % BOTS.length].id;
    }
    select.value = settings.slots[index] ?? current;

    const style = document.createElement('span');
    style.className = 'slot-style';
    const refresh = (): void => {
      const entry = botEntry(select.value);
      style.textContent = `玩家 ${index + 1} · ${entry ? entry.style : '未知 AI'}`;
    };
    refresh();

    select.addEventListener('change', () => {
      settings.slots[index] = select.value;
      refresh();
      saveSettings();
    });

    slot.append(dot, select, style);
    slotsEl.append(slot);
  }
}

function syncModeButtons(): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#mode-seg button'))) {
    button.classList.toggle('on', button.dataset.mode === settings.mode);
  }
}

function syncSpeedButtons(): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#speeds button'))) {
    button.classList.toggle('on', Number(button.dataset.speed) === settings.speed);
  }
}

function syncSeatUi(): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#seat-seg button'))) {
    button.classList.toggle('on', button.dataset.seat === settings.seat);
  }
  const human = settings.seat === 'human';
  fogInput.checked = human ? true : settings.fog;
  fogInput.disabled = human;
  el('fog-hint').textContent = human ? '以你的视角作战，视野外兵力未知' : '以玩家 1 的视角观战';
  el<HTMLButtonElement>('btn-start').textContent = human ? '开始挑战' : '开始对战';
}

// ---------------------------------------------------------------------------
// 开局
// ---------------------------------------------------------------------------

function namesFor(ids: string[]): string[] {
  return ids.map((id, index) => {
    const entry = botEntry(id);
    const base = entry ? entry.name : id;
    const total = ids.filter((other) => other === id).length;
    if (total <= 1) return base;
    const nth = ids.slice(0, index).filter((other) => other === id).length + 1;
    return `${base} ${nth}`;
  });
}

function prepareStage(): void {
  frameIndex = 0;
  progress = 0;
  hover = null;
  logState.upto = 0;
  logState.empty = true;
  logEl.innerHTML = '';
  tooltip.hidden = true;
  stageEmpty.classList.add('hidden');
  banner.hidden = true;

  scrub.max = String(Math.max(0, (match?.frames.length ?? 1) - 1));
  scrub.value = '0';

  if (!match) return;
  el('hud-mode').textContent = isHumanMatch() ? `你 · ${MODE_LABEL[match.mode]}` : MODE_LABEL[match.mode];
  el('hud-seed').textContent = `种子 ${match.seed}`;
  el('side-seed').textContent = `种子 ${match.seed}`;

  buildScoreboard();
}

function startMatch(): void {
  const ids = currentSlots();

  if (settings.seat === 'human') {
    startHumanMatch(ids);
    return;
  }

  live = null;
  plan = null;
  targetsCache = [];
  const bots = ids.map((id) => createBot(id) ?? { name: '挂机', decide: () => [] });
  match = runMatch({ mode: settings.mode, seed: settings.seed, botIds: ids, bots, names: namesFor(ids) });

  prepareStage();
  syncFrame();
  setPlaying(true);
}

/** 真人挑战：玩家 0 亲自下令，其余位置照旧是榜单 AI。 */
function startHumanMatch(ids: string[]): void {
  const humanBot: Bot = { name: '你', decide: () => [] };
  const botIds = ['human', ...ids.slice(1)];
  const bots = botIds.map((id, index) => {
    if (index === 0) return humanBot;
    return createBot(id) ?? { name: '挂机', decide: () => [] };
  });
  const names = namesFor(botIds);
  names[0] = '你';

  live = new Match({
    mode: settings.mode,
    seed: settings.seed,
    botIds,
    bots,
    names,
  });
  match = live.result();
  plan = new HumanPlan(live.state);
  targetsCache = [];

  prepareStage();
  syncFrame();
  setPlaying(false);
  syncCommandUi();
}

// ---------------------------------------------------------------------------
// 记分板
// ---------------------------------------------------------------------------

function buildScoreboard(): void {
  scoreEl.innerHTML = '';
  scoreRows = [];
  if (!match) return;
  const frame = match.frames[0];
  for (const player of frame.players) {
    const row = document.createElement('div');
    row.className = 'prow';
    row.style.color = PLAYER_COLORS[player.id];

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = PLAYER_COLORS[player.id];
    dot.style.color = PLAYER_COLORS[player.id];

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = player.name;
    name.style.color = '#e2e8f0';

    const stats = document.createElement('span');
    stats.className = 'pmeta';

    const bar = document.createElement('span');
    bar.className = 'pbar';
    const fill = document.createElement('i');
    fill.style.width = '0%';
    bar.append(fill);

    row.append(dot, name, stats, bar);
    scoreEl.append(row);
    scoreRows.push({ row, stats, bar });
  }
}

function updateScoreboard(frame: Frame): void {
  const maxTroops = Math.max(1, ...frame.players.map((player) => player.troops));
  let leader = -1;
  for (const player of frame.players) {
    if (!player.alive) continue;
    if (leader < 0) {
      leader = player.id;
      continue;
    }
    const best = frame.players[leader];
    if (player.nodes > best.nodes || (player.nodes === best.nodes && player.troops > best.troops)) {
      leader = player.id;
    }
  }

  frame.players.forEach((player, index) => {
    const row = scoreRows[index];
    if (!row) return;
    row.row.classList.toggle('lead', player.id === leader && player.alive);
    row.row.classList.toggle('dead', !player.alive);
    row.stats.textContent = player.alive
      ? `节点 ${player.nodes} · 产出 +${player.production} · 兵力 ${player.troops}`
      : `已淘汰 · 第 ${player.eliminatedTurn ?? '?'} 回合`;
    const fill = row.bar.firstElementChild as HTMLElement | null;
    if (fill) fill.style.width = `${Math.round((player.troops / maxTroops) * 100)}%`;
  });
}

// ---------------------------------------------------------------------------
// 战报
// ---------------------------------------------------------------------------

function describeEvent(event: GameEvent): { color: string; html: string; cls: string } {
  const nameOf = (id: number): string => (match && id >= 0 && id < match.names.length ? match.names[id] : '中立');
  const colorOf = (id: number): string => (id >= 0 ? PLAYER_COLORS[id] ?? '#94a3b8' : '#64748b');

  switch (event.type) {
    case 'capture': {
      const kind: NodeKind = match ? match.map.nodes[event.node].kind : 'farm';
      const from = event.from >= 0 ? `自 ${nameOf(event.from)}` : '中立';
      return {
        color: colorOf(event.to),
        html: `<b>${escapeHtml(nameOf(event.to))}</b> 攻占 ${KIND_LABEL[kind]} #${event.node} <span class="muted">（${escapeHtml(from)}）</span>`,
        cls: 'cap',
      };
    }
    case 'eliminated':
      return {
        color: colorOf(event.player),
        html: `<b>${escapeHtml(nameOf(event.player))}</b> 被淘汰`,
        cls: 'hot',
      };
    case 'invalid':
      return {
        color: colorOf(event.player),
        html: `<b>${escapeHtml(nameOf(event.player))}</b> 指令被驳回：${escapeHtml(event.reason)}`,
        cls: '',
      };
    case 'wave':
      return {
        color: colorOf(event.player),
        html: `<b>${escapeHtml(nameOf(event.player))}</b> 派出 ${event.troops} 兵 → #${event.to}`,
        cls: '',
      };
    default:
      return { color: '#94a3b8', html: '', cls: '' };
  }
}

function appendEvents(frames: Frame[]): void {
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  let appended = false;

  for (const frame of frames) {
    for (const event of frame.events) {
      const info = describeEvent(event);
      if (!info.html) continue;
      const item = document.createElement('div');
      item.className = `log-item ${info.cls}`.trim();
      item.innerHTML =
        `<span class="lturn">T${event.turn}</span>` +
        `<span class="ldot" style="background:${info.color};color:${info.color}"></span>` +
        `<span>${info.html}</span>`;
      logEl.append(item);
      appended = true;
    }
  }

  if (!appended) return;
  if (logState.empty) {
    logState.empty = false;
  }
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function syncLog(rebuild: boolean): void {
  if (!match) return;
  if (rebuild || frameIndex < logState.upto) {
    logEl.innerHTML = '';
    logState.upto = 0;
    logState.empty = true;
    appendEvents(match.frames.slice(1, frameIndex + 1));
    logState.upto = frameIndex;
    logEl.scrollTop = logEl.scrollHeight;
    return;
  }
  if (frameIndex > logState.upto) {
    appendEvents(match.frames.slice(logState.upto + 1, frameIndex + 1));
    logState.upto = frameIndex;
  }
}

// ---------------------------------------------------------------------------
// 真人指挥
// ---------------------------------------------------------------------------

function nodeLabel(id: number): string {
  if (!match) return `#${id}`;
  const node = match.map.nodes[id];
  return node ? `${KIND_LABEL[node.kind]} #${id}` : `#${id}`;
}

function setWarn(text: string): void {
  cmdWarn.textContent = text;
}

function syncCommandUi(): void {
  const human = isHumanMatch();
  el('transport').hidden = human;
  el('scrub-wrap').hidden = human;
  el('turn-label').hidden = human;
  el('speeds').hidden = human;
  commandBar.hidden = !human;
  commandEl.hidden = !human;

  if (!human || !live || !match || !plan) {
    endTurnButton.disabled = true;
    return;
  }

  const current = live;
  const frame = match.frames[frameIndex];
  const me = frame.players[0];
  const alive = current.state.players[0].alive;
  const finished = current.finished;
  const selected = plan.selected;
  const pending = plan.pending;

  orderCount.textContent = `${plan.orders.length} / ${plan.maxOrders}`;
  cmdSummary.textContent =
    `第 ${frame.turn} 回合 · 你的节点 ${me?.nodes ?? 0} · 兵力 ${me?.troops ?? 0} · 产出 +${me?.production ?? 0}` +
    ` · 指令 ${plan.orders.length}/${plan.maxOrders}`;

  endTurnButton.disabled = finished;
  endTurnButton.textContent = alive ? '结束回合' : '快进到结局';

  cmdList.innerHTML = '';
  if (!alive || finished) {
    if (!alive) orderCount.textContent = '—';
    cmdHint.textContent = alive ? '对局结束。' : '你已被淘汰，点击「快进到结局」直接看完剩余对局。';
    cmdTroopsRow.hidden = true;
    const item = document.createElement('li');
    item.className = 'cmd-empty';
    item.textContent = alive ? '本局已经结束。' : '本局已无可用指令。';
    cmdList.append(item);
    return;
  }

  if (pending) {
    const from = pending.from;
    const available = plan.availableAt(from);
    cmdHint.textContent =
      `起点：${nodeLabel(from)} → 目标：${nodeLabel(pending.to)} · 可用 ${available} 兵。` +
      '输入派出兵力，回车确认（Esc 取消）。';
  } else if (selected === null) {
    cmdHint.textContent = '点击你的节点选择出兵起点。';
  } else {
    const node = match.map.nodes[selected];
    const kind = node ? KIND_LABEL[node.kind] : '节点';
    cmdHint.textContent =
      `起点：${kind} #${selected} · 可用 ${plan.availableAt(selected)} 兵。` + '点击目标节点派兵（Esc 取消）。';
  }

  cmdTroopsRow.hidden = pending === null;
  if (pending) {
    const available = plan.availableAt(pending.from);
    const parsed = Number.parseInt(cmdTroops.value, 10);
    if (!Number.isFinite(parsed) || parsed > available || parsed < 1) {
      cmdTroops.value = String(Math.max(1, available));
    }
    cmdTroops.max = String(Math.max(1, available));
    cmdTroops.disabled = available < 1;
    el<HTMLButtonElement>('btn-max').disabled = available < 1;
    confirmOrderButton.disabled = available < 1;
  }

  if (plan.orders.length === 0) {
    const item = document.createElement('li');
    item.className = 'cmd-empty';
    item.textContent = '本回合还没有出兵令。';
    cmdList.append(item);
    return;
  }

  plan.orders.forEach((order, index) => {
    const item = document.createElement('li');
    item.className = 'cmd-item';
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = `${nodeLabel(order.from)} → ${nodeLabel(order.to)} · ${order.troops} 兵`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = '撤销这条指令';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      plan?.remove(index);
      targetsCache = plan?.targets() ?? [];
      setWarn('');
      syncCommandUi();
    });
    item.append(label, remove);
    cmdList.append(item);
  });
}

function syncHumanFrame(rebuildLog = false): void {
  if (!match || !live) return;
  frameIndex = match.frames.length - 1;
  progress = 0;
  scrub.max = String(Math.max(0, match.frames.length - 1));
  syncFrame(rebuildLog);
}

/** 提交本回合指令，与所有 AI 同时结算，生成下一帧。 */
function endTurn(): void {
  const current = live;
  if (!current || !plan || !match || current.finished) return;

  // 已选好起终点、还没来得及按回车的指令，按输入框当前兵力一并提交
  if (plan.pending) {
    const available = plan.availableAt(plan.pending.from);
    const parsed = Number.parseInt(cmdTroops.value, 10);
    const result = plan.commit(Number.isFinite(parsed) ? parsed : available);
    if (!result.ok) {
      setWarn(result.error ?? '无法下令');
      return;
    }
    targetsCache = [];
  }

  setWarn('');
  const alive = current.state.players[0].alive;
  const orders = alive ? plan.toOrders() : [];
  current.step(new Map([[0, orders]]));

  // 玩家已出局：不再需要每回合思考，一次把剩余对局推演完
  if (!alive) {
    let guard = 0;
    while (!current.finished && guard < RULES.maxTurns) {
      current.step();
      guard++;
    }
  }

  match = current.result();
  plan = new HumanPlan(current.state);
  targetsCache = [];
  syncHumanFrame();
  setPlaying(false);
}

/** 进入「等玩家输入兵力」状态：填好默认值并聚焦输入框。 */
function prepareTroopsInput(): void {
  setWarn('');
  if (!plan?.pending) return;
  const available = plan.availableAt(plan.pending.from);
  cmdTroops.value = String(Math.max(1, available));
  syncCommandUi();
  cmdTroops.focus();
  cmdTroops.select();
}

/** 确认当前指令的兵力，落成待发指令；起点自动清空，等待下一条。 */
function commitOrder(): void {
  if (!plan?.pending) return;
  const available = plan.availableAt(plan.pending.from);
  const parsed = Number.parseInt(cmdTroops.value, 10);
  const result = plan.commit(Number.isFinite(parsed) ? parsed : available);
  if (!result.ok) {
    setWarn(result.error ?? '无法下令');
    return;
  }
  targetsCache = [];
  setWarn('');
  syncCommandUi();
}

function cancelSelection(): void {
  plan?.cancel();
  targetsCache = [];
  setWarn('');
  syncCommandUi();
}

function handleNodeClick(nodeId: number): void {
  const current = live;
  if (!current || !plan || current.finished) return;
  if (!current.state.players[0].alive) return;

  const owner = current.state.nodes[nodeId].owner;

  // 正在输入兵力：点起点取消整条指令，点其他节点则改换目标
  if (plan.pending) {
    if (nodeId === plan.pending.from) {
      cancelSelection();
      return;
    }
    const result = plan.begin(nodeId);
    if (!result.ok) {
      setWarn(result.error ?? '无法下令');
      return;
    }
    prepareTroopsInput();
    return;
  }

  if (plan.selected === null) {
    if (owner !== plan.player) {
      setWarn('先点你自己的节点作为起点');
      return;
    }
    plan.select(nodeId);
    targetsCache = plan.targets();
    setWarn('');
    syncCommandUi();
    return;
  }

  // 再点起点 = 取消选择；其他任何可达节点（包括自己的节点）都作为派兵目标
  if (nodeId === plan.selected) {
    cancelSelection();
    return;
  }

  const result = plan.begin(nodeId);
  if (!result.ok) {
    setWarn(result.error ?? '无法下令');
    return;
  }
  prepareTroopsInput();
}

// ---------------------------------------------------------------------------
// 帧同步与横幅
// ---------------------------------------------------------------------------

function syncFrame(rebuildLog = false): void {
  if (!match) return;
  frameIndex = Math.max(0, Math.min(frameIndex, match.frames.length - 1));
  const frame = match.frames[frameIndex];
  const lastFrame = match.frames[match.frames.length - 1];

  scrub.value = String(frameIndex);
  const totalTurns = isHumanMatch() ? RULES.maxTurns : lastFrame.turn;
  el('hud-turn').textContent = `第 ${frame.turn} / ${totalTurns} 回合`;
  el('turn-label').textContent = `回合 ${frame.turn} / ${lastFrame.turn}`;
  updateScoreboard(frame);
  syncLog(rebuildLog);
  updateBanner();
  syncCommandUi();
}

function updateBanner(): void {
  if (!match) return;
  const lastFrame = match.frames[match.frames.length - 1];
  const human = isHumanMatch();
  const atEnd = human ? Boolean(live?.finished) : frameIndex >= match.frames.length - 1;
  if (!atEnd) {
    banner.hidden = true;
    el('btn-replay').hidden = human;
    return;
  }

  const winner = match.winner;
  const title = el<HTMLDivElement>('banner-title');
  if (human) {
    if (winner === 0) {
      title.textContent = '你赢了';
      title.style.color = PLAYER_COLORS[0];
    } else if (winner === null) {
      title.textContent = '平局';
      title.style.color = '#e2e8f0';
    } else if (!live?.state.players[0].alive) {
      title.textContent = '你被淘汰';
      title.style.color = '#fca5a5';
    } else {
      title.textContent = `${match.names[winner]} 获胜`;
      title.style.color = PLAYER_COLORS[winner] ?? '#e2e8f0';
    }
  } else if (winner === null) {
    title.textContent = '平局';
    title.style.color = '#e2e8f0';
  } else {
    title.textContent = `${match.names[winner]} 获胜`;
    title.style.color = PLAYER_COLORS[winner] ?? '#e2e8f0';
  }

  if (human) {
    el('banner-sub').textContent =
      `${MODE_LABEL[match.mode]} · 种子 ${match.seed} · ${lastFrame.turn} 回合 · ${match.reason}`;
    el('btn-replay').hidden = true;
  } else {
    const think = match.stats.reduce(
      (sum, stat) => sum + stat.thinkMs.reduce((inner, value) => inner + value, 0),
      0,
    );
    const crashes = match.stats.reduce((sum, stat) => sum + stat.crashes, 0);
    const invalid = match.stats.reduce((sum, stat) => sum + stat.invalidOrders, 0);
    el('banner-sub').textContent =
      `${MODE_LABEL[match.mode]} · 种子 ${match.seed} · ${lastFrame.turn} 回合 · ` +
      `${match.reason} · 思考 ${think.toFixed(0)}ms · 驳回 ${invalid} · 崩溃 ${crashes}`;
    el('btn-replay').hidden = false;
  }
  banner.hidden = false;
}

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------

function setPlaying(value: boolean): void {
  playing = value;
  playButton.textContent = playing ? '⏸' : '▶';
  if (!playing) updateBanner();
}

function togglePlay(): void {
  if (!match || isHumanMatch()) return;
  if (!playing && frameIndex >= match.frames.length - 1) {
    frameIndex = 0;
    progress = 0;
    syncFrame(true);
  }
  setPlaying(!playing);
}

function step(delta: number): void {
  if (!match || isHumanMatch()) return;
  setPlaying(false);
  frameIndex = Math.max(0, Math.min(frameIndex + delta, match.frames.length - 1));
  progress = 0;
  syncFrame();
}

function jumpTo(index: number): void {
  if (!match || isHumanMatch()) return;
  setPlaying(false);
  frameIndex = Math.max(0, Math.min(index, match.frames.length - 1));
  progress = 0;
  syncFrame(true);
}

// ---------------------------------------------------------------------------
// 逐帧绘制
// ---------------------------------------------------------------------------

let visionCache = { frame: -1, vis: null as boolean[] | null, signature: '' };

function visionOf(frame: Frame): boolean[] | null {
  if (!match || !fogEnabled()) return null;
  const signature = `${frameIndex}:${frame.nodes.map((node) => node.owner).join(',')}`;
  if (visionCache.signature === signature && visionCache.vis) {
    visionCache.frame = frameIndex;
    return visionCache.vis;
  }
  const owners = frame.nodes.map((node) => node.owner);
  const kinds = match.map.nodes.map((node) => node.kind);
  const vis = computeVision(kinds, owners, match.map.adj, 0);
  visionCache = { frame: frameIndex, vis, signature };
  return vis;
}

function draw(time: number): void {
  if (!match) return;
  const frame = match.frames[frameIndex];
  const human = isHumanMatch();
  renderer.render({
    map: match.map,
    frame,
    progress,
    fog: fogEnabled(),
    viewpoint: 0,
    colors: PLAYER_COLORS,
    hover,
    time,
    selected: human ? plan?.selected ?? null : null,
    targets: human ? targetsCache : undefined,
    pending: human ? plan?.pending?.to ?? null : null,
    previewPath: human ? plan?.pending?.path : undefined,
    plan: human ? plan?.orders : undefined,
  });
}

function loop(now: number): void {
  // 后台标签页恢复、系统时钟回拨都可能让两帧的差值异常，夹在 0..160ms 内
  const dt = Math.max(0, Math.min(160, now - lastTime));
  lastTime = now;

  if (match && playing) {
    const perFrame = BASE_TURN_MS / settings.speed;
    progress += dt / perFrame;
    while (progress >= 1) {
      progress -= 1;
      if (frameIndex >= match.frames.length - 1) {
        progress = 0;
        setPlaying(false);
        break;
      }
      frameIndex += 1;
      syncFrame();
    }
  }

  draw(now / 1000);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// 悬停提示
// ---------------------------------------------------------------------------

function productionOfNode(frame: Frame, nodeId: number): number {
  if (!match) return 0;
  const owner = frame.nodes[nodeId].owner;
  if (owner < 0) return 0;
  const kind = match.map.nodes[nodeId].kind;
  const counts: Record<NodeKind, number> = { home: 0, farm: 0, mine: 0, lab: 0, watchtower: 0, foundry: 0 };
  match.map.nodes.forEach((node, index) => {
    if (node.kind !== kind) return;
    if (frame.nodes[index].owner === owner) counts[kind] += 1;
  });
  return productionForKind(kind, counts);
}

canvas.addEventListener('mousemove', (event) => {
  if (!match) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  hover = renderer.hitTest(x, y);

  if (hover === null) {
    tooltip.hidden = true;
    return;
  }

  const node = match.map.nodes[hover];
  const state = match.frames[frameIndex].nodes[hover];
  const vis = visionOf(match.frames[frameIndex]);
  const hidden = Boolean(vis && state.owner >= 0 && state.owner !== 0 && !vis[hover]);
  const ownerName = state.owner >= 0 ? match.names[state.owner] : '中立';
  const color = state.owner >= 0 ? PLAYER_COLORS[state.owner] : '#64748b';

  let action = '';
  if (isHumanMatch() && plan && !live?.finished && live?.state.players[0].alive) {
    if (plan.pending?.to === node.id) {
      action = '<div class="tt-row">已选为出兵终点，输入兵力后确认</div>';
    } else if (plan.pending?.from === node.id) {
      action = '<div class="tt-row">出兵起点，点击可取消这条指令</div>';
    } else if (plan.selected === node.id) {
      action = '<div class="tt-row">已选为起点，再点一次取消</div>';
    } else if (plan.selected === null) {
      if (state.owner === 0) action = '<div class="tt-row">点击选择为出兵起点</div>';
    } else if (plan.pending) {
      action = '<div class="tt-row">点击改选出兵终点</div>';
    } else if (targetsCache.includes(node.id)) {
      action = `<div class="tt-row">点击${state.owner === 0 ? '调兵到' : '派兵到'}这里</div>`;
    }
  }

  tooltip.innerHTML =
    `<div class="tt-title"><span style="color:${color}">●</span>${KIND_LABEL[node.kind]} #${node.id}</div>` +
    `<div class="tt-row">归属：${escapeHtml(ownerName)}</div>` +
    `<div class="tt-row">兵力：${hidden ? '?' : state.troops}</div>` +
    `<div class="tt-row">产出：${state.owner >= 0 ? `+${productionOfNode(match.frames[frameIndex], node.id)} / 回合` : '—'}</div>` +
    action;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.hidden = false;
});

canvas.addEventListener('click', (event) => {
  if (!isHumanMatch()) return;
  const rect = canvas.getBoundingClientRect();
  const nodeId = renderer.hitTest(event.clientX - rect.left, event.clientY - rect.top);
  if (nodeId === null) return;
  handleNodeClick(nodeId);
});

canvas.addEventListener('mouseleave', () => {
  hover = null;
  tooltip.hidden = true;
});

// ---------------------------------------------------------------------------
// 交互绑定
// ---------------------------------------------------------------------------

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#mode-seg button'))) {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode === 'ffa' ? 'ffa' : 'duel';
    if (settings.mode === mode) return;
    settings.mode = mode;
    syncModeButtons();
    renderSlots();
    saveSettings();
  });
}

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#seat-seg button'))) {
  button.addEventListener('click', () => {
    const seat: Seat = button.dataset.seat === 'human' ? 'human' : 'watch';
    if (settings.seat === seat) return;
    settings.seat = seat;
    syncSeatUi();
    renderSlots();
    saveSettings();
    startMatch();
  });
}

seedInput.value = String(settings.seed);
seedInput.addEventListener('change', () => {
  const parsed = Number.parseInt(seedInput.value, 10);
  settings.seed = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULTS.seed;
  seedInput.value = String(settings.seed);
  saveSettings();
});

el<HTMLButtonElement>('btn-dice').addEventListener('click', () => {
  settings.seed = Math.floor(Math.random() * 1_000_000_000);
  seedInput.value = String(settings.seed);
  saveSettings();
});

fogInput.checked = settings.fog;
fogInput.addEventListener('change', () => {
  settings.fog = fogInput.checked;
  saveSettings();
});

el<HTMLButtonElement>('btn-start').addEventListener('click', () => startMatch());
el<HTMLButtonElement>('btn-again').addEventListener('click', () => {
  settings.seed = Math.floor(Math.random() * 1_000_000_000);
  seedInput.value = String(settings.seed);
  saveSettings();
  startMatch();
});
el<HTMLButtonElement>('btn-replay').addEventListener('click', () => {
  if (!match || isHumanMatch()) return;
  frameIndex = 0;
  progress = 0;
  syncFrame(true);
  setPlaying(true);
});

endTurnButton.addEventListener('click', () => endTurn());

el<HTMLButtonElement>('btn-max').addEventListener('click', () => {
  if (!plan?.pending) return;
  cmdTroops.value = String(Math.max(1, plan.availableAt(plan.pending.from)));
  cmdTroops.focus();
});

confirmOrderButton.addEventListener('click', () => commitOrder());

el<HTMLButtonElement>('btn-clear-orders').addEventListener('click', () => {
  plan?.clear();
  targetsCache = plan?.targets() ?? [];
  setWarn('');
  syncCommandUi();
});

cmdTroops.addEventListener('change', () => {
  if (!plan?.pending) return;
  const available = plan.availableAt(plan.pending.from);
  const parsed = Number.parseInt(cmdTroops.value, 10);
  const value = Number.isFinite(parsed) ? Math.max(1, Math.min(available, parsed)) : Math.max(1, available);
  cmdTroops.value = String(value);
});

cmdTroops.addEventListener('keydown', (event) => {
  if (event.code === 'Enter') {
    event.preventDefault();
    commitOrder();
  } else if (event.code === 'Escape') {
    event.preventDefault();
    cancelSelection();
  }
});

el<HTMLButtonElement>('btn-first').addEventListener('click', () => jumpTo(0));
el<HTMLButtonElement>('btn-prev').addEventListener('click', () => step(-1));
el<HTMLButtonElement>('btn-play').addEventListener('click', () => togglePlay());
el<HTMLButtonElement>('btn-next').addEventListener('click', () => step(1));
el<HTMLButtonElement>('btn-last').addEventListener('click', () => jumpTo(Number.MAX_SAFE_INTEGER));

scrub.addEventListener('input', () => {
  if (!match) return;
  setPlaying(false);
  progress = 0;
  frameIndex = Number.parseInt(scrub.value, 10) || 0;
  syncFrame(true);
});

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#speeds button'))) {
  button.addEventListener('click', () => {
    const speed = Number(button.dataset.speed);
    if (!SPEEDS.includes(speed)) return;
    settings.speed = speed;
    syncSpeedButtons();
    saveSettings();
  });
}

el<HTMLButtonElement>('btn-clear-log').addEventListener('click', () => {
  logEl.innerHTML = '<p class="log-empty">战报已清空，新的事件会继续出现。</p>';
  logState.empty = true;
  logState.upto = frameIndex;
});

const rulesDialog = el<HTMLDialogElement>('rules-dialog');
el<HTMLButtonElement>('btn-rules').addEventListener('click', () => rulesDialog.showModal());
el<HTMLButtonElement>('btn-close-rules').addEventListener('click', () => rulesDialog.close());
rulesDialog.addEventListener('click', (event) => {
  if (event.target === rulesDialog) rulesDialog.close();
});

window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
    return;
  }
  if (isHumanMatch()) {
    if (event.code === 'Enter') {
      event.preventDefault();
      endTurn();
    } else if (event.code === 'Escape' && plan) {
      cancelSelection();
    }
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    togglePlay();
  } else if (event.code === 'ArrowRight') {
    event.preventDefault();
    step(1);
  } else if (event.code === 'ArrowLeft') {
    event.preventDefault();
    step(-1);
  } else if (event.code === 'KeyF') {
    fogInput.checked = !fogInput.checked;
    settings.fog = fogInput.checked;
    saveSettings();
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

renderSlots();
syncModeButtons();
syncSpeedButtons();
syncSeatUi();
startMatch();
requestAnimationFrame(loop);
