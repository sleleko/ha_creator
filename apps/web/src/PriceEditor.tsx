import { useEffect, useMemo, useState } from 'react';
import { parsePrice } from '@ha-creator/core';
import {
  KIND_LABELS,
  STALE_DAYS,
  applyPatches,
  download,
  formatDate,
  formatRub,
  isStale,
  loadRepoCatalog,
  loadSavedCatalog,
  saveCatalog,
  toRows,
  toYaml,
  today,
  type Catalog,
  type Kind,
  type PricePatch,
  type PriceRow,
  type PriceStatus,
} from './catalog';
import { exportXlsx } from './excel';
import { ImportDialog } from './ImportDialog';

type StatusFilter = 'all' | 'estimate' | 'verified' | 'stale' | 'changed';

const repoCatalog = loadRepoCatalog();

function PriceInput({ value, label, onCommit }: { value: number; label: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parsePrice(draft) === null;

  function commit() {
    if (draft === null) return;
    const parsed = parsePrice(draft);
    if (parsed !== null && parsed !== value) onCommit(parsed);
    setDraft(null);
  }

  return (
    <input
      className={`price-input${invalid ? ' invalid' : ''}`}
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid}
      value={draft ?? formatRub(value)}
      onFocus={(e) => { setDraft(String(value)); requestAnimationFrame(() => e.target.select()); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setDraft(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); }
      }}
    />
  );
}

