import { useEffect, useState } from 'react';
import { loadRepoCatalog, loadSavedCatalog, saveCatalog, type Catalog } from './catalog';
import { EstimatePage } from './EstimatePage';
import { ExportPage } from './ExportPage';
import { PriceEditor } from './PriceEditor';

type Page = 'estimate' | 'prices' | 'export';
const PAGES: { id: Page; label: string }[] = [
  { id: 'estimate', label: 'Смета' },
  { id: 'prices', label: 'Цены' },
  { id: 'export', label: 'Экспорт HA' },
];

const repoCatalog = loadRepoCatalog();
const pageFromHash = (): Page => PAGES.find((p) => `#${p.id}` === window.location.hash)?.id ?? 'estimate';

export function App() {
  const [catalog, setCatalog] = useState<Catalog>(() => loadSavedCatalog(repoCatalog));
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    saveCatalog(catalog === repoCatalog ? null : catalog);
  }, [catalog]);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const open = (next: Page) => {
    window.location.hash = next;
    setPage(next);
  };

  return (
    <>
      <nav className="topnav" aria-label="Разделы">
        <span className="brand">HA Creator</span>
        {PAGES.map((p) => (
          <button key={p.id} className={page === p.id ? 'nav-link active' : 'nav-link'} aria-current={page === p.id ? 'page' : undefined} onClick={() => open(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>
      {page === 'estimate' && <EstimatePage catalog={catalog} onOpenPrices={() => open('prices')} />}
      {page === 'prices' && <PriceEditor catalog={catalog} repoCatalog={repoCatalog} onChange={setCatalog} />}
      {page === 'export' && <ExportPage catalog={catalog} />}
    </>
  );
}
