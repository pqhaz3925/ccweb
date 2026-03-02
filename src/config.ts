import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CCWebConfig } from './shared/types.js';

const CONFIG_PATH = resolve(process.cwd(), 'ccweb.config.json');

const DEFAULTS: CCWebConfig = {
  claude: { apiUrl: null, apiKey: null },
  web: { port: 3001, host: '0.0.0.0' },
  telegram: { token: null, allowedUsers: [] },
  session: {
    timeoutMs: 30 * 60 * 1000,
    watchdogIntervalMs: 10_000,
    defaultProject: null,
  },
};

export function loadConfig(): CCWebConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      claude: { ...DEFAULTS.claude, ...raw.claude },
      web: { ...DEFAULTS.web, ...raw.web },
      telegram: { ...DEFAULTS.telegram, ...raw.telegram },
      session: { ...DEFAULTS.session, ...raw.session },
    };
  } catch {
    console.error('Failed to parse ccweb.config.json, using defaults');
    return DEFAULTS;
  }
}
