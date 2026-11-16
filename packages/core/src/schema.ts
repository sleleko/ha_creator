import { z } from 'zod';

/** Идентификатор: латиница, цифры, подчёркивание. Из него строятся entity_id в Home Assistant. */
export const Id = z.string().regex(/^[a-z][a-z0-9_]*$/, 'id: латиница в нижнем регистре, цифры и _');

export const Protocol = z.enum(['zigbee', 'wifi', 'esphome', 'modbus', 'ethernet', 'wired', 'none']);
export type Protocol = z.infer<typeof Protocol>;

/** Слои схемы коммуникаций. */
export const Layer = z.enum(['electric', 'water', 'heating', 'sewage', 'network', 'security', 'garden']);
export type Layer = z.infer<typeof Layer>;

export const Point2D = z.object({ x: z.number(), y: z.number() });

export const Room = z.object({
  id: Id,
  name: z.string().min(1),
  kind: z.enum(['living', 'bedroom', 'kitchen', 'bathroom', 'hall', 'technical', 'veranda', 'sauna', 'storage', 'outdoor']),
  areaM2: z.number().positive(),
  heated: z.boolean().default(true),
  /** Контур помещения на плане этажа, метры. Необязателен до появления редактора. */
  outline: z.array(Point2D).min(3).optional(),
});
export type Room = z.infer<typeof Room>;

export const Floor = z.object({
  id: Id,
  name: z.string().min(1),
  level: z.number().int(),
  rooms: z.array(Room).min(1),
});

export const Building = z.object({
  id: Id,
  name: z.string().min(1),
  kind: z.enum(['house', 'sauna', 'shed', 'garage', 'yard']),
  floors: z.array(Floor).min(1),
});

export const Site = z.object({
  name: z.string().min(1),
  region: z.string().optional(),
  occupancy: z.enum(['permanent', 'seasonal', 'weekends']),
  power: z.object({
    phases: z.union([z.literal(1), z.literal(3)]),
    allocatedKw: z.number().positive(),
    backup: z.enum(['none', 'ups', 'generator']).default('none'),
  }),
  internet: z.object({
    kind: z.enum(['lte', 'fiber', 'radio', 'none']),
    staticIp: z.boolean().default(false),
  }),
  haServer: z.enum(['undecided', 'raspberry_pi', 'mini_pc', 'ha_green', 'existing']).default('undecided'),
});

/** Узел имеющихся коммуникаций: щит, котёл, насос, кран, розеточная группа и т. п. */
export const UtilityNode = z.object({
  id: Id,
  name: z.string().min(1),
  layer: Layer,
  kind: z.string().min(1),
  roomId: Id,
  position: Point2D.optional(),
  /** Электрическая мощность нагрузки, Вт (для подбора реле и контакторов). */
  powerW: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});
export type UtilityNode = z.infer<typeof UtilityNode>;

/** Линия между двумя узлами: кабель, труба, линия связи. */
export const Line = z.object({
  id: Id,
  layer: Layer,
  fromNodeId: Id,
  toNodeId: Id,
  lengthM: z.number().positive(),
  existing: z.boolean().default(true),
  spec: z.string().optional(),
});

export const PointFunction = z.enum([
  'temperature', 'humidity', 'leak', 'motion', 'door', 'smoke', 'power_meter', 'voltage', 'water_pressure',
  'relay', 'contactor', 'valve', 'thermostat', 'dimmer', 'siren', 'camera', 'irrigation_valve', 'light_level',
  'soil_moisture', 'connectivity',
]);
export type PointFunction = z.infer<typeof PointFunction>;

/** Точка автоматизации: датчик или исполнитель. В экспорте становится entity. */
export const AutomationPoint = z.object({
  id: Id,
  name: z.string().min(1),
  role: z.enum(['sensor', 'actuator']),
  function: PointFunction,
  roomId: Id,
  /** Узел коммуникаций, которым точка управляет или который измеряет. */
  nodeId: Id.optional(),
  protocol: Protocol,
  /** SKU из каталога комплектующих; пусто — подобрать автоматически. */
  deviceSku: z.string().optional(),
  position: Point2D.optional(),
});
export type AutomationPoint = z.infer<typeof AutomationPoint>;