function SourceInput({ value, label, onCommit }: { value: string; label: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="source-input"
      aria-label={label}
      placeholder="магазин или ссылка"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

export function PriceEditor() {
  const [catalog, setCatalog] = useState<Catalog>(() => loadSavedCatalog(repoCatalog));
  const [kind, setKind] = useState<Kind>('devices');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    saveCatalog(catalog === repoCatalog ? null : catalog);
  }, [catalog]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const rows = useMemo(() => toRows(catalog, kind), [catalog, kind]);
  const original = useMemo(() => new Map(toRows(repoCatalog, kind).map((r) => [r.key, r])), [kind]);
  const now = today();

  const isChanged = (r: PriceRow) => {
    const o = original.get(r.key);
    return !o || o.priceRub !== r.priceRub || o.priceStatus !== r.priceStatus || o.source !== r.source || o.priceDate !== r.priceDate;
  };

  const counts = useMemo(() => ({
    all: rows.length,
    verified: rows.filter((r) => r.priceStatus === 'verified').length,
    estimate: rows.filter((r) => r.priceStatus === 'estimate').length,
    stale: rows.filter((r) => isStale(r.priceDate, now)).length,
    changed: rows.filter(isChanged).length,
  }), [rows, original, now]);

  const groups = useMemo(() => [...new Set(rows.map((r) => r.group))], [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (group && r.group !== group) return false;
      if (status === 'estimate' && r.priceStatus !== 'estimate') return false;
      if (status === 'verified' && r.priceStatus !== 'verified') return false;
      if (status === 'stale' && !isStale(r.priceDate, now)) return false;
      if (status === 'changed' && !isChanged(r)) return false;
      return !q || r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q) || r.source.toLowerCase().includes(q);
    });
  }, [rows, query, group, status, original, now]);

  const total = visible.reduce((sum, r) => sum + r.priceRub, 0);

  function patch(key: string, p: PricePatch) {
    setCatalog((c) => applyPatches(c, kind, new Map([[key, p]])));
  }

  function switchKind(next: Kind) {
    setKind(next);
    setGroup('');
    setStatus('all');
    setQuery('');
  }

  function resetAll() {
    if (!window.confirm('Сбросить все правки цен в комплектующих и работах и вернуться к каталогу из репозитория?')) return;
    setCatalog(repoCatalog);
    setNotice('Правки сброшены.');
  }

  async function downloadXlsx() {
    const blob = await exportXlsx(rows, KIND_LABELS[kind]);
    download(`${kind === 'devices' ? 'komplektuyushchie' : 'raboty'}-${now}.xlsx`, blob);
  }

  const filters: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'all', label: 'Все', count: counts.all },
    { id: 'estimate', label: 'Ориентир', count: counts.estimate },
    { id: 'verified', label: 'Проверено', count: counts.verified },
    { id: 'stale', label: `Старше ${STALE_DAYS} дней`, count: counts.stale },
    { id: 'changed', label: 'Изменено мной', count: counts.changed },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Редактор цен</h1>
          <p className="muted">
            Правки сохраняются в этом браузере. Чтобы они попали в проект, скачайте YAML и замените файл в папке <code>catalog</code>.
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setImportOpen(true)}>Импорт из Excel</button>
          <button className="btn" onClick={() => void downloadXlsx()}>Скачать Excel</button>
          <button className="btn" onClick={() => download(`${kind}.yaml`, toYaml(catalog, kind))}>Скачать YAML</button>
        </div>
      </header>

      <div className="tabs" role="tablist">
        {(['devices', 'works'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'tab active' : 'tab'} onClick={() => switchKind(k)}>
            {KIND_LABELS[k]} <span className="count">{k === 'devices' ? catalog.devices.length : catalog.works.length}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Поиск по названию, артикулу, источнику"
          aria-label="Поиск"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {groups.length > 1 && (
          <select aria-label="Категория" value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Все категории</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <div className="chips">
          {filters.map((f) => (
            <button key={f.id} className={status === f.id ? 'chip active' : 'chip'} aria-pressed={status === f.id} onClick={() => setStatus(f.id)}>
              {f.label} <span className="count">{f.count}</span>
            </button>
          ))}
        </div>
      </div>

      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Позиция</th>
              {kind === 'devices' && <th>Категория</th>}
              <th>Ед.</th>
              <th className="num">Цена, ₽</th>
              <th>Статус</th>
              <th>Дата цены</th>
              <th>Источник</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const o = original.get(r.key);
              const priceChanged = o !== undefined && o.priceRub !== r.priceRub;
              const stale = isStale(r.priceDate, now);
              return (
                <tr key={r.key} className={isChanged(r) ? 'changed' : ''}>
                  <td>
                    <div>{r.name}</div>
                    <div className="muted small">{r.key}</div>
                  </td>
                  {kind === 'devices' && <td className="muted">{r.group}</td>}
                  <td className="muted">{r.unit}</td>
                  <td className="num">
                    <PriceInput
                      value={r.priceRub}
                      label={`Цена: ${r.name}`}
                      onCommit={(v) => patch(r.key, { priceRub: v, priceDate: now, priceStatus: 'verified' })}
                    />
                    {priceChanged && <div className="small muted">было {formatRub(o.priceRub)}</div>}
                  </td>
                  <td>
                    <select
                      className={`status ${r.priceStatus}`}
                      aria-label={`Статус: ${r.name}`}
                      value={r.priceStatus}
                      onChange={(e) => {
                        const next = e.target.value as PriceStatus;
                        patch(r.key, next === 'verified' ? { priceStatus: next, priceDate: now } : { priceStatus: next });
                      }}
                    >
                      <option value="estimate">ориентир</option>
                      <option value="verified">проверено</option>
                    </select>
                  </td>
                  <td className={stale ? 'warn' : 'muted'}>
                    {formatDate(r.priceDate)}
                    {stale && <div className="small">устарела</div>}
                  </td>
                  <td>
                    <SourceInput value={r.source} label={`Источник: ${r.name}`} onCommit={(v) => patch(r.key, { source: v })} />
                  </td>
                  <td>
                    {(r.priceStatus === 'estimate' || stale) && (
                      <button
                        className="btn small-btn"
                        title="Цена верна на сегодня"
                        onClick={() => patch(r.key, { priceStatus: 'verified', priceDate: now })}
                      >
                        Подтвердить
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={8} className="empty">Ничего не найдено. Измените поиск или фильтр.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="page-foot">
        <span className="muted">
          Показано {visible.length} из {rows.length} · сумма цен показанных позиций: {formatRub(total)} ₽
        </span>
        <button className="btn danger" onClick={resetAll} disabled={catalog === repoCatalog}>Сбросить правки</button>
      </footer>

      {importOpen && (
        <ImportDialog
          rows={rows}
          kindLabel={KIND_LABELS[kind]}
          onClose={() => setImportOpen(false)}
          onApply={(patches) => {
            setCatalog((c) => applyPatches(c, kind, patches));
            setImportOpen(false);
            setStatus('changed');
            setNotice(`Импорт применён: обновлено позиций — ${patches.size}.`);
          }}
        />
      )}
    </div>
  );
}
