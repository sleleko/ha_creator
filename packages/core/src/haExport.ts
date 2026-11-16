import { stringify } from 'yaml';
import type { AutomationPoint, Device, PointFunction, Project, ScenarioTemplate } from './schema.js';

/** Домен сущности Home Assistant для каждой функции точки. */
export const ENTITY_DOMAIN: Record<PointFunction, string> = {
  temperature: 'sensor',
  humidity: 'sensor',
  leak: 'binary_sensor',
  motion: 'binary_sensor',
  door: 'binary_sensor',
  smoke: 'binary_sensor',
  power_meter: 'sensor',
  voltage: 'sensor',
  water_pressure: 'sensor',
  relay: 'switch',
  contactor: 'switch',
  valve: 'switch',
  thermostat: 'climate',
  dimmer: 'light',
  siren: 'siren',
  camera: 'camera',
  irrigation_valve: 'switch',
  light_level: 'sensor',
  soil_moisture: 'sensor',
  connectivity: 'binary_sensor',
};

/** Имя сущности, на которое ссылаются автоматизации. Устройство после сопряжения нужно переименовать так же. */
export const entityId = (point: Pick<AutomationPoint, 'id' | 'function'>): string => `${ENTITY_DOMAIN[point.function]}.${point.id}`;

export interface EntityRow {
  entityId: string;
  pointName: string;
  room: string;
  device: string;
  protocol: string;
  note: string;
}

export interface HaExport {
  /** Путь внутри архива → содержимое файла. */
  files: Record<string, string>;
  entities: EntityRow[];
  /** Что генератор не смог сделать или сделал с оговоркой. */
  notes: string[];
}

export interface HaExportOptions {
  /** Действие для уведомлений, например notify.mobile_app_iphone. */
  notifyAction?: string;
}

export interface HaExportCatalogs {
  devices: Device[];
  scenarios: ScenarioTemplate[];
}

type Yaml = Record<string, unknown>;
type Package = Record<string, Yaml | Yaml[]>;

const AWAY = 'input_boolean.hc_away';
const DEFAULTS_APPLIED = 'input_boolean.hc_defaults_applied';
const HEADER = '# Создано программой ha_creator. Не правьте вручную: изменения потеряются при следующем экспорте.\n';

const toYaml = (data: unknown): string => HEADER + stringify(data, { lineWidth: 0, version: '1.1' });

function merge(target: Package, source: Package): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (Array.isArray(value)) target[key] = [...(Array.isArray(current) ? current : []), ...value];
    else target[key] = { ...((current as Yaml | undefined) ?? {}), ...value };
  }
}

