import type { Diagram, Project, UtilityNode } from './schema.js';

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Как узел рисуется на схеме. */
export type NodeShape = 'box' | 'tank' | 'radiator' | 'junction' | 'dot' | 'chip';

export function nodeShape(n: Pick<UtilityNode, 'kind'>): NodeShape {
  switch (n.kind) {
    case 'pressure_tank':
      return 'tank';
    case 'radiator':
      return 'radiator';
    case 'well_head':
    case 'tee':
    case 'inlet':
      return 'junction';
    case 'socket':
      return 'dot';
    case 'router':
    case 'fiber_input':
      return 'chip';
    default:
      return 'box';
  }
}

/** Строки второй подписи узла: перенос задаётся символом \n. */
export function noteLines(notes?: string): string[] {
  return notes ? notes.split('\n') : [];
}

/** Размер узла на листе по его форме и подписи. */
export function nodeSize(n: Pick<UtilityNode, 'kind' | 'name' | 'notes'>): { w: number; h: number } {
  const shape = nodeShape(n);
  if (shape === 'junction') return { w: 10, h: 10 };
  if (shape === 'dot') return { w: 10, h: 10 };
  if (shape === 'radiator') return { w: 58, h: 20 };
  const notes = noteLines(n.notes);
  const text = Math.max(n.name.length, ...notes.map((l) => l.length));
  const w = Math.min(170, Math.max(shape === 'chip' ? 70 : 56, Math.round(text * 6.2) + 20));
  if (shape === 'chip') return { w, h: 24 + notes.length * 11 };
  if (shape === 'tank') return { w: Math.max(w, 110) + 24, h: 48 };
  return { w, h: 28 + notes.length * 13 };
}

export function nodeBox(n: UtilityNode, center: Pt): Box {
  const { w, h } = nodeSize(n);
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}

const inside = (b: Box, p: Pt) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;

/** Точка, где отрезок из центра коробки a→b выходит за её край. */
function exitPoint(box: Box, from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let t = 1;
  if (dx > 0) t = Math.min(t, (box.x + box.w - from.x) / dx);
  if (dx < 0) t = Math.min(t, (box.x - from.x) / dx);
  if (dy > 0) t = Math.min(t, (box.y + box.h - from.y) / dy);
  if (dy < 0) t = Math.min(t, (box.y - from.y) / dy);
  t = Math.max(0, t);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/** Обрезает начало ломаной по краю коробки, чтобы линия начиналась на границе узла. */
function clipStart(points: Pt[], box: Box): Pt[] {
  let i = 0;
  while (i < points.length - 1 && inside(box, points[i + 1]!)) i++;
  const rest = points.slice(i);
  if (rest.length < 2) return points;
  return [exitPoint(box, rest[0]!, rest[1]!), ...rest.slice(1)];
}

/**
 * Ломаная линии на листе: центр узла → промежуточные точки → центр узла, обрезанная по краям узлов.
 * Без промежуточных точек линия идёт сначала по горизонтали, потом по вертикали.
 */
export function routeLine(from: Pt, to: Pt, waypoints: Pt[] = [], fromBox?: Box, toBox?: Box): Pt[] {
  let pts: Pt[] = [from, ...waypoints, to];
  if (waypoints.length === 0 && from.x !== to.x && from.y !== to.y) pts = [from, { x: to.x, y: from.y }, to];
  if (fromBox) pts = clipStart(pts, fromBox);
  if (toBox) pts = clipStart([...pts].reverse(), toBox).reverse();
  return pts;
}

export function polylineLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return len;
}

/** Точка на ломаной на доле t длины и направление отрезка в градусах. */
export function pointAt(pts: Pt[], t: number): Pt & { angle: number } {
  const total = polylineLength(pts);
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (left <= seg || i === pts.length - 1) {
      const k = seg === 0 ? 0 : Math.min(1, left / seg);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle };
    }
    left -= seg;
  }
  return { ...pts[0]!, angle: 0 };
}

/** Середина самого длинного отрезка: туда по умолчанию ставится подпись линии. */
export function labelAnchor(pts: Pt[]): Pt & { horizontal: boolean } {
  let best = 1;
  let bestLen = -1;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (len > bestLen) [best, bestLen] = [i, len];
  }
  const a = pts[best - 1]!;
  const b = pts[best]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, horizontal: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) };
}

/** Сдвигает ломаную вбок на d пикселей (для греющего кабеля рядом с трубой). Работает для прямых углов. */
export function offsetPolyline(pts: Pt[], d: number): Pt[] {
  const normals = pts.slice(1).map((b, i) => {
    const a = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  });
  return pts.map((p, i) => {
    const n1 = normals[Math.max(0, i - 1)]!;
    const n2 = normals[Math.min(normals.length - 1, i)]!;
    return { x: p.x + (n1.x + n2.x - (n1.x === n2.x ? n1.x : 0)) * d, y: p.y + (n1.y + n2.y - (n1.y === n2.y ? n1.y : 0)) * d };
  });
}

/**
 * Раскладка по умолчанию для проекта без diagram: постройки в ряд, помещения внутри, узлы сеткой.
 * Нужна, чтобы новый объект сразу можно было увидеть и дальше растащить мышью.
 */
export function autoLayout(project: Project): Diagram {
  const zones: Diagram['zones'] = {};
  const nodes: Diagram['nodes'] = {};
  const roomOf = new Map<string, string>();
  const gap = 24;
  let x = gap;
  let maxH = 0;
  for (const b of project.buildings) {
    const rooms = b.floors.flatMap((f) => f.rooms);
    const nodesByRoom = rooms.map((r) => project.utilityNodes.filter((n) => n.roomId === r.id));
    if (nodesByRoom.every((list) => list.length === 0)) continue;
    const single = rooms.length === 1;
    const roomW = 200;
    let y = 60;
    const bx = x;
    rooms.forEach((r, i) => {
      const list = nodesByRoom[i]!;
      if (!single && list.length === 0) return;
      const rows = Math.max(1, Math.ceil(list.length / 2));
      const h = single ? rows * 64 + 16 : rows * 64 + 44;
      const top = single ? y : y + 36;
      list.forEach((n, k) => {
        nodes[n.id] = { x: bx + 16 + (k % 2) * 92 + 46, y: top + Math.floor(k / 2) * 64 + 32 };
        roomOf.set(n.id, r.id);
      });
      if (!single) zones[r.id] = { x: bx + 12, y, w: roomW, h };
      y += h + 10;
    });
    zones[b.id] = { x: bx, y: 20, w: roomW + 24, h: y - 10 };
    maxH = Math.max(maxH, y + 20);
    x += roomW + 24 + gap;
  }
  return { width: Math.max(640, x), height: Math.max(400, maxH), zones, nodes, waypoints: {}, labels: {} };
}
