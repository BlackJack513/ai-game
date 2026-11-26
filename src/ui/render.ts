/**
 * Canvas 沙盘渲染器。
 *
 * 只依赖「地图 + 逐回合快照 + 当前帧内进度」，因此天然支持暂停、单步与拖动回放。
 */

import type { Frame, FrameColumn } from '../engine/runner.js';
import { computeVision } from '../engine/sim.js';
import { KIND_GLYPH, NEUTRAL, type GameMap, type NodeKind } from '../engine/types.js';

export interface RenderPlanOrder {
  from: number;
  to: number;
  troops: number;
  path: number[];
}

export interface RenderInput {
  map: GameMap;
  frame: Frame;
  /** 0..1，当前回合内的动画进度（纵队在两格之间移动） */
  progress: number;
  fog: boolean;
  /** 迷雾视角：以哪个玩家的视野观战 */
  viewpoint: number;
  /** 每位玩家的颜色 */
  colors: string[];
  hover: number | null;
  /** 秒，用于呼吸/脉动动画 */
  time: number;
  /** 真人操作：当前选中的出兵起点 */
  selected?: number | null;
  /** 真人操作：从起点可以下令的目标 */
  targets?: number[];
  /** 真人操作：已选好终点、正在等玩家输入兵力的目标 */
  pending?: number | null;
  /** 真人操作：起点到等待目标的预览路径 */
  previewPath?: number[];
  /** 真人操作：本回合还没提交的出兵令 */
  plan?: RenderPlanOrder[];
}

interface Layout {
  ox: number;
  oy: number;
  scale: number;
  minX: number;
  minY: number;
}

const FONT = '"Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace';