export function generateHaExport(project: Project, catalogs: HaExportCatalogs, options: HaExportOptions = {}): HaExport {
  const notifyAction = options.notifyAction ?? 'notify.notify';
  const notes: string[] = [];
  const pointById = new Map(project.automationPoints.map((p) => [p.id, p]));
  const deviceBySku = new Map(catalogs.devices.map((d) => [d.sku, d]));
  const templateById = new Map(catalogs.scenarios.map((s) => [s.id, s]));
  const roomName = new Map(project.buildings.flatMap((b) => b.floors.flatMap((f) => f.rooms.map((r) => [r.id, r.name] as const))));

  const notify = (title: string, message: string): Yaml => ({ action: notifyAction, data: { title, message } });
  const ids = (pointIds: string[] | undefined): string[] =>
    (pointIds ?? []).flatMap((id) => {
      const p = pointById.get(id);
      return p ? [entityId(p)] : [];
    });

  /** Значения параметров по умолчанию: выставляются один раз при первом запуске, потом их меняют с панели. */
  const defaults: { entity: string; value: number | string | boolean }[] = [];
  const packages = new Map<string, Package>();
  const scenarioHelpers = new Map<string, string[]>();
  const pkg = (name: string): Package => {
    if (!packages.has(name)) packages.set(name, {});
    return packages.get(name)!;
  };

  // ---------- Общий пакет ----------
  merge(pkg('hc_common'), {
    input_boolean: {
      hc_away: { name: 'Никого нет', icon: 'mdi:home-export-outline' },
      hc_defaults_applied: { name: 'Параметры сценариев установлены', icon: 'mdi:check' },
    },
  });

  // ---------- Отопление: один термостат на каждый набор нагревателей ----------
  interface Heating { key: string; heaters: string[]; temps: Set<string>; climate: string; minSensor: string }
  const heatings = new Map<string, Heating>();
  const heatingFor = (heaterPoints: string[], tempPoints: string[]): Heating | undefined => {
    const heaters = ids(heaterPoints);
    if (heaters.length === 0) return undefined;
    const key = [...heaterPoints].sort().join('_');
    let h = heatings.get(key);
    if (!h) {
      h = { key, heaters, temps: new Set(), climate: `climate.hc_heating_${key}`, minSensor: `sensor.hc_heating_${key}_min_temp` };
      heatings.set(key, h);
    }
    for (const t of ids(tempPoints)) h.temps.add(t);
    return h;
  };

  // ---------- Сценарии ----------
  for (const s of project.scenarios) {
    const template = templateById.get(s.templateId);
    if (!template) {
      notes.push(`Сценарий ${s.id}: шаблона ${s.templateId} нет в каталоге, пропущен`);
      continue;
    }
    const name = `hc_${s.id}`;
    const p = pkg(name);
    const helpers: string[] = [];
    scenarioHelpers.set(s.id, helpers);
    const param = (key: string): number | string | boolean => {
      const value = s.params[key] ?? template.params.find((x) => x.key === key)?.default;
      if (value === undefined) throw new Error(`Сценарий ${s.templateId}: нет параметра ${key}`);
      return value;
    };
    const label = (key: string) => template.params.find((x) => x.key === key)?.label ?? key;
    const number = (key: string, min: number, max: number, step: number, unit: string): string => {
      const object = `${name}_${key}`;
      merge(p, { input_number: { [object]: { name: `${template.name}: ${label(key)}`, min, max, step, unit_of_measurement: unit, mode: 'box' } } });
      const entity = `input_number.${object}`;
      defaults.push({ entity, value: param(key) });
      helpers.push(entity);
      return entity;
    };
    const automation = (key: string, alias: string, body: Yaml): void =>
      merge(p, { automation: [{ id: `${name}_${key}`, alias: `${template.name}: ${alias}`, ...body }] });
    const b = s.bindings;

    switch (s.templateId) {
      case 'frost_protection': {
        const heating = heatingFor(b.heater ?? [], b.temperature ?? []);
        if (!heating) break;
        const standby = number('standby_temp', 3, 15, 0.5, '°C');
        const alarm = number('alarm_temp', 0, 10, 0.5, '°C');
        automation('standby', 'дежурный обогрев при отъезде', {
          triggers: [{ trigger: 'state', entity_id: AWAY, to: 'on' }],
          actions: [
            { action: 'climate.set_hvac_mode', target: { entity_id: heating.climate }, data: { hvac_mode: 'heat' } },
            { action: 'climate.set_temperature', target: { entity_id: heating.climate }, data: { temperature: `{{ states('${standby}') | float(7) }}` } },
          ],
        });
        automation('alarm', 'тревога по низкой температуре', {
          triggers: [{ trigger: 'numeric_state', entity_id: [...heating.temps], below: alarm, for: { minutes: 10 } }],
          actions: [notify('Дом остывает', '{{ trigger.to_state.name }}: {{ trigger.to_state.state }} °C. Проверьте отопление и питание.')],
          mode: 'queued',
        });
        break;
      }

      case 'preheat_arrival': {
        const heating = heatingFor(b.heater ?? [], b.temperature ?? []);
        if (!heating) break;
        const comfort = number('comfort_temp', 15, 26, 0.5, '°C');
        const lead = number('lead_hours', 1, 48, 1, 'ч');
        merge(p, {
          input_datetime: { [`${name}_arrival`]: { name: `${template.name}: время приезда`, has_date: true, has_time: true } },
          input_boolean: { [`${name}_enabled`]: { name: `${template.name}: включён`, icon: 'mdi:radiator' } },
        });
        const arrival = `input_datetime.${name}_arrival`;
        const enabled = `input_boolean.${name}_enabled`;
        helpers.unshift(enabled, arrival);
        automation('start', 'начать прогрев', {
          triggers: [
            {
              trigger: 'template',
              value_template:
                `{{ is_state('${enabled}', 'on') and has_value('${arrival}') and ` +
                `now() >= (states('${arrival}') | as_datetime | as_local) - timedelta(hours=states('${lead}') | float(6)) }}`,
            },
          ],
          actions: [
            { action: 'climate.set_hvac_mode', target: { entity_id: heating.climate }, data: { hvac_mode: 'heat' } },
            { action: 'climate.set_temperature', target: { entity_id: heating.climate }, data: { temperature: `{{ states('${comfort}') | float(21) }}` } },
            { action: 'input_boolean.turn_off', target: { entity_id: enabled } },
            notify('Прогрев начат', `Дом прогревается до {{ states('${comfort}') }} °C к приезду.`),
          ],
        });
        break;
      }

      case 'leak_protection': {
        const leaks = ids(b.leak);
        const shutoff = [...ids(b.valve), ...ids(b.pump)];
        automation('shutoff', 'перекрыть воду', {
          triggers: [{ trigger: 'state', entity_id: leaks, to: 'on' }],
          actions: [
            { action: 'switch.turn_off', target: { entity_id: shutoff } },
            notify('Протечка', '{{ trigger.to_state.name }}: обнаружена вода. Кран закрыт, насос отключён.'),
          ],
          mode: 'queued',
        });
        if (param('auto_reopen') === true) {
          automation('reopen', 'открыть воду после высыхания', {
            triggers: [{ trigger: 'state', entity_id: leaks, to: 'off', for: { minutes: 30 } }],
            conditions: leaks.map((entity_id) => ({ condition: 'state', entity_id, state: 'off' })),
            actions: [
              { action: 'switch.turn_on', target: { entity_id: shutoff } },
              notify('Вода включена', 'Датчики протечки сухие 30 минут, кран открыт.'),
            ],
          });
        }
        break;
      }

      case 'power_watch': {
        const voltage = ids(b.voltage);
        const min = number('min_voltage', 150, 220, 1, 'В');
        const max = number('max_voltage', 230, 280, 1, 'В');
        automation('low', 'низкое напряжение', {
          triggers: [{ trigger: 'numeric_state', entity_id: voltage, below: min, for: { minutes: 1 } }],
          actions: [notify('Низкое напряжение', '{{ trigger.to_state.name }}: {{ trigger.to_state.state }} В.')],
        });
        automation('high', 'высокое напряжение', {
          triggers: [{ trigger: 'numeric_state', entity_id: voltage, above: max, for: { minutes: 1 } }],
          actions: [notify('Высокое напряжение', '{{ trigger.to_state.name }}: {{ trigger.to_state.state }} В.')],
        });
        automation('lost', 'нет данных о напряжении', {
          triggers: [{ trigger: 'state', entity_id: voltage, to: 'unavailable', for: { minutes: 2 } }],
          actions: [notify('Нет данных о питании', '{{ trigger.to_state.name }} не отвечает. Возможно, отключили электричество.')],
        });
        automation('restored', 'питание восстановлено', {
          triggers: [{ trigger: 'state', entity_id: voltage, from: 'unavailable' }],
          conditions: [{ condition: 'template', value_template: "{{ trigger.to_state.state not in ['unknown', 'unavailable'] }}" }],
          actions: [notify('Питание восстановлено', '{{ trigger.to_state.name }}: {{ trigger.to_state.state }} В.')],
        });
        const links = ids(b.link);
        if (links.length > 0) {
          automation('link_lost', 'связь потеряна', {
            triggers: [{ trigger: 'state', entity_id: links, to: 'off', for: { minutes: 5 } }],
            actions: [notify('Нет интернета', '{{ trigger.to_state.name }}: связь потеряна более 5 минут назад.')],
          });
          automation('link_restored', 'связь восстановлена', {
            triggers: [{ trigger: 'state', entity_id: links, from: 'off', to: 'on' }],
            actions: [notify('Интернет восстановлен', '{{ trigger.to_state.name }}: связь есть.')],
          });
          notes.push('Контроль связи: уведомление о потере интернета уйдёт только после его восстановления, если нет запасного канала.');
        }
        break;
      }

      case 'security_away': {
        const sensors = [...ids(b.door), ...ids(b.motion)];
        const sirens = ids(b.siren);
        const delay = number('entry_delay', 0, 120, 5, 'с');
        automation('alarm', 'тревога при проникновении', {
          triggers: [{ trigger: 'state', entity_id: sensors, to: 'on' }],
          conditions: [{ condition: 'state', entity_id: AWAY, state: 'on' }],
          actions: [
            { delay: { seconds: `{{ states('${delay}') | int(30) }}` } },
            { condition: 'state', entity_id: AWAY, state: 'on' },
            ...(sirens.length ? [{ action: 'siren.turn_on', target: { entity_id: sirens } }] : []),
            notify('Тревога', '{{ trigger.to_state.name }}: сработал датчик, пока дома никого нет.'),
            ...(sirens.length ? [{ delay: { minutes: 3 } }, { action: 'siren.turn_off', target: { entity_id: sirens } }] : []),
          ],
          mode: 'single',
        });
        if (sirens.length) {
          automation('disarm', 'выключить сирену при снятии с охраны', {
            triggers: [{ trigger: 'state', entity_id: AWAY, to: 'off' }],
            actions: [{ action: 'siren.turn_off', target: { entity_id: sirens } }],
          });
        }
        break;
      }

      case 'fire_alarm': {
        const sirens = ids(b.siren);
        const loads = ids(b.load);
        automation('alarm', 'дым', {
          triggers: [{ trigger: 'state', entity_id: ids(b.smoke), to: 'on' }],
          actions: [
            ...(sirens.length ? [{ action: 'siren.turn_on', target: { entity_id: sirens } }] : []),
            ...(loads.length ? [{ action: 'switch.turn_off', target: { entity_id: loads } }] : []),
            notify('Пожарная тревога', '{{ trigger.to_state.name }}: обнаружен дым.'),
          ],
          mode: 'queued',
        });
        break;
      }

      case 'irrigation': {
        const valves = ids(b.valve);
        const soil = ids(b.soil);
        const duration = number('duration_min', 1, 120, 1, 'мин');
        merge(p, {
          input_datetime: { [`${name}_start`]: { name: `${template.name}: ${label('start_time')}`, has_date: false, has_time: true } },
          input_boolean: { [`${name}_enabled`]: { name: `${template.name}: включён`, icon: 'mdi:sprinkler-variant' } },
        });
        const start = `input_datetime.${name}_start`;
        const enabled = `input_boolean.${name}_enabled`;
        defaults.push({ entity: start, value: String(param('start_time')) }, { entity: enabled, value: true });
        helpers.unshift(enabled, start);
        const conditions: Yaml[] = [{ condition: 'state', entity_id: enabled, state: 'on' }];
        if (soil.length > 0) {
          const threshold = number('soil_threshold', 10, 90, 5, '%');
          conditions.push({ condition: 'numeric_state', entity_id: soil, below: threshold });
        }
        automation('run', 'полив по расписанию', {
          triggers: [{ trigger: 'time', at: start }],
          conditions,
          actions: valves.flatMap((entity_id) => [
            { action: 'switch.turn_on', target: { entity_id } },
            { delay: { minutes: `{{ states('${duration}') | int(20) }}` } },
            { action: 'switch.turn_off', target: { entity_id } },
          ]),
          mode: 'single',
        });
        automation('failsafe', 'закрыть забытый клапан', {
          triggers: [{ trigger: 'state', entity_id: valves, to: 'on', for: { hours: 3 } }],
          actions: [
            { action: 'switch.turn_off', target: { entity_id: '{{ trigger.entity_id }}' } },
            notify('Полив остановлен', '{{ trigger.to_state.name }} был открыт больше трёх часов и закрыт принудительно.'),
          ],
          mode: 'queued',
        });
        break;
      }

      case 'pump_protection': {
        const pressure = ids(b.pressure);
        const maxRun = number('max_run_min', 5, 180, 5, 'мин');
        for (const pumpId of b.pump ?? []) {
          const point = pointById.get(pumpId);
          if (!point) continue;
          const device = point.deviceSku ? deviceBySku.get(point.deviceSku) : undefined;
          if (!device?.functions.includes('power_meter')) {
            notes.push(`Защита насоса «${point.name}»: реле без учёта энергии, отключение по времени непрерывной работы не создано.`);
            continue;
          }
          const power = `sensor.${point.id}_power`;
          automation(`overrun_${point.id}`, `долгая работа: ${point.name}`, {
            triggers: [
              {
                trigger: 'template',
                value_template: `{{ states('${power}') | float(0) > 100 }}`,
                for: { minutes: `{{ states('${maxRun}') | int(30) }}` },
              },
            ],
            actions: [
              { action: 'switch.turn_off', target: { entity_id: entityId(point) } },
              notify('Насос отключён', `${point.name} работал без остановки дольше {{ states('${maxRun}') }} мин. Проверьте, нет ли утечки или сухого хода.`),
            ],
          });
        }
        if (pressure.length > 0) {
          const min = number('min_pressure', 0.2, 6, 0.1, 'бар');
          automation('low_pressure', 'низкое давление', {
            triggers: [{ trigger: 'numeric_state', entity_id: pressure, below: min, for: { minutes: 5 } }],
            actions: [notify('Низкое давление воды', '{{ trigger.to_state.name }}: {{ trigger.to_state.state }} бар.')],
          });
        }
        break;
      }

      default:
        notes.push(`Сценарий ${s.id}: для шаблона ${s.templateId} генератор ещё не написан`);
    }
  }

  // ---------- Пакеты отопления ----------
  for (const h of heatings.values()) {
    const name = `hc_heating_${h.key}`;
    let heater = h.heaters[0]!;
    const p = pkg(name);
    if (h.heaters.length > 1) {
      merge(p, { switch: [{ platform: 'group', name: `${name} heaters`, unique_id: `${name}_heaters`, entities: h.heaters }] });
      heater = `switch.${name}_heaters`;
    }
    merge(p, {
      sensor: [{ platform: 'min_max', name: `${name} min temp`, unique_id: `${name}_min_temp`, type: 'min', round_digits: 1, entity_ids: [...h.temps] }],
      climate: [
        {
          platform: 'generic_thermostat',
          name,
          unique_id: name,
          heater,
          target_sensor: h.minSensor,
          min_temp: 3,
          max_temp: 28,
          cold_tolerance: 0.5,
          hot_tolerance: 0.5,
          min_cycle_duration: { minutes: 5 },
          precision: 0.5,
        },
      ],
      homeassistant: {
        customize: {
          [h.climate]: { friendly_name: 'Отопление' },
          [h.minSensor]: { friendly_name: 'Самая низкая температура в доме' },
        },
      },
    });
  }

  // ---------- Однократная установка значений параметров ----------
  if (defaults.length > 0) {
    merge(pkg('hc_common'), {
      automation: [
        {
          id: 'hc_apply_defaults',
          alias: 'ha_creator: установить параметры сценариев при первом запуске',
          triggers: [{ trigger: 'homeassistant', event: 'start' }],
          conditions: [{ condition: 'state', entity_id: DEFAULTS_APPLIED, state: 'off' }],
          actions: [
            ...defaults.map(({ entity, value }): Yaml => {
              if (entity.startsWith('input_number.')) return { action: 'input_number.set_value', target: { entity_id: entity }, data: { value } };
              if (entity.startsWith('input_datetime.')) return { action: 'input_datetime.set_datetime', target: { entity_id: entity }, data: { time: `${value}:00` } };
              return { action: value ? 'input_boolean.turn_on' : 'input_boolean.turn_off', target: { entity_id: entity } };
            }),
            { action: 'input_boolean.turn_on', target: { entity_id: DEFAULTS_APPLIED } },
          ],
        },
      ],
    });
  }

  // ---------- Таблица сущностей ----------
  const entities: EntityRow[] = project.automationPoints.map((point) => {
    const device = point.deviceSku ? deviceBySku.get(point.deviceSku) : undefined;
    return {
      entityId: entityId(point),
      pointName: point.name,
      room: roomName.get(point.roomId) ?? point.roomId,
      device: device ? `${device.brand} ${device.name}` : 'не выбрано',
      protocol: point.protocol,
      note: '',
    };
  });
  for (const s of project.scenarios) {
    if (s.templateId !== 'pump_protection') continue;
    for (const pumpId of s.bindings.pump ?? []) {
      const point = pointById.get(pumpId);
      const device = point?.deviceSku ? deviceBySku.get(point.deviceSku) : undefined;
      if (point && device?.functions.includes('power_meter')) {
        entities.push({
          entityId: `sensor.${point.id}_power`,
          pointName: `${point.name}: мощность`,
          room: roomName.get(point.roomId) ?? point.roomId,
          device: `${device.brand} ${device.name}`,
          protocol: point.protocol,
          note: 'датчик мощности того же устройства, в ваттах',
        });
      }
    }
  }

  // ---------- Панель ----------
  const views: Yaml[] = [
    {
      title: 'Обзор',
      path: 'overview',
      icon: 'mdi:home',
      cards: [
        { type: 'entities', title: 'Режим', entities: [AWAY] },
        ...[...heatings.values()].map((h) => ({ type: 'thermostat', entity: h.climate })),
        ...[...heatings.values()].map((h) => ({ type: 'entities', title: 'Температура', entities: [h.minSensor, ...h.temps] })),
      ],
    },
    ...project.buildings.flatMap((building): Yaml[] => {
      const cards = building.floors.flatMap((f) =>
        f.rooms.flatMap((room) => {
          const list = project.automationPoints.filter((x) => x.roomId === room.id);
          return list.length ? [{ type: 'entities', title: room.name, entities: list.map((x) => ({ entity: entityId(x), name: x.name })) }] : [];
        }),
      );
      return cards.length ? [{ title: building.name, path: building.id, cards }] : [];
    }),
    {
      title: 'Сценарии',
      path: 'scenarios',
      icon: 'mdi:robot',
      cards: project.scenarios.flatMap((s) => {
        const list = scenarioHelpers.get(s.id) ?? [];
        return list.length ? [{ type: 'entities', title: templateById.get(s.templateId)?.name ?? s.id, entities: list }] : [];
      }),
    },
  ];

  // ---------- Файлы ----------
  const files: Record<string, string> = {};
  for (const [name, content] of packages) files[`packages/${name}.yaml`] = toYaml(content);
  files['dashboards/ha_creator.yaml'] = toYaml({ title: project.site.name, views });
  files['configuration.snippet.yaml'] =
    '# Добавьте эти строки в configuration.yaml. Если раздел homeassistant: уже есть, допишите в него только packages.\n' +
    stringify({
      homeassistant: { packages: '!include_dir_named packages' },
      lovelace: { dashboards: { 'ha-creator': { mode: 'yaml', title: project.site.name, icon: 'mdi:home-automation', show_in_sidebar: true, filename: 'dashboards/ha_creator.yaml' } } },
    }, { version: '1.1' }).replace("'!include_dir_named packages'", '!include_dir_named packages').replace('"!include_dir_named packages"', '!include_dir_named packages');
  files['README.md'] = readme(project, entities, notes, notifyAction);

  return { files, entities, notes };
}

