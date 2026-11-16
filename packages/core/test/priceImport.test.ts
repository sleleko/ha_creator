import { describe, expect, it } from 'vitest';
import { detectColumns, findHeaderRow, matchPriceRows, normalizeName, parseCsv, parsePrice } from '../src/index.js';

describe('parsePrice', () => {
  it.each([
    [1500, 1500],
    ['1500', 1500],
    ['1 500', 1500],
    ['1 234,50 ₽', 1234.5],
    ['1,234.50', 1234.5],
    ['1.234,50', 1234.5],
    ['2 500 руб.', 2500],
    ['12,5', 12.5],
    ['1,234', 1234],
    ['1.234', 1234],
    ['99.90', 99.9],
    ['0', 0],
  ])('%j → %j', (input, expected) => expect(parsePrice(input)).toBe(expected));

  it.each([[''], ['по запросу'], [null], [undefined], [-5], ['—']])('%j → null', (input) =>
    expect(parsePrice(input)).toBeNull(),
  );
});

describe('detectColumns и findHeaderRow', () => {
  it('узнаёт типичные заголовки прайса', () => {
    expect(detectColumns(['№', 'Артикул', 'Наименование товара', 'Ед.', 'Цена, руб.', 'Магазин'])).toEqual({
      sku: 1, name: 2, price: 4, source: 5,
    });
  });

  it('узнаёт заголовки собственной выгрузки', () => {
    expect(detectColumns(['Артикул', 'Название', 'Категория', 'Ед.', 'Цена, ₽', 'Дата цены', 'Статус', 'Источник'])).toEqual({
      sku: 0, name: 1, price: 4, source: 7,
    });
  });

  it('пропускает шапку над таблицей', () => {
    const rows = [['ООО «Ромашка»'], ['Прайс-лист от 01.11.2026'], [], ['Код', 'Товар', 'Розничная цена'], ['a1', 'Датчик', 100]];
    expect(findHeaderRow(rows)).toBe(3);
  });
});

describe('matchPriceRows', () => {
  const items = [
    { key: 'aqara-leak', name: 'Датчик протечки', priceRub: 1600 },
    { key: 'aqara-door', name: 'Датчик открытия двери и окна', priceRub: 1300 },
    { key: 'dup-1', name: 'Реле', priceRub: 10 },
    { key: 'dup-2', name: 'Реле', priceRub: 20 },
  ];
  const mapping = { sku: 0, name: 1, price: 2, source: 3 };

  it('сопоставляет по артикулу без учёта регистра и по названию', () => {
    const result = matchPriceRows(
      [
        ['AQARA-LEAK', 'что угодно', '1 750 ₽', 'ozon.ru'],
        ['', '  датчик открытия двери и окна. ', 1250, ''],
      ],
      mapping,
      items,
    );
    expect(result.matches).toEqual([
      { row: 2, key: 'aqara-leak', name: 'Датчик протечки', oldPrice: 1600, newPrice: 1750, matchedBy: 'sku', source: 'ozon.ru' },
      { row: 3, key: 'aqara-door', name: 'Датчик открытия двери и окна', oldPrice: 1300, newPrice: 1250, matchedBy: 'name', source: undefined },
    ]);
  });

  it('отделяет неизвестные позиции и считает пропущенные строки', () => {
    const result = matchPriceRows(
      [
        ['new-sku', 'Новый датчик', 999, ''],
        ['aqara-leak', 'Датчик протечки', 'по запросу', ''],
        ['', '', '', ''],
      ],
      mapping,
      items,
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toEqual([{ row: 2, sku: 'new-sku', name: 'Новый датчик', price: 999 }]);
    expect(result.skipped).toBe(2);
  });

  it('не сопоставляет по названию, если оно в каталоге не уникально', () => {
    const result = matchPriceRows([['', 'Реле', 500, '']], mapping, items);
    expect(result.matches).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
  });

  it('при повторе позиции берёт последнюю строку', () => {
    const result = matchPriceRows([['aqara-leak', '', 1, ''], ['aqara-leak', '', 2, '']], mapping, items);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ newPrice: 2, row: 3 });
  });
});

describe('parseCsv и normalizeName', () => {
  it('читает CSV с точкой с запятой, кавычками и BOM', () => {
    expect(parseCsv('﻿Артикул;Название;Цена\r\na1;"Реле ""умное""; 16 А";1 500,50\r\n\r\n')).toEqual([
      ['Артикул', 'Название', 'Цена'],
      ['a1', 'Реле "умное"; 16 А', '1 500,50'],
    ]);
  });

  it('читает CSV с запятой', () => {
    expect(parseCsv('sku,name,price\na1,"Relay, 16A",1500')).toEqual([['sku', 'name', 'price'], ['a1', 'Relay, 16A', '1500']]);
  });

  it('нормализует названия', () => {
    expect(normalizeName(' Датчик  «Тёплый»  пол. ')).toBe('датчик теплый пол');
  });
});
