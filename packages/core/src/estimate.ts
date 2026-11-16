import type { Device, Project, WorkRate } from './schema.js';

export type EstimateSection = 'equipment' | 'materials' | 'works' | 'overhead';

export interface EstimateLine {
  section: EstimateSection;
  /** SKU изделия, id расценки или код накладной статьи. */
  code: string;
  name: string;
  unit: string;
  qty: number;
  priceRub: number;
  sumRub: number;
  /** false — цена ориентировочная и требует проверки. */
  priceVerified: boolean;
  /** Откуда взялась строка: названия точек, сценарии, примечание. */
  basis: string;
}

export interface Estimate {
  lines: EstimateLine[];
  totals: Record<EstimateSection, number> & { total: number };
  /** Сколько строк посчитано по непроверенным ценам и какая это доля суммы, от 0 до 1. */
  unverified: { lines: number; share: number };
  /** Что не удалось посчитать: нет изделия в каталоге, нет расценки и т. п. */
  problems: string[];
}

export interface EstimateCatalogs {
  devices: Device[];
  works: WorkRate[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function joinNames(names: string[], limit = 4): string {
  return names.length <= limit ? names.join(', ') : `${names.slice(0, limit).join(', ')} и ещё ${names.length - limit}`;
}

/**
 * Считает смету проекта.
 *
 * Правила:
 * - каждая точка автоматизации с deviceSku — одно изделие;
 * - `extras` добавляются как есть: изделия категории material идут в материалы, остальное — в оборудование;
 * - монтаж каждой точки берётся из расценки, у которой функция точки есть в appliesTo;
 * - сопряжение Zigbee — за каждое Zigbee-изделие, сборка узла ESPHome — за каждый контроллер ESPHome;
 * - настройка сценария — за каждый сценарий; установка HA, панель и пусконаладка — по одному разу;
 * - настройка сети — если у объекта есть интернет;
 * - накладные: выезды, доставка и запас в процентах от суммы оборудования, материалов и работ.
 */
export function computeEstimate(project: Project, catalogs: EstimateCatalogs): Estimate {
  const deviceBySku = new Map(catalogs.devices.map((d) => [d.sku, d]));
  const workById = new Map(catalogs.works.map((w) => [w.id, w]));
  const problems: string[] = [];

  // ---- Оборудование и материалы ----
  const deviceQty = new Map<string, { qty: number; basis: string[] }>();
  const addDevice = (sku: string, qty: number, basis: string) => {
    const entry = deviceQty.get(sku) ?? { qty: 0, basis: [] };
    entry.qty += qty;
    if (basis) entry.basis.push(basis);
    deviceQty.set(sku, entry);
  };
  for (const p of project.automationPoints) {
    if (p.deviceSku) addDevice(p.deviceSku, 1, p.name);
    else problems.push(`Точка «${p.name}»: изделие не выбрано, в смету не попала`);
  }
  for (const e of project.extras) addDevice(e.sku, e.qty, e.note ?? '');

  const lines: EstimateLine[] = [];
  for (const [sku, { qty, basis }] of deviceQty) {
    const device = deviceBySku.get(sku);
    if (!device) {
      problems.push(`В каталоге нет изделия ${sku}`);
      continue;
    }
    lines.push({
      section: device.category === 'material' ? 'materials' : 'equipment',
      code: sku,
      name: device.name,
      unit: device.unit,
      qty,
      priceRub: device.priceRub,
      sumRub: round2(qty * device.priceRub),
      priceVerified: device.priceStatus === 'verified',
      basis: joinNames(basis),
    });
  }

  // ---- Работы ----
  const workQty = new Map<string, { qty: number; basis: string[] }>();
  const addWork = (id: string, qty: number, basis: string) => {
    if (qty <= 0) return;
    const entry = workQty.get(id) ?? { qty: 0, basis: [] };
    entry.qty += qty;
    if (basis) entry.basis.push(basis);
    workQty.set(id, entry);
  };

  for (const p of project.automationPoints) {
    if (p.function === 'connectivity') continue; // входит в настройку сети
    const rate = catalogs.works.find((w) => w.appliesTo.includes(p.function));
    if (rate) addWork(rate.id, 1, p.name);
    else problems.push(`Нет расценки на монтаж для функции ${p.function} (точка «${p.name}»)`);
  }

  const usedDevices = [...deviceQty].flatMap(([sku, { qty }]) => {
    const d = deviceBySku.get(sku);
    return d ? [{ device: d, qty }] : [];
  });
  const zigbeeCount = usedDevices
    .filter(({ device }) => device.protocol === 'zigbee' && device.category !== 'coordinator')
    .reduce((n, { qty }) => n + qty, 0);
  addWork('zigbee_network', zigbeeCount, 'устройства Zigbee');
  const espCount = usedDevices
    .filter(({ device }) => device.protocol === 'esphome' && device.category === 'controller')
    .reduce((n, { qty }) => n + qty, 0);
  addWork('esp_node', espCount, 'узлы ESPHome');
  addWork('scenario_setup', project.scenarios.length, 'сценарии проекта');
  addWork('ha_install', 1, '');
  if (project.site.internet.kind !== 'none') addWork('network_setup', 1, '');
  addWork('dashboard_setup', 1, '');
  addWork('commissioning', 1, '');
  for (const w of project.extraWorks) addWork(w.workId, w.qty, w.note ?? '');

  for (const [id, { qty, basis }] of workQty) {
    const rate = workById.get(id);
    if (!rate) {
      problems.push(`В справочнике нет расценки ${id}`);
      continue;
    }
    lines.push({
      section: 'works',
      code: id,
      name: rate.name,
      unit: rate.unit,
      qty,
      priceRub: rate.priceRub,
      sumRub: round2(qty * rate.priceRub),
      priceVerified: rate.priceStatus === 'verified',
      basis: joinNames(basis),
    });
  }

  // ---- Накладные ----
  const sum = (section: EstimateSection) => round2(lines.filter((l) => l.section === section).reduce((n, l) => n + l.sumRub, 0));
  const base = sum('equipment') + sum('materials') + sum('works');
  const overhead = (code: string, name: string, amount: number, basis: string) => {
    if (amount <= 0) return;
    lines.push({ section: 'overhead', code, name, unit: 'компл', qty: 1, priceRub: round2(amount), sumRub: round2(amount), priceVerified: true, basis });
  };
  overhead('travel', 'Выезды на объект', project.estimate.travelRub, 'задано в проекте');
  overhead('delivery', 'Доставка оборудования', project.estimate.deliveryRub, 'задано в проекте');
  overhead(
    'reserve',
    `Запас ${project.estimate.reservePercent} %`,
    (base * project.estimate.reservePercent) / 100,
    'от оборудования, материалов и работ',
  );

  const totals = {
    equipment: sum('equipment'),
    materials: sum('materials'),
    works: sum('works'),
    overhead: sum('overhead'),
    total: 0,
  };
  totals.total = round2(totals.equipment + totals.materials + totals.works + totals.overhead);

  const unverifiedLines = lines.filter((l) => !l.priceVerified);
  const unverifiedSum = unverifiedLines.reduce((n, l) => n + l.sumRub, 0);

  return {
    lines,
    totals,
    unverified: { lines: unverifiedLines.length, share: totals.total > 0 ? unverifiedSum / totals.total : 0 },
    problems,
  };
}

export const SECTION_LABELS: Record<EstimateSection, string> = {
  equipment: 'Оборудование',
  materials: 'Материалы',
  works: 'Работы',
  overhead: 'Накладные расходы',
};
