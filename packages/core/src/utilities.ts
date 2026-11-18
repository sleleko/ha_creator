import type { Line, Project, UtilityNode } from './schema.js';

/** Находка анализа схемы коммуникаций. */
export interface Finding {
  id: string;
  /** Текст для блока «Слабые места». */
  text: string;
  /** Короткая метка у узла на схеме, например «нет крана». */
  tag?: string;
  nodeIds: string[];
  lineIds: string[];
}

/** Типы узлов с водой, которые портит мороз. */
const WATER_EQUIPMENT: Record<string, string> = {
  pressure_tank: 'гидроаккумулятор',
  filter: 'фильтр',
  pressure_switch: 'реле давления',
  pump: 'насос',
  surface_pump: 'насосная станция',
};

/** Нагрузки, которые встают при отключении света, и их короткие имена. */
const POWER_CRITICAL: Record<string, string> = {
  well_pump: 'насос',
  surface_pump: 'насосная станция',
  gas_boiler: 'котёл',
  electric_boiler: 'котёл',
};

const isWater = (l: { layer: string }) => l.layer === 'water';
const isOn = (s: string | undefined) => s === undefined || s === 'active';
const fmt = (n: number) => String(n).replace('.', ',');
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function joinRu(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

interface Index {
  nodeById: Map<string, UtilityNode>;
  roomById: Map<string, { name: string; heated: boolean; buildingName: string; buildingHeated?: boolean }>;
  incoming: Map<string, Line[]>;
}

function index(project: Project): Index {
  const roomById: Index['roomById'] = new Map();
  for (const b of project.buildings) {
    for (const f of b.floors) {
      for (const r of f.rooms) roomById.set(r.id, { name: r.name, heated: r.heated, buildingName: b.name, buildingHeated: b.heated });
    }
  }
  const incoming = new Map<string, Line[]>();
  for (const l of project.lines) {
    incoming.set(l.toNodeId, [...(incoming.get(l.toNodeId) ?? []), l]);
  }
  return { nodeById: new Map(project.utilityNodes.map((n) => [n.id, n])), roomById, incoming };
}

/** Помещение холодное: само не отапливается или стоит в неотапливаемой постройке. */
function coldRoom(ix: Index, roomId: string): boolean {
  const room = ix.roomById.get(roomId);
  if (!room) return false;
  return !room.heated || room.buildingHeated === false;
}

/** Имя линии для текста: своё имя или «Труба от A к B». */
function lineName(ix: Index, l: Line): string {
  if (l.name) return l.name;
  const from = ix.nodeById.get(l.fromNodeId)?.name ?? l.fromNodeId;
  const to = ix.nodeById.get(l.toNodeId)?.name ?? l.toNodeId;
  return `${l.layer === 'water' ? 'Труба' : 'Линия'} «${from} → ${to}»`;
}

/** Есть ли на линии кран (запорный или сливной). */
const hasValve = (l: Line) => l.fittings.some((f) => f.kind === 'shutoff' || f.kind === 'drain');

/**
 * Слабые места водоснабжения и питания при включённой зимой воде.
 * Правила построены по схеме дачи и годятся для любого объекта с сезонным проживанием.
 */
export function findWeakPoints(project: Project): Finding[] {
  const ix = index(project);
  const out: Finding[] = [];
  const frostDepth = project.site.frostDepthM;

  // 1. Водяное оборудование в холодном помещении — по одному пункту на помещение.
  const coldEquipment = new Map<string, UtilityNode[]>();
  for (const n of project.utilityNodes) {
    if (!(n.kind in WATER_EQUIPMENT) || !isOn(n.state) || !coldRoom(ix, n.roomId)) continue;
    coldEquipment.set(n.roomId, [...(coldEquipment.get(n.roomId) ?? []), n]);
  }
  for (const [roomId, nodes] of coldEquipment) {
    const room = ix.roomById.get(roomId)!;
    const names = nodes.map((n) => WATER_EQUIPMENT[n.kind]!);
    const where = room.name === room.buildingName ? room.name.toLowerCase() : `${room.buildingName.toLowerCase()}, ${room.name.toLowerCase()}`;
    out.push({
      id: `cold_equipment_${roomId}`,
      text: `${capitalize(joinRu(names))} в неотапливаемом помещении (${where}).`,
      nodeIds: nodes.map((n) => n.id),
      lineIds: [],
    });
  }

  for (const l of project.lines) {
    if (!isWater(l) || !isOn(l.state)) continue;
    // 2. Труба в земле выше глубины промерзания.
    if (l.laying === 'underground' && l.depthM !== undefined && l.depthM < frostDepth) {
      const depth = `на ${fmt(l.depthM)} м`;
      out.push({
        id: `shallow_${l.id}`,
        text: l.heatTrace
          ? `${lineName(ix, l)} ${depth}: держится только на греющем кабеле.`
          : `${lineName(ix, l)} ${depth}, выше промерзания (${fmt(frostDepth)} м): замёрзнет.`,
        nodeIds: [],
        lineIds: [l.id],
      });
    }
    // 3. Труба снаружи по воздуху.
    if (l.laying === 'outdoor') {
      const closed = l.fittings.some((f) => f.kind === 'shutoff' && f.state === 'closed');
      out.push({
        id: `outdoor_${l.id}`,
        text: closed
          ? `${lineName(ix, l)} идёт снаружи: зимой держится только на закрытом кране и сливе.`
          : `${lineName(ix, l)} идёт снаружи${l.heatTrace ? ' и держится только на греющем кабеле' : ' без защиты: замёрзнет'}.`,
        nodeIds: [],
        lineIds: [l.id],
      });
    }
  }

  // 4. Слитый на зиму водонагреватель в холодном помещении без крана на подаче.
  for (const n of project.utilityNodes) {
    if (n.kind !== 'water_heater' || n.state !== 'drained' || !coldRoom(ix, n.roomId)) continue;
    const feeds = (ix.incoming.get(n.id) ?? []).filter(isWater);
    if (feeds.length === 0 || feeds.some(hasValve)) continue;
    const room = ix.roomById.get(n.roomId)!;
    out.push({
      id: `no_valve_${n.id}`,
      text: `${capitalize(n.name)} (${room.name.toLowerCase()}) без крана: при подаче воды наполнится.`,
      tag: 'нет крана',
      nodeIds: [n.id],
      lineIds: feeds.map((l) => l.id),
    });
  }

  // 5. Всё встаёт разом при отключении света.
  if (project.site.power.backup === 'none') {
    const nodes = project.utilityNodes.filter((n) => n.kind in POWER_CRITICAL && isOn(n.state));
    const traced = project.lines.filter((l) => l.heatTrace && isOn(l.state));
    const names = [...new Set([...nodes.map((n) => POWER_CRITICAL[n.kind]!), ...(traced.length ? ['кабель'] : [])])];
    if (names.length >= 2) {
      out.push({
        id: 'power_outage',
        text: `При отключении света встают ${joinRu(names)} одновременно.`,
        nodeIds: nodes.map((n) => n.id),
        lineIds: traced.map((l) => l.id),
      });
    }
  }

  return out;
}

/** Пробелы в описании, которые программа видит сама: их стоит уточнить на объекте. */
export function findDataGaps(project: Project): Finding[] {
  const ix = index(project);
  const out: Finding[] = [];
  for (const l of project.lines) {
    if (l.laying === 'underground' && l.depthM === undefined && l.layer === 'water') {
      out.push({ id: `depth_${l.id}`, text: `${lineName(ix, l)}: не указана глубина прокладки.`, nodeIds: [], lineIds: [l.id] });
    }
  }
  for (const n of project.utilityNodes) {
    if (n.kind in POWER_CRITICAL && !n.poweredByNodeId && n.kind !== 'gas_boiler') {
      out.push({ id: `power_${n.id}`, text: `${capitalize(n.name)}: не указано, откуда питается.`, nodeIds: [n.id], lineIds: [] });
    }
  }
  return out;
}
