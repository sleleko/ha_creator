import { useMemo } from 'react';
import { SECTION_LABELS, computeEstimate, validateProject, type EstimateSection } from '@ha-creator/core';
import writeExcelFile from 'write-excel-file/browser';
import { download, formatRub, today, type Catalog } from './catalog';
import { project, scenarioTemplates } from './project';

const SECTIONS: EstimateSection[] = ['equipment', 'materials', 'works', 'overhead'];

export function EstimatePage({ catalog, onOpenPrices }: { catalog: Catalog; onOpenPrices: () => void }) {
  const estimate = useMemo(() => computeEstimate(project, catalog), [catalog]);
  const issues = useMemo(() => validateProject(project, { devices: catalog.devices, scenarios: scenarioTemplates }), [catalog]);
  const problems = [...issues.map((i) => i.message), ...estimate.problems];

  async function downloadXlsx() {
    const bold = (value: string | number) => ({ value, fontWeight: 'bold' as const });
    const rows: unknown[][] = [[bold(`Смета: ${project.site.name}`)], [`Дата расчёта: ${today()}`], []];
    rows.push(['Код', 'Наименование', 'Ед.', 'Кол-во', 'Цена, ₽', 'Сумма, ₽', 'Цена проверена', 'Основание'].map(bold));
    for (const section of SECTIONS) {
      const lines = estimate.lines.filter((l) => l.section === section);
      if (lines.length === 0) continue;
      rows.push([bold(SECTION_LABELS[section])]);
      for (const l of lines) rows.push([l.code, l.name, l.unit, l.qty, l.priceRub, l.sumRub, l.priceVerified ? 'да' : 'нет', l.basis]);
      rows.push([null, bold(`Итого: ${SECTION_LABELS[section].toLowerCase()}`), null, null, null, bold(estimate.totals[section])]);
    }
    rows.push([], [null, bold('Всего по смете'), null, null, null, bold(estimate.totals.total)]);
    const columns = [{ width: 22 }, { width: 50 }, { width: 8 }, { width: 9 }, { width: 12 }, { width: 13 }, { width: 15 }, { width: 50 }];
    const blob = await writeExcelFile(rows as never, { columns, sheet: 'Смета' }).toBlob();
    download(`smeta-${today()}.xlsx`, blob);
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Смета</h1>
          <p className="muted">{project.site.name}. Считается по текущим ценам из редактора цен.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => void downloadXlsx()}>Скачать Excel</button>
        </div>
      </header>

      <div className="cards">
        {SECTIONS.map((s) => (
          <div className="card" key={s}>
            <div className="muted small">{SECTION_LABELS[s]}</div>
            <div className="card-value">{formatRub(estimate.totals[s])} ₽</div>
          </div>
        ))}
        <div className="card total">
          <div className="small">Всего</div>
          <div className="card-value">{formatRub(estimate.totals.total)} ₽</div>
        </div>
      </div>

      {estimate.unverified.lines > 0 && (
        <p className="alert">
          Смета предварительная: {estimate.unverified.lines} строк посчитаны по непроверенным ценам, это{' '}
          {Math.round(estimate.unverified.share * 100)} % суммы.{' '}
          <button className="link" onClick={onOpenPrices}>Проверить цены</button>
        </p>
      )}
      {problems.length > 0 && (
        <div className="alert">
          <strong>Что не удалось посчитать или проверить:</strong>
          <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Позиция</th>
              <th>Ед.</th>
              <th className="num">Кол-во</th>
              <th className="num">Цена, ₽</th>
              <th className="num">Сумма, ₽</th>
              <th>Основание</th>
            </tr>
          </thead>
          {SECTIONS.map((section) => {
            const lines = estimate.lines.filter((l) => l.section === section);
            if (lines.length === 0) return null;
            return (
              <tbody key={section}>
                <tr className="section-row">
                  <td colSpan={4}>{SECTION_LABELS[section]}</td>
                  <td className="num">{formatRub(estimate.totals[section])}</td>
                  <td></td>
                </tr>
                {lines.map((l) => (
                  <tr key={l.code}>
                    <td>
                      <div>{l.name}</div>
                      <div className="muted small">{l.code}</div>
                    </td>
                    <td className="muted">{l.unit}</td>
                    <td className="num">{formatRub(l.qty)}</td>
                    <td className="num">
                      {formatRub(l.priceRub)}
                      {!l.priceVerified && <div className="small warn">ориентир</div>}
                    </td>
                    <td className="num">{formatRub(l.sumRub)}</td>
                    <td className="muted small">{l.basis}</td>
                  </tr>
                ))}
              </tbody>
            );
          })}
          <tfoot>
            <tr className="section-row">
              <td colSpan={4}>Всего по смете</td>
              <td className="num">{formatRub(estimate.totals.total)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
