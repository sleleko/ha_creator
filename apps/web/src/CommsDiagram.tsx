import { forwardRef, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  labelAnchor,
  nodeBox,
  nodeShape,
  noteLines,
  offsetPolyline,
  pointAt,
  routeLine,
  type Diagram,
  type Line,
  type Project,
  type Pt,
  type UtilityNode,
} from '@ha-creator/core';

/** Цвета листа. Схема — «бумага», она всегда светлая, в том числе в тёмной теме и в выгруженном SVG. */
export const INK = {
  paper: '#ffffff',
  text: '#1c2330',
  muted: '#5d6675',
  frame: '#2a2f38',
  roomFrame: '#c9ced6',
  water: '#2f6fd6',
  heating: '#e0531f',
  shut: '#8a9bb0',
  electric: '#c08a1e',
  trace: '#d0263a',
  network: '#7a5af5',
  sewage: '#8a5a3c',
  garden: '#2f9a4a',
  security: '#5d6675',
  problem: '#d0263a',
  problemFill: '#fde7ea',
  select: '#1f6feb',
};

export type Selection = { type: 'node' | 'line' | 'zone'; id: string } | null;

export interface DiagramProps {
  project: Project;
  diagram: Diagram;
  /** Узлы и линии, отмеченные анализом как проблемные. */
  problemNodes: Set<string>;
  problemLines: Set<string>;
  /** Метки у узлов («нет крана»). */
  tags: Map<string, string>;
  /** Подсвеченные извне (наведение на пункт «слабых мест»). */
  focus: { nodes: Set<string>; lines: Set<string> } | null;
  hiddenLayers: Set<string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onChange: (d: Diagram) => void;
}

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const off = (s?: string) => s === 'shut' || s === 'drained' || s === 'off';

export function lineStyle(l: Pick<Line, 'layer' | 'state'>): { color: string; width: number; dash?: string } {
  if (off(l.state)) return { color: INK.shut, width: 2.2, dash: '6 5' };
  switch (l.layer) {
    case 'water':
      return { color: INK.water, width: 3 };
    case 'heating':
      return { color: INK.heating, width: 2.5 };
    case 'electric':
      return { color: INK.electric, width: 2, dash: '7 5' };
    case 'network':
      return { color: INK.network, width: 1.6 };
    default:
      return { color: INK[l.layer], width: 2 };
  }
}

const toPath = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

