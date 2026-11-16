/** Собирает смету и конфигурацию HA для проекта: `npm run export -- <project.json> <папка>`. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DeviceCatalog, Project, ScenarioCatalog, WorkCatalog, computeEstimate, generateHaExport, validateProject } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const projectPath = resolve(process.env.INIT_CWD ?? '.', process.argv[2] ?? join(root, 'examples/dacha.json'));
const outDir = resolve(process.env.INIT_CWD ?? '.', process.argv[3] ?? join(root, 'out'));
const yaml = (path: string) => parse(readFileSync(join(root, path), 'utf8'));

const devices = DeviceCatalog.parse(yaml('catalog/devices.yaml')).devices;
const works = WorkCatalog.parse(yaml('catalog/works.yaml')).works;
const scenarios = ScenarioCatalog.parse(yaml('catalog/scenarios.yaml')).scenarios;
const project = Project.parse(JSON.parse(readFileSync(projectPath, 'utf8')));

const issues = validateProject(project, { devices, scenarios });
for (const i of issues) console.log(`${i.level === 'error' ? 'ОШИБКА' : 'замечание'} ${i.path}: ${i.message}`);
if (issues.some((i) => i.level === 'error')) process.exit(1);

const ha = generateHaExport(project, { devices, scenarios });
for (const [path, content] of Object.entries(ha.files)) {
  const file = join(outDir, 'homeassistant', path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
const estimate = computeEstimate(project, { devices, works });
writeFileSync(join(outDir, 'estimate.json'), JSON.stringify(estimate, null, 2));

console.log(`Файлов конфигурации: ${Object.keys(ha.files).length} → ${join(outDir, 'homeassistant')}`);
console.log(`Смета: ${estimate.totals.total.toLocaleString('ru-RU')} ₽ (оборудование ${estimate.totals.equipment}, материалы ${estimate.totals.materials}, работы ${estimate.totals.works}, накладные ${estimate.totals.overhead})`);
for (const n of [...ha.notes, ...estimate.problems]) console.log(`оговорка: ${n}`);
