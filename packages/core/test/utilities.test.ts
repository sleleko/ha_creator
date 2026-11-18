import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Project, autoLayout, findDataGaps, findWeakPoints, labelAnchor, offsetPolyline, pointAt, routeLine, validateProject } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dacha = () => Project.parse(JSON.parse(readFileSync(root + 'examples/dacha.json', 'utf8')));

describe('слабые места дачи', () => {
  it('совпадают с пятью пунктами со схемы владельца', () => {
    const texts = findWeakPoints(dacha()).map((f) => f.text);
    expect(texts).toEqual([
      'Фильтр, реле давления и гидроаккумулятор в неотапливаемом помещении (баня).',
      'Труба к бане на 0,5 м: держится только на греющем кабеле.',
      'Труба в туалет бани идёт снаружи: зимой держится только на закрытом кране и сливе.',
      'Электрокотёл (баня) без крана: при подаче воды наполнится.',
      'При отключении света встают насос, котёл и кабель одновременно.',
    ]);
  });

  it('помечает электрокотёл бани меткой «нет крана», а котёл туалета с краном — нет', () => {
    const tagged = findWeakPoints(dacha()).filter((f) => f.tag === 'нет крана').flatMap((f) => f.nodeIds);
    expect(tagged).toEqual(['sauna_water_heater']);
  });

  it('исчезают, когда проблему устранили', () => {
    const p = dacha();
    p.buildings.find((b) => b.id === 'sauna')!.heated = true;
    p.buildings.find((b) => b.id === 'sauna')!.floors[0]!.rooms[0]!.heated = true;
    p.site.power.backup = 'generator';
    const pipe = p.lines.find((l) => l.id === 'l_head_sauna')!;
    pipe.depthM = 1.6;
    const ids = findWeakPoints(p).map((f) => f.id);
    expect(ids).toEqual(['outdoor_l_tee_wc']);
  });

  it('без греющего кабеля мелкая труба замёрзнет', () => {
    const p = dacha();
    p.lines.find((l) => l.id === 'l_head_sauna')!.heatTrace = false;
    expect(findWeakPoints(p).some((f) => f.text.includes('выше промерзания (1,4 м): замёрзнет'))).toBe(true);
  });

  it('перекрытая линия не считается слабым местом', () => {
    const p = dacha();
    p.lines.find((l) => l.id === 'l_tee_wc')!.state = 'drained';
    expect(findWeakPoints(p).some((f) => f.id === 'outdoor_l_tee_wc')).toBe(false);
  });

  it('пробелов в данных у дачи нет, а труба без глубины и насос без питания замечаются', () => {
    const p = dacha();
    expect(findDataGaps(p)).toEqual([]);
    delete p.lines.find((l) => l.id === 'l_head_house')!.depthM;
    delete p.utilityNodes.find((n) => n.id === 'well_pump')!.poweredByNodeId;
    expect(findDataGaps(p).map((f) => f.id)).toEqual(['depth_l_head_house', 'power_well_pump']);
  });
});

describe('схема дачи', () => {
  it('раскладка ссылается только на существующие постройки, узлы и линии', () => {
    const issues = validateProject(dacha()).filter((i) => i.path.startsWith('diagram'));
    expect(issues).toEqual([]);
  });

  it('на схеме стоит каждый узел дачи', () => {
    const p = dacha();
    const placed = new Set(Object.keys(p.diagram!.nodes));
    expect(p.utilityNodes.map((n) => n.id).filter((id) => !placed.has(id))).toEqual([]);
  });

  it('несуществующий узел в раскладке даёт предупреждение', () => {
    const p = dacha();
    p.diagram!.nodes.ghost = { x: 0, y: 0 };
    expect(validateProject(p).some((i) => i.level === 'warning' && i.message.includes('ghost'))).toBe(true);
  });

  it('раскладка по умолчанию ставит все узлы, у которых есть помещение', () => {
    const p = dacha();
    const layout = autoLayout(p);
    expect(Object.keys(layout.nodes).sort()).toEqual(p.utilityNodes.map((n) => n.id).sort());
    expect(layout.zones.house).toBeDefined();
  });
});

describe('геометрия линий', () => {
  it('без промежуточных точек линия идёт углом и обрезается по краям узлов', () => {
    const pts = routeLine({ x: 0, y: 0 }, { x: 100, y: 50 }, [], { x: -10, y: -10, w: 20, h: 20 }, { x: 90, y: 40, w: 20, h: 20 });
    expect(pts).toEqual([{ x: 10, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }]);
  });

  it('находит точку по доле длины и подпись на самом длинном отрезке', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }];
    expect(pointAt(pts, 0.5)).toMatchObject({ x: 60, y: 0, angle: 0 });
    expect(labelAnchor(pts)).toEqual({ x: 50, y: 0, horizontal: true });
  });

  it('сдвигает ломаную вбок с прямыми углами', () => {
    const pts = offsetPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], 4);
    expect(pts).toEqual([{ x: 0, y: 4 }, { x: 96, y: 4 }, { x: 96, y: 50 }]);
  });
});
