import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DeviceCatalog, Project, ScenarioCatalog, entityId, generateHaExport } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const yaml = (path: string) => parse(readFileSync(root + path, 'utf8'));
const devices = DeviceCatalog.parse(yaml('catalog/devices.yaml')).devices;
const scenarios = ScenarioCatalog.parse(yaml('catalog/scenarios.yaml')).scenarios;
const dacha = () => Project.parse(JSON.parse(readFileSync(root + 'examples/dacha.json', 'utf8')));
const result = generateHaExport(dacha(), { devices, scenarios });
// Home Assistant читает YAML 1.1, поэтому и проверяем как 1.1.
const pkg = (name: string) => parse(result.files[`packages/${name}.yaml`]!, { version: '1.1' });

/** Все строки вида domain.object_id в значении, включая вложенные и шаблоны. */
function referencedEntities(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\b(sensor|binary_sensor|switch|climate|siren|camera|light|input_number|input_boolean|input_datetime)\.[a-z0-9_]+/g)) out.add(m[0]);
  } else if (Array.isArray(value)) value.forEach((v) => referencedEntities(v, out));
  else if (value && typeof value === 'object') {
    // Ключ action — это имя действия (switch.turn_off), а не сущность.
    for (const [k, v] of Object.entries(value)) if (k !== 'action') referencedEntities(v, out);
  }
  return out;
}

describe('generateHaExport для дачи', () => {
  it('создаёт пакет на каждый сценарий, общий пакет, отопление, панель и инструкцию', () => {
    expect(Object.keys(result.files).sort()).toEqual([
      'README.md',
      'configuration.snippet.yaml',
      'dashboards/ha_creator.yaml',
      'packages/hc_common.yaml',
      'packages/hc_fire.yaml',
      'packages/hc_frost.yaml',
      'packages/hc_heating_boiler_power.yaml',
      'packages/hc_leak.yaml',
      'packages/hc_power.yaml',
      'packages/hc_preheat.yaml',
      'packages/hc_pump.yaml',
      'packages/hc_security.yaml',
      'packages/hc_watering.yaml',
    ]);
  });

  it('пишет состояния on и off строками, а не булевыми значениями YAML 1.1', () => {
    const leak = pkg('hc_leak');
    expect(leak.automation[0].triggers[0].to).toBe('on');
    expect(result.files['packages/hc_leak.yaml']).toContain('to: "on"');
    expect(pkg('hc_security').automation[0].conditions[0].state).toBe('on');
  });

  it('ссылается только на сущности точек проекта и на собственные помощники', () => {
    const known = new Set<string>(result.entities.map((e) => e.entityId));
    const packages = Object.keys(result.files).filter((f) => f.startsWith('packages/')).map((f) => parse(result.files[f]!, { version: '1.1' }));
    for (const p of packages) {
      for (const domain of ['input_number', 'input_boolean', 'input_datetime']) {
        for (const object of Object.keys(p[domain] ?? {})) known.add(`${domain}.${object}`);
      }
      for (const c of p.climate ?? []) known.add(`climate.${c.unique_id}`);
      for (const s of p.sensor ?? []) known.add(`sensor.${s.unique_id}`);
    }
    const all = [...packages, parse(result.files['dashboards/ha_creator.yaml']!, { version: '1.1' })];
    const unknown = [...referencedEntities(all)].filter((e) => !known.has(e));
    expect(unknown).toEqual([]);
  });

  it('даёт уникальные id автоматизаций', () => {
    const idsList = Object.keys(result.files)
      .filter((f) => f.startsWith('packages/'))
      .flatMap((f) => (parse(result.files[f]!, { version: '1.1' }).automation ?? []).map((a: { id: string }) => a.id));
    expect(new Set(idsList).size).toBe(idsList.length);
    expect(idsList.length).toBe(18);
  });

  it('делает один термостат на котёл для антизамерзания и прогрева', () => {
    const heating = pkg('hc_heating_boiler_power');
    expect(heating.climate).toHaveLength(1);
    expect(heating.climate[0]).toMatchObject({ heater: 'switch.boiler_power', target_sensor: 'sensor.hc_heating_boiler_power_min_temp' });
    expect(heating.sensor[0].entity_ids).toEqual(['sensor.t_living', 'sensor.t_upstairs', 'sensor.t_veranda', 'sensor.t_water_inlet']);
    expect(JSON.stringify(pkg('hc_preheat'))).toContain('climate.hc_heating_boiler_power');
  });

  it('перекрывает кран и насос при протечке', () => {
    const action = pkg('hc_leak').automation[0].actions[0];
    expect(action).toEqual({ action: 'switch.turn_off', target: { entity_id: ['switch.valve_main', 'switch.pump_relay'] } });
  });

  it('выставляет параметры сценариев один раз при первом запуске', () => {
    const init = pkg('hc_common').automation[0];
    expect(init.conditions[0]).toEqual({ condition: 'state', entity_id: 'input_boolean.hc_defaults_applied', state: 'off' });
    expect(init.actions).toContainEqual({ action: 'input_number.set_value', target: { entity_id: 'input_number.hc_frost_standby_temp' }, data: { value: 7 } });
    expect(init.actions.at(-1)).toEqual({ action: 'input_boolean.turn_on', target: { entity_id: 'input_boolean.hc_defaults_applied' } });
  });

  it('перечисляет все точки в таблице сущностей и в инструкции', () => {
    const p = dacha();
    for (const point of p.automationPoints) expect(result.files['README.md']).toContain(`\`${entityId(point)}\``);
    expect(result.entities.map((e) => e.entityId)).toContain('sensor.pump_relay_power');
  });

  it('подставляет своё действие уведомления', () => {
    const custom = generateHaExport(dacha(), { devices, scenarios }, { notifyAction: 'notify.mobile_app_phone' });
    expect(custom.files['packages/hc_fire.yaml']).toContain('action: notify.mobile_app_phone');
    expect(custom.files['packages/hc_fire.yaml']).not.toContain('notify.notify');
  });

  it('честно сообщает, если защиту насоса по времени сделать нельзя', () => {
    const p = dacha();
    p.automationPoints.find((x) => x.id === 'pump_relay')!.deviceSku = 'sonoff-zbminil2';
    const r = generateHaExport(p, { devices, scenarios });
    expect(r.notes.some((n) => n.includes('реле без учёта энергии'))).toBe(true);
    expect(r.files['packages/hc_pump.yaml']).not.toContain('overrun');
  });
});
