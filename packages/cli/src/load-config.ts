import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpsMemoryConfig } from '@ops-memory/core';

export const CONFIG_NAMES = ['ops-memory.config.ts', 'ops-memory.config.mts', 'ops-memory.config.mjs', 'ops-memory.config.js'];

export function findConfig(cwd: string, explicit?: string): string {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
    return path;
  }
  for (const name of CONFIG_NAMES) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`No ops-memory config in ${cwd}. Run \`ops-memory init\` or pass --config <file>.`);
}

/** Loads `.env` next to the config (if any), then the config itself. TypeScript configs run through tsx. */
export async function loadConfig(path: string): Promise<OpsMemoryConfig> {
  const envPath = resolve(path, '..', '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  // A fresh instance per load: the config builds connections and stores, and a cached module would
  // hand back ones an earlier command already closed.
  const url = `${pathToFileURL(path).href}?load=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = /\.m?ts$/.test(path)
    ? await (await import('tsx/esm/api')).tsImport(url, import.meta.url)
    : await import(url);
  const config = (mod.default?.default ?? mod.default ?? mod.config) as OpsMemoryConfig | undefined;
  if (!config || typeof config !== 'object') {
    throw new Error(`${path} must \`export default defineConfig({...})\``);
  }
  return config;
}
