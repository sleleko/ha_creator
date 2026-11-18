import { useEffect, useMemo, useRef, useState } from 'react';
import { Project, autoLayout, findDataGaps, findWeakPoints, validateProject, type Diagram, type Finding, type Layer, type SiteCheck } from '@ha-creator/core';
import { download, today } from './catalog';
import { CommsDiagram, INK, lineStyle, type Selection } from './CommsDiagram';
import { project as repoProject } from './project';

const STORAGE_KEY = 'ha-creator:scheme-project';

const LAYER_LABELS: Record<Layer, string> = {
  water: 'Вода',
  heating: 'Отопление',
  electric: 'Электрика',
  network: 'Связь',
  sewage: 'Канализация',
  security: 'Охрана',
  garden: 'Участок',
};

const KIND_LABELS: Record<string, string> = {
  well_pump: 'Скважинный насос',
  well_head: 'Оголовок скважины',
  pressure_tank: 'Гидроаккумулятор',
  pressure_switch: 'Реле давления',
  filter: 'Фильтр',
  water_heater: 'Водонагреватель',
  inlet: 'Ввод воды',
  tee: 'Тройник',
  gas_boiler: 'Газовый котёл',
  electric_boiler: 'Электрокотёл отопления',
  radiator: 'Радиатор',
  panel: 'Щиток',
  socket: 'Розетка',
  router: 'Роутер',
  fiber_input: 'Ввод оптики',
};

const STATE_LABELS = { active: 'работает', off: 'выключен', drained: 'слит', shut: 'перекрыт' } as const;
const LAYING_LABELS = { underground: 'в земле', outdoor: 'снаружи', indoor: 'в помещении' } as const;
const fmt = (n: number) => String(n).replace('.', ',');

function loadSaved(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Project.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function save(p: Project | null) {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* хранилище недоступно — работаем без сохранения */
  }
}

