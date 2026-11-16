import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DeviceCatalog, Project, ScenarioCatalog, WorkCatalog, computeEstimate, validateProject } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const yaml = (path: string) => parse(readFileSync(root + path, 'utf8'));
const devices = DeviceCatalog.parse(yaml('catalog/devices.yaml')).devices;
const works = WorkCatalog.parse(yaml('catalog/works.yaml')).works;
const scenarios = ScenarioCatalog.parse(yaml('catalog/scenarios.yaml')).scenarios;
const dacha = () => Project.parse(JSON.parse(readFileSync(root + 'examples/dacha.json', 'utf8')));

const base = {
  schemaVersion: 1,
  site: { name: 'Тест', occupancy: 'seasonal', power: { phases: 1, allocatedKw: 5 }, internet: { kind: 'none' } },
  buildings: [{ id: 'house', name: 'Дом', kind: 'house', floors: [{ id: 'f1', name: 'Этаж', level: 1, rooms: [{ id: 'room', name: 'Комната', kind: 'living', areaM2: 20 }] }] }],
};
const device = (sku: string, priceRub: number, extra: object = {}) =>
  ({ sku, name: sku, brand: 'X', category: 'sensor', functions: ['leak'], protocol: 'zigbee', power: 'battery', unit: 'шт', priceRub, priceDate: '2026-11-01', priceStatus: 'verified', ...extra }) as (typeof devices)[number];
const work = (id: string, priceRub: number, extra: object = {}) =>
  ({ id, name: id, unit: 'шт', priceRub, priceDate: '2026-11-01', priceStatus: 'verified', appliesTo: [], ...extra }) as (typeof works)[number];

describe('computeEstimate', () => {
  const catalogs = {
    devices: [device('leak', 1000), device('cable', 50, { category: 'material', functions: [], protocol: 'none', unit: 'м', priceStatus: 'estimate' })],
    works: [
      work('install_leak', 400, { appliesTo: ['leak'] }),
      work('zigbee_network', 150),
      work('scenario_setup', 1500),
      work('ha_install', 8000),
      work('network_setup', 4000),
      work('dashboard_setup', 5000),
      work('commissioning', 6000),
    ],
  };
  const project = Project.parse({
    ...base,
    automationPoints: [
      { id: 'leak_1', name: 'Протечка 1', role: 'sensor', function: 'leak', roomId: 'room', protocol: 'zigbee', deviceSku: 'leak' },
      { id: 'leak_2', name: 'Протечка 2', role: 'sensor', function: 'leak', roomId: 'room', protocol: 'zigbee', deviceSku: 'leak' },
    ],
    extras: [{ sku: 'cable', qty: 10 }],
    estimate: { reservePercent: 10, travelRub: 3000, deliveryRub: 500 },
  });
  const estimate = computeEstimate(project, catalogs);
  const line = (code: string) => estimate.lines.find((l) => l.code === code);

  it('складывает одинаковые изделия и делит оборудование и материалы', () => {
    expect(line('leak')).toMatchObject({ section: 'equipment', qty: 2, sumRub: 2000, basis: 'Протечка 1, Протечка 2' });
    expect(line('cable')).toMatchObject({ section: 'materials', qty: 10, sumRub: 500, priceVerified: false });
  });

  it('считает работы по правилам', () => {
    expect(line('install_leak')).toMatchObject({ qty: 2, sumRub: 800 });
    expect(line('zigbee_network')).toMatchObject({ qty: 2, sumRub: 300 });
    expect(line('scenario_setup')).toBeUndefined(); // сценариев нет
    expect(line('network_setup')).toBeUndefined(); // интернета нет
    expect(line('ha_install')?.qty).toBe(1);
  });

  it('считает итоги и запас', () => {
    // оборудование 2000, материалы 500, работы 800+300+8000+5000+6000 = 20100; база 22600; запас 2260
    expect(estimate.totals).toEqual({ equipment: 2000, materials: 500, works: 20100, overhead: 5760, total: 28360 });
    expect(line('reserve')?.sumRub).toBe(2260);
    expect(estimate.unverified).toEqual({ lines: 1, share: 500 / 28360 });
    expect(estimate.problems).toEqual([]);
  });

  it('сообщает о том, что не смог посчитать', () => {
    const broken = Project.parse({
      ...base,
      automationPoints: [
        { id: 'a', name: 'Без изделия', role: 'sensor', function: 'leak', roomId: 'room', protocol: 'zigbee' },
        { id: 'b', name: 'Дым', role: 'sensor', function: 'smoke', roomId: 'room', protocol: 'zigbee', deviceSku: 'ghost' },
      ],
      extraWorks: [{ workId: 'nope', qty: 1 }],
    });
    const problems = computeEstimate(broken, catalogs).problems;
    expect(problems).toContain('Точка «Без изделия»: изделие не выбрано, в смету не попала');
    expect(problems).toContain('В каталоге нет изделия ghost');
    expect(problems).toContain('Нет расценки на монтаж для функции smoke (точка «Дым»)');
    expect(problems).toContain('В справочнике нет расценки nope');
  });
});

describe('смета эталонной дачи', () => {
  it('считается без проблем, и сумма равна сумме строк', () => {
    const estimate = computeEstimate(dacha(), { devices, works });
    expect(estimate.problems).toEqual([]);
    const sum = estimate.lines.reduce((n, l) => n + l.sumRub, 0);
    expect(estimate.totals.total).toBeCloseTo(sum, 2);
    expect(estimate.totals.total).toBeGreaterThan(0);
  });

  it('проект проходит проверку вместе с дополнительным оборудованием', () => {
    expect(validateProject(dacha(), { devices, scenarios })).toEqual([]);
  });

  it('предупреждает, если нет координатора Zigbee', () => {
    const p = dacha();
    p.extras = p.extras.filter((e) => e.sku !== 'slzb-06');
    expect(validateProject(p, { devices, scenarios }).map((i) => i.message)).toContain('Есть устройства Zigbee, но нет координатора');
  });
});