function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private layout: Layout | null = null;
  private radius = 16;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 Canvas 2D');
    this.ctx = ctx;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 屏幕坐标（canvas 内 CSS 像素）→ 节点 id */
  hitTest(x: number, y: number): number | null {
    if (!this.layout) return null;
    const map = this.map;
    if (!map) return null;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const node of map.nodes) {
      const p = this.toScreen(node.x, node.y);
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist < this.radius + 8 && dist < bestDist) {
        best = node.id;
        bestDist = dist;
      }
    }
    return best;
  }

  private map: GameMap | null = null;

  private toScreen(x: number, y: number): { x: number; y: number } {
    const layout = this.layout;
    if (!layout) return { x: 0, y: 0 };
    return { x: layout.ox + x * layout.scale, y: layout.oy + y * layout.scale };
  }

  private fit(map: GameMap): Layout {
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
    const padX = Math.max(64, this.width * 0.085);
    const padY = Math.max(64, this.height * 0.1);
    const scale = Math.min((this.width - padX * 2) / spanX, (this.height - padY * 2) / spanY);
    const ox = (this.width - spanX * scale) / 2 - minX * scale;
    const oy = (this.height - spanY * scale) / 2 - minY * scale;
    return { ox, oy, scale, minX, minY };
  }

  render(input: RenderInput): void {
    this.resize();
    const ctx = this.ctx;
    const { map, frame } = input;
    this.map = map;

    ctx.clearRect(0, 0, this.width, this.height);

    const layout = this.fit(map);
    this.layout = layout;
    const base = Math.min(26, Math.max(13, layout.scale * 0.05));
    this.radius = base;

    const owners = frame.nodes.map((node) => node.owner);
    const kinds = map.nodes.map((node) => node.kind);
    const visible = input.fog ? computeVision(kinds, owners, map.adj, input.viewpoint) : null;

    const radiusOf = (kind: NodeKind): number => {
      if (kind === 'home') return base * 1.14;
      if (kind === 'watchtower' || kind === 'foundry') return base;
      return base * 0.86;
    };

    const targets = new Set(input.targets ?? []);

    // ---- 连线 -------------------------------------------------------------
    for (const [a, b] of map.edges) {
      const na = map.nodes[a];
      const nb = map.nodes[b];
      const pa = this.toScreen(na.x, na.y);
      const pb = this.toScreen(nb.x, nb.y);
      const oa = owners[a];
      const ob = owners[b];
      const sameOwner = oa >= 0 && oa === ob;
      const hiddenEdge = visible ? !visible[a] && !visible[b] : false;

      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      if (hiddenEdge) {
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.12)';
        ctx.lineWidth = 1;
      } else if (sameOwner) {
        ctx.strokeStyle = rgba(input.colors[oa] ?? '#94a3b8', 0.26);
        ctx.lineWidth = 2.6;
      } else {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
        ctx.lineWidth = 1.3;
      }
      ctx.stroke();
    }

    // ---- 行军纵队 ---------------------------------------------------------
    for (const column of frame.columns) {
      const known = !visible || column.path.some((id) => visible[id]);
      if (!known) continue;
      this.drawColumn(input, column, base);
    }

    // ---- 节点 -------------------------------------------------------------
    for (const node of map.nodes) {
      const state = frame.nodes[node.id];
      const p = this.toScreen(node.x, node.y);
      const r = radiusOf(node.kind);
      const owned = state.owner >= 0;
      const color = owned ? input.colors[state.owner] : null;
      const known = !visible || state.owner === NEUTRAL || state.owner === input.viewpoint || visible[node.id];
      const hidden = !known;

      // 光晕
      if (color && !hidden) {
        ctx.shadowColor = rgba(color, 0.9);
        ctx.shadowBlur = 20;
      }

      const gradient = ctx.createRadialGradient(p.x - r * 0.32, p.y - r * 0.36, r * 0.12, p.x, p.y, r);
      if (color && !hidden) {
        gradient.addColorStop(0, rgba(color, 0.5));
        gradient.addColorStop(0.65, rgba(color, 0.16));
        gradient.addColorStop(1, '#0a1220');
      } else if (hidden) {
        gradient.addColorStop(0, '#121a2b');
        gradient.addColorStop(1, '#080e19');
      } else {
        gradient.addColorStop(0, '#24334a');
        gradient.addColorStop(1, '#0b1424');
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.shadowBlur = 0;

      // 外圈
      ctx.lineWidth = node.kind === 'home' ? 2.7 : 1.8;
      if (hidden) {
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.55)';
        ctx.setLineDash([3, 4]);
      } else {
        ctx.strokeStyle = color ? rgba(color, 0.92) : 'rgba(148, 163, 184, 0.4)';
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // 老家：第二圈 + 缓慢旋转的刻度
      if (node.kind === 'home') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = color && !hidden ? rgba(color, 0.36) : 'rgba(148, 163, 184, 0.2)';
        ctx.lineWidth = 1.4;
        ctx.stroke();

        const spin = input.time * 0.5;
        ctx.strokeStyle = color && !hidden ? rgba(color, 0.55) : 'rgba(148, 163, 184, 0.25)';
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 4; i++) {
          const angle = spin + (i * Math.PI) / 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 5, angle, angle + 0.28);
          ctx.stroke();
        }
      }

      // 类型字形
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(r * 0.54)}px ${FONT}`;
      ctx.fillStyle = hidden ? 'rgba(148, 163, 184, 0.45)' : color ? 'rgba(240, 249, 255, 0.9)' : 'rgba(203, 213, 225, 0.8)';
      ctx.fillText(KIND_GLYPH[node.kind], p.x, p.y + r * 0.02);

      // 兵力
      const label = hidden ? '?' : String(state.troops);
      ctx.font = `700 ${Math.round(base * 0.6)}px ${MONO}`;
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
      ctx.strokeText(label, p.x, p.y + r + base * 0.58);
      ctx.fillStyle = hidden ? 'rgba(148, 163, 184, 0.75)' : owned ? '#f1f5f9' : '#cbd5e1';
      ctx.fillText(label, p.x, p.y + r + base * 0.58);

      // 悬停高亮
      if (input.hover === node.id) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.75)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 真人操作：可下令的目标与当前选中的起点
      if (targets.has(node.id)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (input.selected === node.id) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(224, 242, 254, 0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 14, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 已选好终点、等待输入兵力：琥珀色脉冲环
      if (input.pending === node.id) {
        const pulse = 0.6 + 0.3 * Math.sin(input.time * 4.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(251, 191, 36, ${pulse})`;
        ctx.lineWidth = 2.4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 15, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.32)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([2, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---- 真人待发指令 -----------------------------------------------------
    if (input.previewPath) this.drawPreview(input, input.previewPath, base);
    for (const order of input.plan ?? []) this.drawPlan(input, order, base);

    // ---- 攻占闪光 ---------------------------------------------------------
    for (const event of frame.events) {
      if (event.type !== 'capture') continue;
      const node = map.nodes[event.node];
      if (!node) continue;
      const p = this.toScreen(node.x, node.y);
      const r = radiusOf(node.kind);
      const t = Math.min(1, Math.max(0, input.progress));
      const color = input.colors[event.to] ?? '#e2e8f0';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4 + t * 34, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color, (1 - t) * 0.85);
      ctx.lineWidth = 2.4 * (1 - t) + 0.6;
      ctx.stroke();
    }
  }

  /** 画一条「已选终点、还没输入兵力」的预览路径。 */
  private drawPreview(input: RenderInput, path: number[], base: number): void {
    if (path.length < 2) return;
    const ctx = this.ctx;
    const start = input.map.nodes[path[0]];
    const first = this.toScreen(start.x, start.y);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < path.length; i++) {
      const node = input.map.nodes[path[i]];
      const point = this.toScreen(node.x, node.y);
      ctx.lineTo(point.x, point.y);
    }
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    const a = input.map.nodes[path[path.length - 2]];
    const b = input.map.nodes[path[path.length - 1]];
    const pb = this.toScreen(b.x, b.y);
    const dir = Math.atan2(b.y - a.y, b.x - a.x);
    const size = Math.max(8, base * 0.38);
    ctx.beginPath();
    ctx.moveTo(pb.x + Math.cos(dir) * size, pb.y + Math.sin(dir) * size);
    ctx.lineTo(pb.x + Math.cos(dir + 2.5) * size, pb.y + Math.sin(dir + 2.5) * size);
    ctx.lineTo(pb.x + Math.cos(dir - 2.5) * size, pb.y + Math.sin(dir - 2.5) * size);
    ctx.closePath();
    ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
    ctx.shadowColor = 'rgba(251, 191, 36, 0.8)';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  /** 画一条「已下令、还没结算」的出兵令：虚线路径 + 终点箭头 + 兵力。 */
  private drawPlan(input: RenderInput, order: RenderPlanOrder, base: number): void {
    const ctx = this.ctx;
    const path = order.path;
    if (path.length < 2) return;
    const color = input.colors[input.viewpoint] ?? '#38bdf8';

    const start = input.map.nodes[path[0]];
    ctx.beginPath();
    const first = this.toScreen(start.x, start.y);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < path.length; i++) {
      const node = input.map.nodes[path[i]];
      const point = this.toScreen(node.x, node.y);
      ctx.lineTo(point.x, point.y);
    }
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    const a = input.map.nodes[path[path.length - 2]];
    const b = input.map.nodes[path[path.length - 1]];
    const pb = this.toScreen(b.x, b.y);
    const dir = Math.atan2(b.y - a.y, b.x - a.x);
    const size = Math.max(8, base * 0.38);
    ctx.beginPath();
    ctx.moveTo(pb.x + Math.cos(dir) * size, pb.y + Math.sin(dir) * size);
    ctx.lineTo(pb.x + Math.cos(dir + 2.5) * size, pb.y + Math.sin(dir + 2.5) * size);
    ctx.lineTo(pb.x + Math.cos(dir - 2.5) * size, pb.y + Math.sin(dir - 2.5) * size);
    ctx.closePath();
    ctx.fillStyle = rgba(color, 0.9);
    ctx.shadowColor = rgba(color, 0.8);
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;

    const nx = Math.cos(dir + Math.PI / 2) * (size + 7);
    const ny = Math.sin(dir + Math.PI / 2) * (size + 7);
    ctx.font = `700 ${Math.round(base * 0.46)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.92)';
    ctx.strokeText(String(order.troops), pb.x + nx, pb.y + ny);
    ctx.fillStyle = rgba(color, 0.95);
    ctx.fillText(String(order.troops), pb.x + nx, pb.y + ny);
  }

  private drawColumn(input: RenderInput, column: FrameColumn, base: number): void {
    const ctx = this.ctx;
    const map = input.map;
    const path = column.path;
    if (path.length < 2) return;

    const travel = Math.max(0, input.frame.turn - column.departTurn) + input.progress;
    const clamped = Math.min(Math.max(travel, 0), path.length - 1);
    const index = Math.min(Math.floor(clamped), path.length - 2);
    const frac = clamped - index;

    const a = map.nodes[path[index]];
    const b = map.nodes[path[index + 1]];
    if (!a || !b) return;

    const mx = a.x + (b.x - a.x) * frac;
    const my = a.y + (b.y - a.y) * frac;
    const p = this.toScreen(mx, my);
    const color = input.colors[column.owner] ?? '#94a3b8';

    // 行军轨迹：从当前位置到终点
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    for (let i = index + 1; i < path.length; i++) {
      const node = map.nodes[path[i]];
      const q = this.toScreen(node.x, node.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = rgba(color, 0.3);
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 7]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 方向箭头
    const dir = Math.atan2(b.y - a.y, b.x - a.x);
    const size = Math.max(7, base * 0.34);
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(dir) * size, p.y + Math.sin(dir) * size);
    ctx.lineTo(p.x + Math.cos(dir + 2.5) * size, p.y + Math.sin(dir + 2.5) * size);
    ctx.lineTo(p.x + Math.cos(dir - 2.5) * size, p.y + Math.sin(dir - 2.5) * size);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.shadowColor = rgba(color, 0.9);
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 兵力数字
    const nx = Math.cos(dir + Math.PI / 2) * (size + 8);
    const ny = Math.sin(dir + Math.PI / 2) * (size + 8);
    ctx.font = `600 ${Math.round(base * 0.44)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.92)';
    ctx.strokeText(String(column.troops), p.x + nx, p.y + ny);
    ctx.fillStyle = rgba(color, 0.95);
    ctx.fillText(String(column.troops), p.x + nx, p.y + ny);
  }
}