export const ScenarioInstance = z.object({
  id: Id,
  /** id шаблона из catalog/scenarios.yaml */
  templateId: Id,
  /** Соответствие «роль в шаблоне → id точек проекта». */
  bindings: z.record(z.string(), z.array(Id).min(1)),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
});

export const Project = z.object({
  schemaVersion: z.literal(1),
  site: Site,
  buildings: z.array(Building).min(1),
  utilityNodes: z.array(UtilityNode).default([]),
  lines: z.array(Line).default([]),
  automationPoints: z.array(AutomationPoint).default([]),
  scenarios: z.array(ScenarioInstance).default([]),
  /** Оборудование и материалы вне точек автоматизации: сервер, координатор, ИБП, кабель, боксы. */
  extras: z.array(z.object({ sku: z.string().min(1), qty: z.number().positive(), note: z.string().optional() })).default([]),
  /** Работы сверх тех, что считаются автоматически. */
  extraWorks: z.array(z.object({ workId: Id, qty: z.number().positive(), note: z.string().optional() })).default([]),
  estimate: z
    .object({
      reservePercent: z.number().min(0).max(50).default(10),
      travelRub: z.number().nonnegative().default(0),
      deliveryRub: z.number().nonnegative().default(0),
    })
    .default({}),
});
export type Project = z.infer<typeof Project>;

// ---------- Каталоги ----------

export const Device = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().min(1),
  category: z.enum(['server', 'coordinator', 'sensor', 'actuator', 'controller', 'power', 'network', 'camera', 'material']),
  functions: z.array(PointFunction).default([]),
  protocol: Protocol,
  power: z.enum(['battery', 'mains', 'usb', 'dc', 'poe', 'none']),
  /** Максимальная коммутируемая нагрузка, Вт (для реле и контакторов). */
  maxLoadW: z.number().positive().optional(),
  unit: z.enum(['шт', 'м', 'компл']).default('шт'),
  priceRub: z.number().nonnegative(),
  /** Дата, на которую цена актуальна, YYYY-MM-DD. */
  priceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** verified — цена сверена с магазином; estimate — ориентир, требует проверки. */
  priceStatus: z.enum(['verified', 'estimate']),
  source: z.string().optional(),
  haIntegration: z.string().optional(),
  notes: z.string().optional(),
});
export type Device = z.infer<typeof Device>;

export const WorkRate = z.object({
  id: Id,
  name: z.string().min(1),
  unit: z.enum(['шт', 'м', 'час', 'компл', 'выезд']),
  priceRub: z.number().nonnegative(),
  priceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  priceStatus: z.enum(['verified', 'estimate']),
  /** К каким функциям точек расценка применяется автоматически. */
  appliesTo: z.array(PointFunction).default([]),
  source: z.string().optional(),
  notes: z.string().optional(),
});
export type WorkRate = z.infer<typeof WorkRate>;

export const ScenarioTemplate = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().min(1),
  /** Роли, которые сценарию нужны: какие функции точек и сколько минимум. */
  requires: z.array(
    z.object({
      role: z.string().min(1),
      function: PointFunction,
      min: z.number().int().nonnegative().default(1),
      note: z.string().optional(),
    }),
  ).min(1),
  params: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      default: z.union([z.number(), z.string(), z.boolean()]),
      unit: z.string().optional(),
    }),
  ).default([]),
});
export type ScenarioTemplate = z.infer<typeof ScenarioTemplate>;

export const DeviceCatalog = z.object({ devices: z.array(Device).min(1) });
export const WorkCatalog = z.object({ works: z.array(WorkRate).min(1) });
export const ScenarioCatalog = z.object({ scenarios: z.array(ScenarioTemplate).min(1) });
