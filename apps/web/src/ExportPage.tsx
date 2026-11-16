import { useMemo, useState } from 'react';
import { generateHaExport, validateProject } from '@ha-creator/core';
import { strToU8, zipSync } from 'fflate';
import { download, type Catalog } from './catalog';
import { project, scenarioTemplates } from './project';

const NOTIFY_PATTERN = /^[a-z_]+\.[a-z0-9_]+$/;

export function ExportPage({ catalog }: { catalog: Catalog }) {
  const [notifyAction, setNotifyAction] = useState('notify.notify');
  const [selected, setSelected] = useState('README.md');
  const notifyValid = NOTIFY_PATTERN.test(notifyAction);

  const catalogs = useMemo(() => ({ devices: catalog.devices, scenarios: scenarioTemplates }), [catalog]);
  const errors = useMemo(() => validateProject(project, catalogs).filter((i) => i.level === 'error'), [catalogs]);
  const result = useMemo(
    () => generateHaExport(project, catalogs, { notifyAction: notifyValid ? notifyAction : 'notify.notify' }),
    [catalogs, notifyAction, notifyValid],
  );
  const paths = Object.keys(result.files).sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)));
  const current = result.files[selected] !== undefined ? selected : 'README.md';

  function downloadZip() {
    const entries = Object.fromEntries(Object.entries(result.files).map(([path, text]) => [path, strToU8(text)]));
    download('homeassistant-config.zip', new Blob([zipSync(entries)], { type: 'application/zip' }));
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Экспорт под Home Assistant</h1>
          <p className="muted">
            {project.site.name}. В архиве пакеты автоматизаций, панель и инструкция по установке с таблицей имён сущностей.
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={downloadZip} disabled={errors.length > 0 || !notifyValid}>Скачать ZIP</button>
        </div>
      </header>

      <div className="toolbar">
        <label className="field">
          <span className="muted small">Действие для уведомлений</span>
          <input
            value={notifyAction}
            aria-invalid={!notifyValid}
            className={notifyValid ? '' : 'invalid'}
            onChange={(e) => setNotifyAction(e.target.value.trim())}
            placeholder="notify.mobile_app_iphone"
          />
        </label>
        <p className="muted small hint">
          Например, <code>notify.mobile_app_iphone</code>. Имя видно в Home Assistant после установки мобильного приложения.
        </p>
      </div>

      {!notifyValid && <p className="alert">Действие пишется латиницей в виде <code>notify.имя</code>.</p>}
      {errors.length > 0 && (
        <div className="alert">
          <strong>В проекте есть ошибки, экспорт недоступен:</strong>
          <ul>{errors.map((e) => <li key={e.path + e.message}>{e.message}</li>)}</ul>
        </div>
      )}
      {result.notes.length > 0 && (
        <div className="alert">
          <strong>Оговорки генератора:</strong>
          <ul>{result.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}

      <div className="files">
        <nav className="file-list" aria-label="Файлы архива">
          {paths.map((path) => (
            <button key={path} className={path === current ? 'file active' : 'file'} onClick={() => setSelected(path)}>{path}</button>
          ))}
        </nav>
        <pre className="file-view">{result.files[current]}</pre>
      </div>
    </div>
  );
}
