import { Project, ScenarioCatalog } from '@ha-creator/core';
import { parse } from 'yaml';
import dacha from '../../../examples/dacha.json';
import scenariosYaml from '../../../catalog/scenarios.yaml?raw';

/** Пока редактора проектов нет, приложение работает с эталонной дачей из репозитория. */
export const project = Project.parse(dacha);
export const scenarioTemplates = ScenarioCatalog.parse(parse(scenariosYaml)).scenarios;
