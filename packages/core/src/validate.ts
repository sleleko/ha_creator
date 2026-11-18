import type { Device, Project, ScenarioTemplate } from './schema.js';

export interface Issue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

export interface Catalogs {
  devices: Device[];
  scenarios: ScenarioTemplate[];
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/** Проверки связности проекта, которые не выражаются схемой: ссылки, дубли, соответствие каталогам. */
export function validateProject(project: Project, catalogs?: Catalogs): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });

  const rooms = project.buildings.flatMap((b) => b.floors.flatMap((f) => f.rooms));
  const roomIds = new Set(rooms.map((r) => r.id));
  const nodeIds = new Set(project.utilityNodes.map((n) => n.id));
  const pointById = new Map(project.automationPoints.map((p) => [p.id, p]));

  for (const [what, ids] of [
    ['помещений', rooms.map((r) => r.id)],
    ['узлов', project.utilityNodes.map((n) => n.id)],
    ['линий', project.lines.map((l) => l.id)],
    ['точек', project.automationPoints.map((p) => p.id)],
    ['сценариев', project.scenarios.map((s) => s.id)],
  ] as const) {
    for (const id of duplicates([...ids])) err(id, `Повторяющийся id среди ${what}: ${id}`);
  }

  for (const n of project.utilityNodes) {
    if (!roomIds.has(n.roomId)) err(`utilityNodes.${n.id}`, `Нет помещения ${n.roomId}`);
  }
  for (const l of project.lines) {
    if (!nodeIds.has(l.fromNodeId)) err(`lines.${l.id}`, `Нет узла ${l.fromNodeId}`);
    if (!nodeIds.has(l.toNodeId)) err(`lines.${l.id}`, `Нет узла ${l.toNodeId}`);
    if (l.depthM !== undefined && l.laying !== 'underground') warn(`lines.${l.id}`, 'Глубина указана у линии, проложенной не в земле');
  }
  for (const id of duplicates(project.lines.flatMap((l) => l.fittings.map((f) => f.id)))) err(id, `Повторяющийся id среди кранов: ${id}`);
  for (const id of duplicates(project.checks.map((c) => c.id))) err(id, `Повторяющийся id среди проверок: ${id}`);
  for (const n of project.utilityNodes) {
    if (n.poweredByNodeId && !nodeIds.has(n.poweredByNodeId)) err(`utilityNodes.${n.id}`, `Нет узла питания ${n.poweredByNodeId}`);
  }

  if (project.diagram) {
    const zoneIds = new Set([...project.buildings.map((b) => b.id), ...roomIds]);
    const lineIds = new Set(project.lines.map((l) => l.id));
    for (const id of Object.keys(project.diagram.zones)) if (!zoneIds.has(id)) warn(`diagram.zones.${id}`, `На схеме зона ${id}, которой нет среди построек и помещений`);
    for (const id of Object.keys(project.diagram.nodes)) if (!nodeIds.has(id)) warn(`diagram.nodes.${id}`, `На схеме узел ${id}, которого нет в проекте`);
    for (const id of [...Object.keys(project.diagram.waypoints), ...Object.keys(project.diagram.labels)]) {
      if (!lineIds.has(id)) warn(`diagram.lines.${id}`, `На схеме линия ${id}, которой нет в проекте`);
    }
  }

  const deviceBySku = new Map((catalogs?.devices ?? []).map((d) => [d.sku, d]));
  const nodeById = new Map(project.utilityNodes.map((n) => [n.id, n]));
  for (const p of project.automationPoints) {
    const path = `automationPoints.${p.id}`;
    if (!roomIds.has(p.roomId)) err(path, `Нет помещения ${p.roomId}`);
    if (p.nodeId && !nodeIds.has(p.nodeId)) err(path, `Нет узла ${p.nodeId}`);
    if (!p.deviceSku || !catalogs) continue;
    const device = deviceBySku.get(p.deviceSku);
    if (!device) {
      err(path, `В каталоге нет изделия ${p.deviceSku}`);
      continue;
    }
    if (!device.functions.includes(p.function)) {
      err(path, `Изделие ${device.sku} не выполняет функцию ${p.function}`);
    }
    if (device.protocol !== p.protocol) {
      warn(path, `Протокол точки (${p.protocol}) не совпадает с протоколом изделия (${device.protocol})`);
    }
    const load = p.nodeId ? nodeById.get(p.nodeId)?.powerW : undefined;
    if (load !== undefined && device.maxLoadW !== undefined && load > device.maxLoadW) {
      err(path, `Нагрузка ${load} Вт больше допустимой для ${device.sku} (${device.maxLoadW} Вт)`);
    }
  }

  if (catalogs) {
    const extras = project.extras.flatMap((e) => {
      const device = deviceBySku.get(e.sku);
      if (!device) err(`extras.${e.sku}`, `В каталоге нет изделия ${e.sku}`);
      return device ? [device] : [];
    });
    const used = (protocol: string) => project.automationPoints.some((p) => p.protocol === protocol);
    if (!extras.some((d) => d.category === 'server') && project.site.haServer !== 'existing') {
      warn('extras', 'В проекте нет сервера Home Assistant');
    }
    if (used('zigbee') && !extras.some((d) => d.category === 'coordinator' && d.protocol === 'zigbee')) {
      warn('extras', 'Есть устройства Zigbee, но нет координатора');
    }
    if ((used('esphome') || used('wired')) && !extras.some((d) => d.category === 'controller')) {
      warn('extras', 'Есть проводные датчики или ESPHome, но нет контроллера, к которому они подключаются');
    }
  }

  const templateById = new Map((catalogs?.scenarios ?? []).map((s) => [s.id, s]));
  for (const s of project.scenarios) {
    const path = `scenarios.${s.id}`;
    for (const [role, ids] of Object.entries(s.bindings)) {
      for (const id of ids) if (!pointById.has(id)) err(path, `Роль ${role}: нет точки ${id}`);
    }
    if (!catalogs) continue;
    const template = templateById.get(s.templateId);
    if (!template) {
      err(path, `В каталоге нет сценария ${s.templateId}`);
      continue;
    }
    for (const req of template.requires) {
      const bound = s.bindings[req.role] ?? [];
      if (bound.length < req.min) {
        err(path, `Роль ${req.role}: нужно точек не меньше ${req.min}, привязано ${bound.length}`);
      }
      for (const id of bound) {
        const point = pointById.get(id);
        if (point && point.function !== req.function) {
          err(path, `Роль ${req.role}: точка ${id} имеет функцию ${point.function}, нужна ${req.function}`);
        }
      }
    }
    for (const role of Object.keys(s.bindings)) {
      if (!template.requires.some((r) => r.role === role)) warn(path, `Лишняя роль ${role}`);
    }
  }

  return issues;
}
