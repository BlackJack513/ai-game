// UI 冒烟测试：用 jsdom 加载 index.html，伪造 Canvas 2D 上下文，驱动 js/main.js 跑完整流程。
// 用法：npm run build && node scripts/ui-smoke.mjs
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { generateMap } from '../js/engine/mapgen.js';

const html = fs.readFileSync('index.html', 'utf8');
const failures = [];
const consoleErrors = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => failures.push(`jsdomError: ${error.message}`));
virtualConsole.on('error', (...args) => consoleErrors.push(args.join(' ')));

const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', virtualConsole });
const { window } = dom;
const { document } = window;

let drawCalls = 0;
const gradient = { addColorStop() {} };
const ctx = new Proxy(
  {},
  {
    get(target, prop) {
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'canvas') return null;
      if (prop in target) return target[prop];
      return (...args) => {
        drawCalls += 1;
        return undefined;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  },
);
window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 900,
  bottom: 700,
  width: 900,
  height: 700,
  toJSON() {},
});

globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.HTMLSelectElement = window.HTMLSelectElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
globalThis.HTMLCanvasElement = window.HTMLCanvasElement;
globalThis.MouseEvent = window.MouseEvent;

let rafCallback = null;
globalThis.requestAnimationFrame = (cb) => {
  rafCallback = cb;
  return 1;
};
window.requestAnimationFrame = globalThis.requestAnimationFrame;

let clock = 0;
function pump(frames, delta = 100) {
  for (let i = 0; i < frames; i += 1) {
    clock += delta;
    const cb = rafCallback;
    rafCallback = null;
    if (cb) cb(clock);
  }
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const text = (id) => document.getElementById(id).textContent.trim();

console.log('[1] 启动默认对局');
await import(new URL('../js/main.js', import.meta.url).href);
pump(3);

check('种子已展示', text('side-seed').includes('种子 2049'), text('side-seed'));
check('回合 HUD 已初始化', /第 0 \/ \d+ 回合/.test(text('hud-turn')), text('hud-turn'));
check('计分板 2 名玩家', document.querySelectorAll('#score .prow').length === 2, String(document.querySelectorAll('#score .prow').length));
check('画布已被绘制', drawCalls > 100, `drawCalls=${drawCalls}`);
check('空态提示已隐藏', document.getElementById('stage-empty').classList.contains('hidden'));

console.log('[2] 自动播放推进');
pump(12, 120);
const turn1 = text('hud-turn');
check('播放推进了回合', /第 [1-9]\d* \//.test(turn1), turn1);
check('播放中战报不报错', true);

console.log('[3] 播放控制');
document.getElementById('btn-play').click();
check('暂停后按钮显示 ▶', document.getElementById('btn-play').textContent.trim() === '▶');
const pausedTurn = text('hud-turn');
pump(10, 120);
check('暂停后回合不再推进', text('hud-turn') === pausedTurn, text('hud-turn'));

document.getElementById('btn-next').click();
check('单步前进一步', text('hud-turn') !== pausedTurn, text('hud-turn'));

document.getElementById('btn-first').click();
check('回到开局', /第 0 \//.test(text('hud-turn')), text('hud-turn'));

const scrub = document.getElementById('scrub');
scrub.value = '5';
scrub.dispatchEvent(new window.Event('input', { bubbles: true }));
check('拖动进度条生效', /第 [1-5] \//.test(text('hud-turn')), text('hud-turn'));

document.getElementById('btn-last').click();
check('跳到结尾显示横幅', !document.getElementById('banner').hidden, 'banner hidden');
check('横幅标题非空', text('banner-title').length > 0, text('banner-title'));
check('横幅包含原因', text('banner-sub').includes('回合'), text('banner-sub'));
check('战报已追加事件', document.querySelectorAll('#log .log-item').length > 0, String(document.querySelectorAll('#log .log-item').length));

console.log('[4] 键盘与迷雾');
window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
check('空格开始播放', document.getElementById('btn-play').textContent.trim() === '⏸');
window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));

const fog = document.getElementById('fog');
fog.checked = true;
fog.dispatchEvent(new window.Event('change', { bubbles: true }));
pump(2);
check('迷雾开关不崩溃', true);

console.log('[5] 切换四人混战');
document.querySelector('#mode-seg button[data-mode="ffa"]').click();
check('槽位变成 4 个', document.querySelectorAll('#slots .slot').length === 4, String(document.querySelectorAll('#slots .slot').length));
document.getElementById('btn-start').click();
pump(2);
check('混战 4 名玩家', document.querySelectorAll('#score .prow').length === 4, String(document.querySelectorAll('#score .prow').length));

console.log('[6] 移动鼠标与规则弹窗');
const canvas = document.getElementById('board');
canvas.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 450, clientY: 350, bubbles: true }));
canvas.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
check('悬停不崩溃', true);

const rulesDialog = document.getElementById('rules-dialog');
if (typeof rulesDialog.showModal === 'function') {
  document.getElementById('btn-rules').click();
  check('规则弹窗可打开', rulesDialog.open === true);
  document.getElementById('btn-close-rules').click();
  check('规则弹窗可关闭', rulesDialog.open === false);
} else {
  console.log('  - jsdom 不支持 dialog，跳过');
}