/** Схема имеющихся коммуникаций: отрисовка из описания объекта, раскладка мышью, слабые места и проверки. */
export function SchemePage() {
  const [project, setProject] = useState<Project>(() => loadSaved() ?? repoProject);
  const [selection, setSelection] = useState<Selection>(null);
  const [focus, setFocus] = useState<Finding | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ kind: 'notice' | 'alert'; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const changed = project !== repoProject;
  useEffect(() => save(changed ? project : null), [project, changed]);

  const diagram = useMemo(() => project.diagram ?? autoLayout(project), [project]);
  const weak = useMemo(() => findWeakPoints(project), [project]);
  const gaps = useMemo(() => findDataGaps(project), [project]);
  const issues = useMemo(() => validateProject(project).filter((i) => i.level === 'error'), [project]);
  const problemNodes = useMemo(() => new Set(weak.filter((f) => f.id !== 'power_outage').flatMap((f) => f.nodeIds)), [weak]);
  const problemLines = useMemo(() => new Set(weak.flatMap((f) => f.lineIds)), [weak]);
  const tags = useMemo(() => new Map(weak.flatMap((f) => (f.tag ? f.nodeIds.map((id) => [id, f.tag!] as const) : []))), [weak]);
  const layers = useMemo(() => [...new Set([...project.utilityNodes.map((n) => n.layer), ...project.lines.map((l) => l.layer)])], [project]);

  const setDiagram = (d: Diagram) => setProject((p) => ({ ...p, diagram: d }));
  const setCheck = (id: string, patch: Partial<SiteCheck>) =>
    setProject((p) => ({ ...p, checks: p.checks.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  function downloadJson() {
    download(`project-${today()}.json`, new Blob([JSON.stringify(project, null, 2) + '\n'], { type: 'application/json' }));
  }

  function downloadSvg() {
    if (!svgRef.current) return;
    const xml = new XMLSerializer().serializeToString(svgRef.current);
    download(`kommunikacii-${today()}.svg`, new Blob([xml], { type: 'image/svg+xml' }));
  }

  async function openJson(file: File) {
    try {
      const parsed = Project.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        setMessage({ kind: 'alert', text: `Файл не похож на проект: ${first?.path.join('.')} — ${first?.message}` });
        return;
      }
      setProject(parsed.data);
      setSelection(null);
      setMessage({ kind: 'notice', text: `Загружен проект «${parsed.data.site.name}».` });
    } catch {
      setMessage({ kind: 'alert', text: 'Не удалось прочитать файл: нужен JSON проекта.' });
    }
  }

  function reset() {
    setProject(repoProject);
    setSelection(null);
    setMessage({ kind: 'notice', text: 'Вернул проект из репозитория: раскладка и ответы на проверки сброшены.' });
  }

  const unverified = project.checks.filter((c) => c.status === 'unverified').length;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Коммуникации: {project.site.name.toLowerCase()}</h1>
          <p className="muted">
            Вода, отопление и электрика в том виде, как они устроены сегодня. Узлы, зоны и подписи можно перетаскивать,
            щелчок показывает подробности. Слабые места программа находит сама по описанию объекта.
          </p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => fileRef.current?.click()}>Открыть JSON</button>
          <button className="btn" onClick={downloadSvg}>Скачать SVG</button>
          <button className="btn primary" onClick={downloadJson}>Скачать проект</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openJson(f);
            e.target.value = '';
          }} />
        </div>
      </div>

      {message && <div className={message.kind}>{message.text}</div>}
      {issues.length > 0 && (
        <div className="alert">
          В описании объекта есть ошибки, часть схемы может не отрисоваться:
          <ul>{issues.slice(0, 5).map((i) => <li key={i.path + i.message}>{i.message}</li>)}</ul>
        </div>
      )}

      <div className="toolbar">
        <div className="chips" role="group" aria-label="Слои">
          {layers.map((l) => (
            <button key={l} className={hidden.has(l) ? 'chip' : 'chip active'} aria-pressed={!hidden.has(l)} onClick={() => {
              const next = new Set(hidden);
              if (next.has(l)) next.delete(l);
              else next.add(l);
              setHidden(next);
            }}>
              {LAYER_LABELS[l]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {!project.diagram && <span className="muted small">Раскладка построена автоматически</span>}
        {changed && <button className="btn small-btn" onClick={reset}>Сбросить к версии из репозитория</button>}
      </div>

      <div className="scheme-wrap">
        <CommsDiagram
          ref={svgRef}
          project={project}
          diagram={diagram}
          problemNodes={problemNodes}
          problemLines={problemLines}
          tags={tags}
          focus={focus ? { nodes: new Set(focus.nodeIds), lines: new Set(focus.lineIds) } : null}
          hiddenLayers={hidden}
          selection={selection}
          onSelect={setSelection}
          onChange={setDiagram}
        />
      </div>

      {selection && <Details project={project} selection={selection} findings={[...weak, ...gaps]} onClose={() => setSelection(null)} />}

      <div className="scheme-panels">
        <section className="card">
          <h2>Обозначения</h2>
          <Legend project={project} />
        </section>

        <section className="card weak">
          <h2>Слабые места при включённой зимой воде</h2>
          {weak.length === 0 ? (
            <p className="muted">Не найдено.</p>
          ) : (
            <ul className="findings">
              {weak.map((f) => (
                <li key={f.id} onMouseEnter={() => setFocus(f)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(f)} onBlur={() => setFocus(null)} tabIndex={0}>
                  {f.text}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Проверьте, так ли это {unverified > 0 && <span className="count">{unverified} не проверено</span>}</h2>
          <ol className="checks">
            {project.checks.map((c) => (
              <li key={c.id} className={`check-item ${c.status}`}>
                <p>{c.text}</p>
                <div className="check-actions">
                  <button className={c.status === 'confirmed' ? 'chip active' : 'chip'} onClick={() => setCheck(c.id, { status: c.status === 'confirmed' ? 'unverified' : 'confirmed' })}>Верно</button>
                  <button className={c.status === 'wrong' ? 'chip active' : 'chip'} onClick={() => setCheck(c.id, { status: c.status === 'wrong' ? 'unverified' : 'wrong' })}>Не так</button>
                </div>
                {c.status === 'wrong' && (
                  <textarea className="answer" placeholder="Как на самом деле?" value={c.answer ?? ''} onChange={(e) => setCheck(c.id, { answer: e.target.value })} rows={2} />
                )}
              </li>
            ))}
          </ol>
          {gaps.length > 0 && (
            <>
              <h3 className="small muted">Программа заметила пробелы</h3>
              <ul className="findings">{gaps.map((g) => <li key={g.id}>{g.text}</li>)}</ul>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function Legend({ project }: { project: Project }) {
  const items: { key: string; label: string; sample: JSX.Element }[] = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, sample: JSX.Element) => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ key, label, sample });
  };
  const stroke = (color: string, width: number, dash?: string) => (
    <svg width="40" height="12" aria-hidden><line x1="2" x2="38" y1="6" y2="6" stroke={color} strokeWidth={width} strokeDasharray={dash} /></svg>
  );
  for (const l of project.lines) {
    const st = lineStyle(l);
    const off = l.state && l.state !== 'active';
    const name = off ? `${LAYER_LABELS[l.layer]} (перекрыто)` : l.layer === 'electric' ? 'Питание' : l.layer === 'heating' ? 'Отопление' : l.layer === 'water' ? 'Холодная вода' : LAYER_LABELS[l.layer];
    add(`${l.layer}-${off ? 'off' : 'on'}`, name, stroke(st.color, st.width, st.dash));
    if (l.heatTrace) add('trace', 'Греющий кабель', stroke(INK.trace, 2, '2 3'));
  }
  if (project.buildings.some((b) => b.heated === false) || project.buildings.some((b) => b.floors.some((f) => f.rooms.some((r) => !r.heated))))
    add('cold', 'Неотапливаемое помещение', stroke(INK.frame, 1.3, '5 4'));
  if (project.lines.some((l) => l.fittings.length)) {
    const valve = (closed: boolean) => (
      <svg width="40" height="14" aria-hidden><line x1="2" x2="38" y1="7" y2="7" stroke={INK.water} strokeWidth={3} /><path d="M12 1 L28 13 L28 1 L12 13 Z" fill={closed ? INK.frame : '#fff'} stroke={INK.frame} strokeWidth={1.4} /></svg>
    );
    add('valve-open', 'Кран открыт', valve(false));
    add('valve-closed', 'Кран закрыт', valve(true));
  }
  add('problem', 'Узел под угрозой', <svg width="40" height="16" aria-hidden><rect x="4" y="2" width="32" height="12" rx="3" fill={INK.problemFill} stroke={INK.problem} strokeWidth={1.6} /></svg>);
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.key}><span className="legend-sample">{i.sample}</span>{i.label}</li>
      ))}
    </ul>
  );
}

function Details({ project, selection, findings, onClose }: { project: Project; selection: NonNullable<Selection>; findings: Finding[]; onClose: () => void }) {
  const nodeName = (id: string) => project.utilityNodes.find((n) => n.id === id)?.name ?? id;
  const roomName = (id: string) => project.buildings.flatMap((b) => b.floors.flatMap((f) => f.rooms)).find((r) => r.id === id)?.name ?? id;
  let title = '';
  const rows: [string, string][] = [];
  let related: Finding[] = [];

  if (selection.type === 'node') {
    const n = project.utilityNodes.find((x) => x.id === selection.id);
    if (!n) return null;
    title = [n.name, n.notes].filter(Boolean).join(' · ');
    rows.push(['Тип', KIND_LABELS[n.kind] ?? n.kind], ['Слой', LAYER_LABELS[n.layer]], ['Помещение', roomName(n.roomId)]);
    if (n.state) rows.push(['Состояние', STATE_LABELS[n.state]]);
    if (n.powerW !== undefined) rows.push(['Мощность', `${n.powerW} Вт`]);
    if (n.poweredByNodeId) rows.push(['Питание от', nodeName(n.poweredByNodeId)]);
    const conn = project.lines.filter((l) => l.fromNodeId === n.id || l.toNodeId === n.id);
    if (conn.length) rows.push(['Связи', conn.map((l) => (l.fromNodeId === n.id ? `→ ${nodeName(l.toNodeId)}` : `← ${nodeName(l.fromNodeId)}`)).join(', ')]);
    const points = project.automationPoints.filter((p) => p.nodeId === n.id);
    if (points.length) rows.push(['Автоматизация', points.map((p) => p.name).join(', ')]);
    related = findings.filter((f) => f.nodeIds.includes(n.id));
  } else if (selection.type === 'line') {
    const l = project.lines.find((x) => x.id === selection.id);
    if (!l) return null;
    title = l.name ?? `${nodeName(l.fromNodeId)} → ${nodeName(l.toNodeId)}`;
    rows.push(['Откуда — куда', `${nodeName(l.fromNodeId)} → ${nodeName(l.toNodeId)}`], ['Слой', LAYER_LABELS[l.layer]], ['Длина', `${fmt(l.lengthM)} м`]);
    if (l.spec) rows.push(['Материал', l.spec]);
    if (l.laying) rows.push(['Прокладка', LAYING_LABELS[l.laying] + (l.depthM !== undefined ? `, глубина ${fmt(l.depthM)} м` : '')]);
    if (l.insulated !== undefined) rows.push(['Утеплитель', l.insulated ? 'есть' : 'нет']);
    if (l.heatTrace !== undefined) rows.push(['Греющий кабель', l.heatTrace ? 'есть' : 'нет']);
    if (l.state) rows.push(['Состояние', STATE_LABELS[l.state]]);
    for (const f of l.fittings) {
      rows.push([f.kind === 'drain' ? 'Сливной кран' : f.kind === 'check_valve' ? 'Обратный клапан' : 'Запорный кран', f.state === 'closed' ? 'закрыт' : 'открыт']);
    }
    related = findings.filter((f) => f.lineIds.includes(l.id));
  } else {
    const b = project.buildings.find((x) => x.id === selection.id);
    const r = project.buildings.flatMap((x) => x.floors.flatMap((f) => f.rooms)).find((x) => x.id === selection.id);
    const z = b ?? r;
    if (!z) return null;
    title = z.name;
    if (z.notes) rows.push(['Пометка', z.notes]);
    if (r) rows.push(['Площадь', `${fmt(r.areaM2)} м²`], ['Отопление', r.heated ? 'есть' : 'нет']);
    if (b) rows.push(['Отопление', b.heated === false ? 'нет' : 'есть']);
    const ids = b ? b.floors.flatMap((f) => f.rooms.map((x) => x.id)) : [r!.id];
    const nodes = project.utilityNodes.filter((n) => ids.includes(n.roomId));
    if (nodes.length) rows.push(['Оборудование', nodes.map((n) => n.name).join(', ')]);
  }

  return (
    <section className="card details" aria-live="polite">
      <div className="details-head">
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>×</button>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k + v}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      {related.length > 0 && <ul className="findings weak-inline">{related.map((f) => <li key={f.id}>{f.text}</li>)}</ul>}
      <p className="muted small">Правка свойств пока идёт через JSON проекта: «Скачать проект» → правка → «Открыть JSON».</p>
    </section>
  );
}
