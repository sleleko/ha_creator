import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Project, validateProject } from '@ha-creator/core';
import dacha from '../../../examples/dacha.json';

const project = Project.parse(dacha);
const issues = validateProject(project);
const rooms = project.buildings.flatMap((b) => b.floors.flatMap((f) => f.rooms));

function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '40px auto', padding: '0 16px' }}>
      <h1>HA Creator</h1>
      <p>Эталонный объект: {project.site.name}</p>
      <ul>
        <li>Помещений: {rooms.length}</li>
        <li>Узлов коммуникаций: {project.utilityNodes.length}</li>
        <li>Точек автоматизации: {project.automationPoints.length}</li>
        <li>Сценариев: {project.scenarios.length}</li>
        <li>Замечаний проверки: {issues.length}</li>
      </ul>
      <p>Редакторы появятся на следующих этапах. Сейчас страница только показывает, что ядро читает проект.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
