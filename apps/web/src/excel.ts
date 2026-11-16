import readExcelFile from 'read-excel-file/browser';
import writeExcelFile from 'write-excel-file/browser';
import { parseCsv, type Cell } from '@ha-creator/core';
import type { PriceRow } from './catalog';

export interface SheetTable {
  name: string;
  rows: Cell[][];
}

/** Excel для России часто сохраняет CSV в windows-1251, поэтому пробуем UTF-8 и откатываемся. */
function decodeText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1251').decode(buffer);
  }
}

export async function readTableFile(file: File): Promise<SheetTable[]> {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    return [{ name: file.name, rows: parseCsv(decodeText(await file.arrayBuffer())) }];
  }
  if (ext === 'xls') {
    throw new Error('Старый формат .xls не поддерживается. Сохраните файл в Excel как .xlsx или .csv и загрузите снова.');
  }
  if (ext !== 'xlsx' && ext !== 'xlsm') {
    throw new Error('Поддерживаются файлы .xlsx и .csv.');
  }
  try {
    const sheets = await readExcelFile(file);
    return sheets.map((s) => ({ name: s.sheet, rows: s.data as Cell[][] })).filter((s) => s.rows.length > 0);
  } catch {
    throw new Error('Не удалось прочитать файл. Проверьте, что это книга Excel (.xlsx) и она не защищена паролем.');
  }
}

export const EXPORT_HEADERS = ['Артикул', 'Название', 'Категория', 'Ед.', 'Цена, ₽', 'Дата цены', 'Статус', 'Источник'];

export async function exportXlsx(rows: PriceRow[], sheet: string): Promise<Blob> {
  const header = EXPORT_HEADERS.map((value) => ({ value, fontWeight: 'bold' as const }));
  const data = rows.map((r) => [
    r.key,
    r.name,
    r.group,
    r.unit,
    r.priceRub,
    r.priceDate,
    r.priceStatus === 'verified' ? 'проверено' : 'ориентир',
    r.source,
  ]);
  const columns = [{ width: 24 }, { width: 52 }, { width: 16 }, { width: 8 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 28 }];
  return writeExcelFile([header, ...data], { columns, sheet, stickyRowsCount: 1 }).toBlob();
}
