/** Разбор прайс-листа (строки таблицы из Excel или CSV) и сопоставление с каталогом. Без привязки к формату файла. */

export type Cell = string | number | boolean | Date | null | undefined;

export interface ColumnMapping {
  sku?: number;
  name?: number;
  price?: number;
  source?: number;
}

const HEADER_PATTERNS: Record<keyof ColumnMapping, RegExp[]> = {
  sku: [/^арт/, /^sku$/, /^код/, /^id$/, /^номенклатурн/, /^part/],
  name: [/^наимен/, /^назван/, /^товар/, /^номенклатура$/, /^позици/, /^name$/, /^описание/, /^вид работ/, /^работ/],
  price: [/цена/, /стоимость/, /^price/, /розни/, /^руб/, /₽/],
  source: [/^источник/, /^магазин/, /^поставщик/, /^ссылк/, /^url$/, /^source$/],
};

const clean = (v: Cell): string => (v == null ? '' : String(v)).trim().toLowerCase().replace(/ё/g, 'е');

/** Угадывает, какая колонка что содержит, по заголовкам. */
export function detectColumns(headers: Cell[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const field of ['sku', 'name', 'price', 'source'] as const) {
    for (const pattern of HEADER_PATTERNS[field]) {
      const index = headers.findIndex((h, i) => pattern.test(clean(h)) && !Object.values(mapping).includes(i));
      if (index >= 0) {
        mapping[field] = index;
        break;
      }
    }
  }
  return mapping;
}

/** Ищет строку заголовков среди первых строк: в прайсах сверху часто стоят шапка и реквизиты. */
export function findHeaderRow(rows: Cell[][], scan = 15): number {
  for (let i = 0; i < Math.min(rows.length, scan); i++) {
    const m = detectColumns(rows[i] ?? []);
    if (m.price !== undefined && (m.sku !== undefined || m.name !== undefined)) return i;
  }
  return 0;
}

/** Понимает «1 234,50 ₽», «1,234.50», «2500 руб.», число. Возвращает null, если цены нет. */
export function parsePrice(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  let s = value.replace(/[\s  ]/g, '').replace(/(руб\.?|р\.|₽|rub)/gi, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Оба разделителя: правый — десятичный, левый — разряды.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Только запятая: «1,234» — разряды, «12,5» — дробь.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Приводит название к виду для сравнения: регистр, ё, кавычки, лишние пробелы и знаки. */
export function normalizeName(value: Cell): string {
  return clean(value)
    .replace(/["'«»“”]/g, '')
    .replace(/[\s ]+/g, ' ')
    .replace(/[.,;]+$/, '')
    .trim();
}

export interface PriceItem {
  /** SKU изделия или id расценки. */
  key: string;
  name: string;
  priceRub: number;
}

export interface ImportMatch {
  /** Номер строки в файле, с единицы. */
  row: number;
  key: string;
  name: string;
  oldPrice: number;
  newPrice: number;
  matchedBy: 'sku' | 'name';
  source?: string;
}

export interface UnmatchedRow {
  row: number;
  sku?: string;
  name?: string;
  price: number;
}

export interface ImportResult {
  /** Позиции каталога, для которых в файле нашлась цена. Одна запись на позицию: побеждает последняя строка файла. */
  matches: ImportMatch[];
  /** Строки с ценой, которых нет в каталоге. */
  unmatched: UnmatchedRow[];
  /** Сколько строк пропущено: пустые или без распознанной цены. */
  skipped: number;
}

/**
 * Сопоставляет строки прайса с каталогом: сначала по артикулу, затем по точному совпадению названия.
 * `rows` — строки данных без заголовка; `firstRowNumber` — номер первой из них в файле.
 */
export function matchPriceRows(
  rows: Cell[][],
  mapping: ColumnMapping,
  items: PriceItem[],
  firstRowNumber = 2,
): ImportResult {
  const bySku = new Map(items.map((i) => [clean(i.key), i]));
  const byName = new Map<string, PriceItem | null>();
  for (const item of items) {
    const key = normalizeName(item.name);
    // Одинаковые названия у разных позиций: по названию не сопоставляем, чтобы не перепутать.
    byName.set(key, byName.has(key) ? null : item);
  }

  const matched = new Map<string, ImportMatch>();
  const unmatched: UnmatchedRow[] = [];
  let skipped = 0;
  const cell = (row: Cell[], index: number | undefined) => (index === undefined ? undefined : row[index]);

  rows.forEach((row, i) => {
    const rowNumber = firstRowNumber + i;
    const price = parsePrice(cell(row, mapping.price));
    const skuRaw = cell(row, mapping.sku);
    const nameRaw = cell(row, mapping.name);
    const sku = skuRaw == null ? '' : String(skuRaw).trim();
    const name = nameRaw == null ? '' : String(nameRaw).trim();
    if (price === null || (!sku && !name)) {
      skipped++;
      return;
    }
    let item = sku ? bySku.get(clean(sku)) : undefined;
    let matchedBy: 'sku' | 'name' = 'sku';
    if (!item && name) {
      item = byName.get(normalizeName(name)) ?? undefined;
      matchedBy = 'name';
    }
    if (!item) {
      unmatched.push({ row: rowNumber, sku: sku || undefined, name: name || undefined, price });
      return;
    }
    const sourceRaw = cell(row, mapping.source);
    const source = sourceRaw == null ? '' : String(sourceRaw).trim();
    matched.delete(item.key);
    matched.set(item.key, {
      row: rowNumber,
      key: item.key,
      name: item.name,
      oldPrice: item.priceRub,
      newPrice: price,
      matchedBy,
      source: source || undefined,
    });
  });

  return { matches: [...matched.values()], unmatched, skipped };
}

/** Разбор CSV: разделитель определяется по первой строке (; , или табуляция), кавычки поддерживаются. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = count(';') >= count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