console.log('[7] 快速重开（种子/模式/速度）');
document.querySelector('#speeds button[data-speed="4"]').click();
document.getElementById('btn-dice').click();
document.getElementById('btn-start').click();
pump(20, 120);
check('4 倍速下多回合推进', /第 ([3-9]|\d{2,}) \//.test(text('hud-turn')), text('hud-turn'));

const seedInput = document.getElementById('seed');
seedInput.value = '424242';
seedInput.dispatchEvent(new window.Event('change', { bubbles: true }));
document.getElementById('btn-start').click();
check('自定义种子生效', text('side-seed').includes('424242'), text('side-seed'));

document.getElementById('btn-again').click();
check('再来一局换了种子', !text('side-seed').includes('424242'), text('side-seed'));

console.log('[8] 清空战报');
document.getElementById('btn-clear-log').click();
check('战报被清空', document.querySelectorAll('#log .log-item').length === 0);

console.log('[9] 真人挑战');
// 固定单挑 + 种子，保证能按地图坐标精确点到节点
document.querySelector('#mode-seg button[data-mode="duel"]').click();
seedInput.value = '2049';
seedInput.dispatchEvent(new window.Event('change', { bubbles: true }));
document.getElementById('btn-start').click();
pump(2);
document.querySelector('#seat-seg button[data-seat="human"]').click();
pump(2);
check('进入挑战模式：玩家槽位显示「你」', document.querySelector('#slots .slot.me .slot-name')?.textContent === '你');
check('战争迷雾被强制开启', document.getElementById('fog').checked === true && document.getElementById('fog').disabled === true);
check('指挥面板出现', document.getElementById('command').hidden === false);
check('回放控件被隐藏', document.getElementById('transport').hidden === true && document.getElementById('scrub-wrap').hidden === true);
check('结束回合按钮出现', document.getElementById('command-bar').hidden === false);
check('挑战以第 0 回合开局', /第 0 \//.test(text('hud-turn')), text('hud-turn'));

// 与渲染器同一套 fit 公式，把节点坐标换算成 canvas 内坐标
function boardPoint(map, id) {
  const width = 900;
  const height = 700;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const node of map.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const spanX = Math.max(0.001, maxX - minX);
  const spanY = Math.max(0.001, maxY - minY);
  const padX = Math.max(64, width * 0.085);
  const padY = Math.max(64, height * 0.1);
  const scale = Math.min((width - padX * 2) / spanX, (height - padY * 2) / spanY);
  const ox = (width - spanX * scale) / 2 - minX * scale;
  const oy = (height - spanY * scale) / 2 - minY * scale;
  const node = map.nodes[id];
  return { x: ox + node.x * scale, y: oy + node.y * scale };
}

const humanMap = generateMap('duel', 2049);
const home = humanMap.homes[0];
const neighbor = humanMap.adj[home][0];
const homePoint = boardPoint(humanMap, home);
const targetPoint = boardPoint(humanMap, neighbor);

canvas.dispatchEvent(new window.MouseEvent('click', { clientX: homePoint.x, clientY: homePoint.y, bubbles: true }));
pump(1);
check('点击己方节点选中起点', text('cmd-hint').includes(`起点：老家 #${home}`), text('cmd-hint'));
check('起点显示可用兵力', text('cmd-hint').includes('可用 20 兵'), text('cmd-hint'));

canvas.dispatchEvent(new window.MouseEvent('click', { clientX: targetPoint.x, clientY: targetPoint.y, bubbles: true }));
pump(1);
check('点击目标后询问兵力', document.getElementById('cmd-troops-row').hidden === false);
check('提示显示起点与目标', text('cmd-hint').includes('→ 目标'), text('cmd-hint'));
check('尚未生成指令', text('order-count') === '0 / 5', text('order-count'));

const troops = document.getElementById('cmd-troops');
troops.value = '12';
troops.dispatchEvent(new window.Event('change', { bubbles: true }));
document.getElementById('btn-confirm-order').click();
pump(1);
check('输入兵力确认后生成一条出兵令', text('order-count') === '1 / 5', text('order-count'));
check('指令列表出现 1 条', document.querySelectorAll('#cmd-list .cmd-item').length === 1);
check('确认后自动清空起点', text('cmd-hint').includes('选择出兵起点'), text('cmd-hint'));
check('确认后隐藏兵力输入行', document.getElementById('cmd-troops-row').hidden === true);

canvas.dispatchEvent(new window.MouseEvent('click', { clientX: homePoint.x, clientY: homePoint.y, bubbles: true }));
pump(1);
check('无需再点取消即可选下一个起点', text('cmd-hint').includes(`起点：老家 #${home}`), text('cmd-hint'));

document.getElementById('btn-end-turn').click();
pump(2);
check('结束回合后推进到第 1 回合', /第 1 \//.test(text('hud-turn')), text('hud-turn'));
check('结算后战报记录出兵/攻占', document.querySelectorAll('#log .log-item').length > 0);
check('新回合指令清空', text('order-count') === '0 / 5', text('order-count'));

document.getElementById('btn-end-turn').click();
pump(2);
check('真人回合可连续推进', /第 2 \//.test(text('hud-turn')), text('hud-turn'));

window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
pump(2);
check('回车也能结束回合', /第 3 \//.test(text('hud-turn')), text('hud-turn'));

document.querySelector('#seat-seg button[data-seat="watch"]').click();
pump(2);
check('切回观战后隐藏指挥面板', document.getElementById('command').hidden === true);
check('切回观战后恢复回放控件', document.getElementById('transport').hidden === false);

if (consoleErrors.length > 0) failures.push(`console.error: ${consoleErrors.join(' | ')}`);
if (failures.length > 0) {
  console.error(`\n✗ 冒烟测试失败 ${failures.length} 项：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\n✓ UI 冒烟测试全部通过（drawCalls=${drawCalls}）`);