function readme(project: Project, entities: EntityRow[], notes: string[], notifyAction: string): string {
  const rows = entities.map((e) => `| \`${e.entityId}\` | ${e.pointName} | ${e.room} | ${e.device} | ${e.protocol} | ${e.note} |`).join('\n');
  return `# Конфигурация Home Assistant: ${project.site.name}

## Установка

1. Скопируйте папки \`packages\` и \`dashboards\` в папку конфигурации Home Assistant (рядом с \`configuration.yaml\`).
2. Добавьте в \`configuration.yaml\` строки из файла \`configuration.snippet.yaml\`.
3. Подключите устройства и переименуйте их сущности так, как указано в таблице ниже. Автоматизации ссылаются именно на эти имена.
4. Проверьте конфигурацию: «Инструменты разработчика → YAML → Проверить конфигурацию», затем перезапустите Home Assistant.
5. При первом запуске параметры сценариев получат значения из проекта. Дальше их можно менять на панели, вкладка «Сценарии».

## Что нужно знать

- Уведомления отправляются действием \`${notifyAction}\`. Чтобы они приходили на телефон, установите приложение Home Assistant и замените действие на \`notify.mobile_app_<имя телефона>\` при экспорте.
- Режим «Никого нет» (\`input_boolean.hc_away\`) включает охрану и дежурный обогрев. Его включают вручную с панели.
- Кран и клапаны считаются открытыми, когда выключатель включён. Если у вашего привода наоборот, поменяйте логику в устройстве.
- Давление воды ожидается в барах, напряжение в вольтах, температура в градусах Цельсия.
${notes.length ? `\n## Оговорки генератора\n\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
## Сущности

| Сущность | Точка | Помещение | Устройство | Протокол | Примечание |
| --- | --- | --- | --- | --- | --- |
${rows}
`;
}
