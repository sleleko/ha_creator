import { parse, stringify } from 'yaml';
import { DeviceCatalog, WorkCatalog, type Device, type WorkRate } from '@ha-creator/core';
import devicesYaml from '../../../catalog/devices.yaml?raw';
import worksYaml from '../../../catalog/works.yaml?raw';

export type Kind = 'devices' | 'works';
export type PriceStatus = 'verified' | 'estimate';

export interface Catalog {
  devices: Device[];
  works: WorkRate[];
}

/** Строка редактора: общее представление изделия и расценки. */
export interface PriceRow {
  key: string;
  name: string;
  group: string;
  unit: string;
  priceRub: number;
  priceDate: string;
  priceStatus: PriceStatus;
  source: string;
}

export type PricePatch = Partial<Pick<PriceRow, 'priceRub' | 'priceDate' | 'priceStatus' | 'source'>>;

export const CATEGORY_LABELS: Record<Device['category'], string> = {
  server: 'Серверы',
  coordinator: 'Координаторы',
  sensor: 'Датчики',
  actuator: 'Исполнители',
  controller: 'Контроллеры',
  power: 'Питание',
  network: 'Сеть',
  camera: 'Камеры',
  material: 'Материалы',
};

export const KIND_LABELS: Record<Kind, string> = { devices: 'Комплектующие', works: 'Работы' };

/** Цена считается устаревшей, если её не обновляли дольше этого срока. */
export const STALE_DAYS = 60;

const STORAGE_KEY = 'ha-creator.catalog.v1';

export function loadRepoCatalog(): Catalog {
  return {
    devices: DeviceCatalog.parse(parse(devicesYaml)).devices,
    works: WorkCatalog.parse(parse(worksYaml)).works,
  };
}

/** Каталог с правками пользователя из браузера; при любой ошибке — каталог из репозитория. */
export function loadSavedCatalog(repo: Catalog): Catalog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return repo;
    const saved = JSON.parse(raw);
    return {
      devices: DeviceCatalog.parse({ devices: saved.devices }).devices,
      works: WorkCatalog.parse({ works: saved.works }).works,
    };
  } catch {
    return repo;
  }
}

export function saveCatalog(catalog: Catalog | null): void {
  try {
    if (catalog) localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Хранилище недоступно (приватный режим): правки живут до закрытия вкладки.
  }
}

export function toRows(catalog: Catalog, kind: Kind): PriceRow[] {
  if (kind === 'devices') {
    return catalog.devices.map((d) => ({
      key: d.sku,
      name: d.name,
      group: CATEGORY_LABELS[d.category],
      unit: d.unit,
      priceRub: d.priceRub,
      priceDate: d.priceDate,
      priceStatus: d.priceStatus,
      source: d.source ?? '',
    }));
  }
  return catalog.works.map((w) => ({
    key: w.id,
    name: w.name,
    group: 'Работы',
    unit: w.unit,
    priceRub: w.priceRub,
    priceDate: w.priceDate,
    priceStatus: w.priceStatus,
    source: w.source ?? '',
  }));
}

function patchItem<T extends { priceRub: number; priceDate: string; priceStatus: PriceStatus; source?: string }>(
  item: T,
  patch: PricePatch,
): T {
  const next = { ...item, ...patch };
  if (patch.source !== undefined && patch.source.trim() === '') delete next.source;
  return next;
}

export function applyPatches(catalog: Catalog, kind: Kind, patches: Map<string, PricePatch>): Catalog {
  if (kind === 'devices') {
    return { ...catalog, devices: catalog.devices.map((d) => (patches.has(d.sku) ? patchItem(d, patches.get(d.sku)!) : d)) };
  }
  return { ...catalog, works: catalog.works.map((w) => (patches.has(w.id) ? patchItem(w, patches.get(w.id)!) : w)) };
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isStale(priceDate: string, now = today()): boolean {
  const days = (Date.parse(now) - Date.parse(priceDate)) / 864e5;
  return days > STALE_DAYS;
}

export function formatRub(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function toYaml(catalog: Catalog, kind: Kind): string {
  const header =
    kind === 'devices'
      ? '# Каталог комплектующих. Выгружен из редактора цен.\n# priceStatus: verified — цена сверена с источником; estimate — ориентир, требует проверки.\n'
      : '# Справочник расценок на работы. Выгружен из редактора цен.\n# priceStatus: verified — цена сверена; estimate — ориентир, уточняется по региону и исполнителю.\n';
  const data = kind === 'devices' ? { devices: catalog.devices } : { works: catalog.works };
  return header + stringify(data, { lineWidth: 0 });
}

export function download(fileName: string, content: string | Blob, type = 'text/yaml;charset=utf-8'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
