import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DeviceCatalog, Project, ScenarioCatalog, WorkCatalog, validateProject } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const yaml = (path: string) => parse(readFileSync(root + path, 'utf8'));

const devices = DeviceCatalog.parse(yaml('catalog/devices.yaml')).devices;
const works = WorkCatalog.parse(yaml('catalog/works.yaml')).works;
const scenarios = ScenarioCatalog.parse(yaml('catalog/scenarios.yaml')).scenarios;
const dacha = () => Project.parse(JSON.parse(readFileSync(root + 'examples/dacha.json', 'utf8')));

describe('каталоги', () => {
  it('не содержат повторяющихся SKU и id', () => {
    expect(new Set(devices.map((d) => d.sku)).size).toBe(devices.length);
    expect(new Set(works.map((w) => w.id)).size).toBe(works.length);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
  });

  it('содержат восемь сценариев, и для каждой их функции есть изделие', () => {
    expect(scenarios).toHaveLength(8);
    const available = new Set(devices.flatMap((d) => d.functions));
    const needed = scenarios.flatMap((s) => s.requires.map((r) => r.function));
    expect(needed.filter((f) => !available.has(f))).toEqual([]);
  });

  it('для каждой функции изделий, требующей монтажа, есть расценка', () => {
    const priced = new Set(works.flatMap((w) => w.appliesTo));
    const needed = new Set(scenarios.flatMap((s) => s.requires.map((r) => r.function)));
    needed.delete('connectivity'); // настраивается в составе network_setup
    expect([...needed].filter((f) => !priced.has(f))).toEqual([]);
  });
});

describe('эталонная дача', () => {
  it('проходит схему и проверку связности без замечаний', () => {
    expect(validateProject(dacha(), { devices, scenarios })).toEqual([]);
  });

  it('использует все восемь сценариев каталога', () => {
    expect(new Set(dacha().scenarios.map((s) => s.templateId)).size).toBe(8);
  });
});

describe('validateProject', () => {
  it('ловит перегруз реле', () => {
    const p = dacha();
    p.utilityNodes.find((n) => n.id === 'gas_boiler')!.powerW = 6000;
    p.automationPoints.find((x) => x.id === 'boiler_power')!.deviceSku = 'contactor-25a';
    const issues = validateProject(p, { devices, scenarios });
    expect(issues.some((i) => i.level === 'error' && i.message.includes('6000'))).toBe(true);
  });

  it('ловит ссылку на несуществующее помещение и точку', () => {
    const p = dacha();
    p.automationPoints[0]!.roomId = 'nowhere';
    p.scenarios[0]!.bindings.heater = ['ghost'];
    const messages = validateProject(p, { devices, scenarios }).map((i) => i.message);
    expect(messages).toContain('Нет помещения nowhere');
    expect(messages.some((m) => m.includes('нет точки ghost'))).toBe(true);
  });

  it('ловит несоответствие функции точки роли сценария', () => {
    const p = dacha();
    p.scenarios.find((s) => s.id === 'leak')!.bindings.valve = ['pump_relay'];
    const issues = validateProject(p, { devices, scenarios });
    expect(issues.some((i) => i.message.includes('нужна valve'))).toBe(true);
  });
});
