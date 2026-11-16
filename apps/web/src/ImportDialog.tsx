import { useEffect, useMemo, useRef, useState } from 'react';
import { detectColumns, findHeaderRow, matchPriceRows, type Cell, type ColumnMapping } from '@ha-creator/core';
import { formatRub, today, type PricePatch, type PriceRow } from './catalog';
import { readTableFile, type SheetTable } from './excel';

interface Props {
  rows: PriceRow[];
  kindLabel: string;
  onApply: (patches: Map<string, PricePatch>) => void;
  onClose: () => void;
}

const FIELDS: { field: keyof ColumnMapping; label: string; hint: string }[] = [
  { field: 'sku', label: 'Артикул', hint: 'по нему ищем позицию в каталоге' },
  { field: 'name', label: 'Название', hint: 'запасной способ, если артикула нет' },
  { field: 'price', label: 'Цена', hint: 'обязательно' },
  { field: 'source', label: 'Источник', hint: 'магазин или ссылка, необязательно' },
];

const columnLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`);
const cellText = (c: Cell) => (c == null ? '' : c instanceof Date ? c.toLocaleDateString('ru-RU') : String(c));

/** Изменение больше чем в полтора раза чаще всего значит, что выбрана не та колонка или не та позиция. */
const isSuspicious = (oldPrice: number, newPrice: number) =>
  oldPrice > 0 && (newPrice > oldPrice * 1.5 || newPrice < oldPrice / 1.5);

export function ImportDialog({ rows, kindLabel, onApply, onClose }: Props) {
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<SheetTable[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const table = sheets[sheetIndex]?.rows ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function selectSheet(all: SheetTable[], index: number) {
    const data = all[index]?.rows ?? [];
    const header = findHeaderRow(data);
    setSheetIndex(index);
    setHeaderRow(header);
    setMapping(detectColumns(data[header] ?? []));
    setExcluded(new Set());
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const all = await readTableFile(file);
      if (all.length === 0) throw new Error('В файле нет данных.');
      setFileName(file.name);
      setSheets(all);
      selectSheet(all, 0);
    } catch (e) {
      setSheets([]);
      setError(e instanceof Error ? e.message : 'Не удалось прочитать файл.');
    } finally {
      setBusy(false);
    }
  }

  const headers = table[headerRow] ?? [];
  const columnCount = Math.max(0, ...table.slice(headerRow, headerRow + 20).map((r) => r.length));
  const columnOptions = Array.from({ length: columnCount }, (_, i) => {
    const title = cellText(headers[i]).trim();
    return { index: i, label: title ? `${columnLetter(i)} · ${title}` : `Колонка ${columnLetter(i)}` };
  });

  const result = useMemo(() => {
    if (mapping.price === undefined || (mapping.sku === undefined && mapping.name === undefined)) return null;
    const items = rows.map((r) => ({ key: r.key, name: r.name, priceRub: r.priceRub }));
    return matchPriceRows(table.slice(headerRow + 1), mapping, items, headerRow + 2);
  }, [table, headerRow, mapping, rows]);

  const selected = result?.matches.filter((m) => !excluded.has(m.key)) ?? [];
  const changedCount = selected.filter((m) => m.newPrice !== m.oldPrice).length;
  const allChecked = result !== null && result.matches.length > 0 && excluded.size === 0;

  function toggle(key: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function apply() {
    const date = today();
    const patches = new Map<string, PricePatch>();
    for (const m of selected) {
      patches.set(m.key, { priceRub: m.newPrice, priceDate: date, priceStatus: 'verified', source: m.source ?? fileName });
    }
    onApply(patches);
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header className="dialog-head">
          <h2 id="import-title">Импорт цен из Excel · {kindLabel}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">×</button>
        </header>

        <div className="dialog-body">
          <div
            className={`dropzone${dragOver ? ' over' : ''}${sheets.length ? ' compact' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void loadFile(e.dataTransfer.files[0]); }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xlsm,.csv,.txt,.tsv"
              hidden
              onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            {sheets.length ? (
              <p><strong>{fileName}</strong> · строк: {table.length}</p>
            ) : (
              <>
                <p className="dropzone-title">Перетащите сюда прайс-лист</p>
                <p className="muted">Файл .xlsx или .csv. Нужны колонки с артикулом или названием и с ценой.</p>
              </>
            )}
            <button className="btn" onClick={() => inputRef.current?.click()} disabled={busy}>
              {busy ? 'Читаю…' : sheets.length ? 'Выбрать другой файл' : 'Выбрать файл'}
            </button>
          </div>

          {error && <p className="alert" role="alert">{error}</p>}

          {sheets.length > 0 && (
            <>
              <div className="mapping">
                {sheets.length > 1 && (
                  <label>
                    <span>Лист</span>
                    <select value={sheetIndex} onChange={(e) => selectSheet(sheets, Number(e.target.value))}>
                      {sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
                    </select>
                  </label>
                )}
                <label>
                  <span>Строка заголовков</span>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, table.length)}
                    value={headerRow + 1}
                    onChange={(e) => {
                      const row = Math.min(Math.max(Number(e.target.value) || 1, 1), Math.max(1, table.length)) - 1;
                      setHeaderRow(row);
                      setMapping(detectColumns(table[row] ?? []));
                      setExcluded(new Set());
                    }}
                  />
                </label>
                {FIELDS.map(({ field, label, hint }) => (
                  <label key={field} title={hint}>
                    <span>{label}</span>
                    <select
                      value={mapping[field] ?? ''}
                      onChange={(e) => {
                        const value = e.target.value === '' ? undefined : Number(e.target.value);
                        setMapping((m) => ({ ...m, [field]: value }));
                        setExcluded(new Set());
                      }}
                    >
                      <option value="">— нет —</option>
                      {columnOptions.map((c) => <option key={c.index} value={c.index}>{c.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>

              {!result && (
                <p className="alert">Укажите колонку с ценой и колонку с артикулом или названием.</p>
              )}

              {result && (
                <>
                  <p className="import-summary">
                    Найдено в каталоге: <strong>{result.matches.length}</strong>
                    {' · '}цена изменится: <strong>{result.matches.filter((m) => m.newPrice !== m.oldPrice).length}</strong>
                    {' · '}нет в каталоге: <strong>{result.unmatched.length}</strong>
                    {' · '}пропущено строк: <strong>{result.skipped}</strong>
                  </p>

                  {result.matches.length > 0 && (
                    <div className="table-wrap import-table">
                      <table>
                        <thead>
                          <tr>
                            <th className="check">
                              <input
                                type="checkbox"
                                aria-label="Выбрать все"
                                checked={allChecked}
                                onChange={() => setExcluded(allChecked ? new Set(result.matches.map((m) => m.key)) : new Set())}
                              />
                            </th>
                            <th>Позиция</th>
                            <th className="num">Было, ₽</th>
                            <th className="num">Станет, ₽</th>
                            <th className="num">Изменение</th>
                            <th>Строка</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.matches.map((m) => {
                            const delta = m.oldPrice > 0 ? ((m.newPrice - m.oldPrice) / m.oldPrice) * 100 : null;
                            const same = m.newPrice === m.oldPrice;
                            const suspicious = isSuspicious(m.oldPrice, m.newPrice);
                            return (
                              <tr key={m.key} className={excluded.has(m.key) ? 'off' : ''}>
                                <td className="check">
                                  <input type="checkbox" aria-label={`Применить: ${m.name}`} checked={!excluded.has(m.key)} onChange={() => toggle(m.key)} />
                                </td>
                                <td>
                                  <div>{m.name}</div>
                                  <div className="muted small">{m.key}{m.matchedBy === 'name' ? ' · найдено по названию' : ''}</div>
                                </td>
                                <td className="num">{formatRub(m.oldPrice)}</td>
                                <td className="num"><strong>{formatRub(m.newPrice)}</strong></td>
                                <td className={`num ${same ? 'muted' : suspicious ? 'warn' : ''}`}>
                                  {same ? 'без изменений' : delta === null ? 'новая цена' : `${delta > 0 ? '+' : ''}${delta.toFixed(0)} %`}
                                  {suspicious && <div className="small">проверьте</div>}
                                </td>
                                <td className="muted">{m.row}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {result.unmatched.length > 0 && (
                    <details className="unmatched">
                      <summary>Нет в каталоге: {result.unmatched.length}. Эти строки не будут загружены</summary>
                      <ul>
                        {result.unmatched.slice(0, 200).map((u) => (
                          <li key={u.row}>
                            <span className="muted">стр. {u.row}</span> {u.sku && <code>{u.sku}</code>} {u.name} — {formatRub(u.price)} ₽
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <footer className="dialog-foot">
          <span className="muted">
            {selected.length > 0
              ? `Будет обновлено позиций: ${selected.length}, из них с новой ценой: ${changedCount}. Все получат статус «проверено» и сегодняшнюю дату.`
              : 'Каталог не изменится, пока вы не нажмёте «Применить».'}
          </span>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={selected.length === 0} onClick={apply}>
            Применить{selected.length > 0 ? ` (${selected.length})` : ''}
          </button>
        </footer>
      </div>
    </div>
  );
}