function within(r: { x: number; y: number; w: number; h: number }, p: Pt) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Схема коммуникаций: зоны, узлы, линии, краны. Всё, кроме линий, можно таскать мышью или пальцем. */
export const CommsDiagram = forwardRef<SVGSVGElement, DiagramProps>(function CommsDiagram(props, ref) {
  const { project, diagram, problemNodes, problemLines, tags, focus, hiddenLayers, selection, onSelect, onChange } = props;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ kind: 'node' | 'zone' | 'label'; id: string; start: Pt; base: Diagram; moved: boolean } | null>(null);

  const nodeById = new Map(project.utilityNodes.map((n) => [n.id, n]));
  const buildingIds = new Set(project.buildings.map((b) => b.id));
  const roomsOf = new Map(project.buildings.map((b) => [b.id, b.floors.flatMap((f) => f.rooms.map((r) => r.id))]));
  const zoneInfo = new Map<string, { name: string; notes?: string; cold: boolean; building: boolean }>();
  for (const b of project.buildings) {
    zoneInfo.set(b.id, { name: b.name, notes: b.notes, cold: b.heated === false, building: true });
    for (const f of b.floors) {
      for (const r of f.rooms) zoneInfo.set(r.id, { name: r.name, notes: r.notes, cold: !r.heated || r.insulated === false, building: false });
    }
  }

  const visibleNode = (n: UtilityNode) => !hiddenLayers.has(n.layer) && diagram.nodes[n.id];
  const nodes = project.utilityNodes.filter(visibleNode);
  const lines = project.lines.filter(
    (l) => !hiddenLayers.has(l.layer) && diagram.nodes[l.fromNodeId] && diagram.nodes[l.toNodeId] && nodeById.has(l.fromNodeId) && nodeById.has(l.toNodeId),
  );
  const routes = new Map(
    lines.map((l) => {
      const a = nodeById.get(l.fromNodeId)!;
      const b = nodeById.get(l.toNodeId)!;
      const pa = diagram.nodes[a.id]!;
      const pb = diagram.nodes[b.id]!;
      return [l.id, routeLine(pa, pb, diagram.waypoints[l.id] ?? [], nodeBox(a, pa), nodeBox(b, pb))];
    }),
  );

  // ---------- перетаскивание ----------
  function toSvg(e: { clientX: number; clientY: number }): Pt {
    const svg = svgRef.current!;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  function begin(kind: 'node' | 'zone' | 'label', id: string) {
    return (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      drag.current = { kind, id, start: toSvg(e), base: diagram, moved: false };
    };
  }

  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = toSvg(e);
    const dx = Math.round(p.x - d.start.x);
    const dy = Math.round(p.y - d.start.y);
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    onChange(applyDrag(d.base, d.kind, d.id, dx, dy));
  }

  function end(e: ReactPointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) onSelect(d.kind === 'label' ? { type: 'line', id: d.id } : { type: d.kind, id: d.id });
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  /** Сдвиг узла тянет за собой соседние изломы линий, чтобы отрезки остались прямыми. */
  function applyDrag(base: Diagram, kind: 'node' | 'zone' | 'label', id: string, dx: number, dy: number): Diagram {
    const next: Diagram = {
      ...base,
      zones: { ...base.zones },
      nodes: { ...base.nodes },
      waypoints: { ...base.waypoints },
      labels: { ...base.labels },
    };
    const shift = (p: Pt) => ({ x: p.x + dx, y: p.y + dy });

    if (kind === 'label') {
      const route = routes.get(id);
      const anchor = base.labels[id] ?? (route ? labelAnchor(route) : { x: 0, y: 0 });
      next.labels[id] = shift({ x: anchor.x, y: anchor.y });
      return next;
    }

    const movedNodes = new Set<string>();
    let area: { x: number; y: number; w: number; h: number } | null = null;
    if (kind === 'node') movedNodes.add(id);
    else {
      area = base.zones[id]!;
      const rooms = buildingIds.has(id) ? roomsOf.get(id) ?? [] : [id];
      for (const zid of [id, ...rooms]) if (base.zones[zid] && (zid === id || buildingIds.has(id))) next.zones[zid] = { ...base.zones[zid]!, ...shift(base.zones[zid]!) };
      for (const n of project.utilityNodes) if (rooms.includes(n.roomId) && base.nodes[n.id]) movedNodes.add(n.id);
    }
    for (const nid of movedNodes) next.nodes[nid] = shift(base.nodes[nid]!);

    for (const l of project.lines) {
      const wps = base.waypoints[l.id];
      const fromMoved = movedNodes.has(l.fromNodeId);
      const toMoved = movedNodes.has(l.toNodeId);
      if (area && fromMoved && toMoved) {
        if (wps) next.waypoints[l.id] = wps.map(shift);
        if (base.labels[l.id]) next.labels[l.id] = shift(base.labels[l.id]!);
        continue;
      }
      if (!wps || wps.length === 0) {
        if (area && base.labels[l.id] && within(area, base.labels[l.id]!)) next.labels[l.id] = shift(base.labels[l.id]!);
        continue;
      }
      const out = wps.map((w) => (area && within(area, w) ? shift(w) : { ...w }));
      const stick = (end: Pt | undefined, idx: number) => {
        if (!end) return;
        const w = out[idx]!;
        const orig = wps[idx]!;
        if (Math.abs(orig.x - end.x) < 1) w.x = end.x + dx;
        else if (Math.abs(orig.y - end.y) < 1) w.y = end.y + dy;
      };
      if (fromMoved) stick(base.nodes[l.fromNodeId], 0);
      if (toMoved) stick(base.nodes[l.toNodeId], out.length - 1);
      next.waypoints[l.id] = out;
      if (area && base.labels[l.id] && within(area, base.labels[l.id]!)) next.labels[l.id] = shift(base.labels[l.id]!);
    }
    return next;
  }

  // ---------- отрисовка ----------
  const isFocusNode = (id: string) => focus?.nodes.has(id) ?? false;
  const isFocusLine = (id: string) => focus?.lines.has(id) ?? false;
  const selected = (type: string, id: string) => selection?.type === type && selection.id === id;

  const zoneEntries = Object.entries(diagram.zones)
    .filter(([id]) => zoneInfo.has(id))
    .sort(([a], [b]) => Number(buildingIds.has(b)) - Number(buildingIds.has(a)));

  return (
    <svg
      ref={(el) => {
        svgRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${diagram.width} ${diagram.height}`}
      className="comms-svg"
      fontFamily={FONT}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => (drag.current = null)}
      onPointerDown={() => onSelect(null)}
      role="img"
      aria-label="Схема коммуникаций объекта"
    >
      <rect x={0} y={0} width={diagram.width} height={diagram.height} fill={INK.paper} />

      {diagram.groundY !== undefined && (
        <g>
          <line x1={16} x2={diagram.width - 16} y1={diagram.groundY} y2={diagram.groundY} stroke={INK.muted} strokeDasharray="2 3" />
          <text x={24} y={diagram.groundY - 6} fontSize={12} fill={INK.muted}>поверхность земли</text>
        </g>
      )}

      {zoneEntries.map(([id, r]) => {
        const info = zoneInfo.get(id)!;
        const building = buildingIds.has(id);
        const sel = selected('zone', id);
        const sameLine = info.notes && (info.name.length + info.notes.length) * 7 + 40 < r.w;
        return (
          <g key={id} className="draggable" onPointerDown={begin('zone', id)}>
            <rect
              x={r.x} y={r.y} width={r.w} height={r.h} rx={building ? 4 : 3}
              fill={building ? INK.paper : 'transparent'}
              stroke={sel ? INK.select : building ? INK.frame : INK.roomFrame}
              strokeWidth={building ? (info.cold ? 1.6 : 2) : 1.3}
              strokeDasharray={info.cold ? (building ? '6 4' : '5 4') : undefined}
            />
            <text x={r.x + 16} y={r.y + (building ? 25 : 22)} fontSize={building ? 15 : 13} fontWeight={700} fill={INK.text}>
              {info.name}
              {sameLine && <tspan dx={14} fontSize={12} fontWeight={400} fill={INK.muted}>{info.notes}</tspan>}
            </text>
            {info.notes && !sameLine && (
              <text x={r.x + 16} y={r.y + (building ? 43 : 39)} fontSize={12} fill={INK.muted}>{info.notes}</text>
            )}
          </g>
        );
      })}

      {lines.map((l) => {
        const pts = routes.get(l.id)!;
        const st = lineStyle(l);
        const hl = isFocusLine(l.id) || selected('line', l.id);
        return (
          <g key={l.id} onPointerDown={(e) => { e.stopPropagation(); onSelect({ type: 'line', id: l.id }); }} className="clickable">
            {hl && <path d={toPath(pts)} fill="none" stroke={INK.select} strokeOpacity={0.25} strokeWidth={st.width + 8} strokeLinejoin="round" />}
            {l.heatTrace && (
              <path d={toPath(offsetPolyline(pts, 5))} fill="none" stroke={INK.trace} strokeWidth={2} strokeDasharray="2 3" />
            )}
            <path d={toPath(pts)} fill="none" stroke={st.color} strokeWidth={st.width} strokeDasharray={st.dash} strokeLinejoin="round" />
            <path d={toPath(pts)} fill="none" stroke="transparent" strokeWidth={14} />
          </g>
        );
      })}

      {nodes.map((n) => {
        const c = diagram.nodes[n.id]!;
        const box = nodeBox(n, c);
        const shape = nodeShape(n);
        const problem = problemNodes.has(n.id);
        const sel = selected('node', n.id) || isFocusNode(n.id);
        const stroke = sel ? INK.select : problem ? INK.problem : INK.frame;
        const fill = problem ? INK.problemFill : INK.paper;
        const tag = tags.get(n.id);
        let body;
        if (shape === 'junction') {
          const color = n.layer === 'heating' ? INK.heating : INK.water;
          body = (
            <>
              <circle cx={c.x} cy={c.y} r={sel ? 6 : 4.5} fill={sel ? INK.select : color} />
              {n.kind === 'inlet' && <text x={c.x - 10} y={c.y + 4} fontSize={12} fill={INK.muted} textAnchor="end">{n.name}</text>}
            </>
          );
        } else if (shape === 'dot') {
          body = (
            <>
              <line x1={c.x} y1={c.y - 9} x2={c.x} y2={c.y} stroke={INK.trace} strokeWidth={1.5} />
              <circle cx={c.x} cy={c.y - 9} r={4} fill={sel ? INK.select : INK.trace} />
              <text x={c.x} y={c.y + 16} fontSize={12} fill={INK.muted} textAnchor="middle">{n.name}</text>
            </>
          );
        } else if (shape === 'radiator') {
          const shut = off(n.state);
          body = (
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={3} fill={INK.paper}
              stroke={sel ? INK.select : shut ? INK.shut : INK.heating} strokeWidth={1.6} />
          );
        } else {
          const rx = shape === 'tank' ? box.h / 2 : shape === 'chip' ? 6 : 4;
          const color = shape === 'chip' ? (sel ? INK.select : INK.network) : stroke;
          body = (
            <>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={rx} fill={fill} stroke={color} strokeWidth={problem || sel ? 1.8 : 1.3} />
              <text x={c.x} y={n.notes ? box.y + 18 : c.y + 4} fontSize={12} fill={INK.text} textAnchor="middle">{n.name}</text>
              {noteLines(n.notes).map((t, i) => (
                <text key={i} x={c.x} y={box.y + 32 + i * 13} fontSize={11} fill={INK.muted} textAnchor="middle">{t}</text>
              ))}
            </>
          );
        }
        return (
          <g key={n.id} className="draggable" onPointerDown={begin('node', n.id)}>
            <title>{[n.name, ...noteLines(n.notes)].join(' · ')}</title>
            {body}
            {tag && <text x={c.x} y={box.y + box.h + 15} fontSize={12} fontWeight={700} fill={INK.problem} textAnchor="middle">{tag}</text>}
          </g>
        );
      })}

      {lines.flatMap((l) =>
        l.fittings.map((f) => {
          const at = pointAt(routes.get(l.id)!, f.at);
          const closed = f.state === 'closed';
          const color = off(l.state) ? INK.shut : INK.frame;
          const horizontal = Math.abs(Math.sin((at.angle * Math.PI) / 180)) < 0.5;
          const label = f.label ?? (f.kind === 'drain' ? 'сливной' : f.kind === 'check_valve' ? 'обр. клапан' : undefined);
          return (
            <g key={f.id} onPointerDown={(e) => { e.stopPropagation(); onSelect({ type: 'line', id: l.id }); }} className="clickable">
              <title>{`${f.kind === 'drain' ? 'Сливной кран' : f.kind === 'check_valve' ? 'Обратный клапан' : 'Запорный кран'}: ${closed ? 'закрыт' : 'открыт'}`}</title>
              <g transform={`translate(${at.x} ${at.y}) rotate(${at.angle})`}>
                <path d="M-8 -6 L8 6 L8 -6 L-8 6 Z" fill={closed ? color : INK.paper} stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
              </g>
              {label && (
                <text x={horizontal ? at.x : at.x + 12} y={horizontal ? at.y - 11 : at.y + 4} fontSize={12} fill={INK.muted} textAnchor={horizontal ? 'middle' : 'start'}>
                  {label}
                </text>
              )}
            </g>
          );
        }),
      )}

      {lines.filter((l) => l.label).map((l) => {
        const custom = diagram.labels[l.id];
        const auto = labelAnchor(routes.get(l.id)!);
        const pos = custom ?? { x: auto.horizontal ? auto.x : auto.x + 8, y: auto.horizontal ? auto.y - 8 : auto.y };
        const anchor = custom || auto.horizontal ? 'middle' : 'start';
        const red = problemLines.has(l.id) && l.heatTrace;
        return (
          <text key={`label-${l.id}`} x={pos.x} y={pos.y} fontSize={12} fontWeight={red ? 700 : 400} fill={red ? INK.problem : INK.muted}
            textAnchor={anchor} className="draggable" onPointerDown={begin('label', l.id)}>
            {l.label}
          </text>
        );
      })}
    </svg>
  );
});
