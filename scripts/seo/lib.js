import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const fmt = (d) => d.toISOString().slice(0, 10);

/** Últimos 28 días completos (excluye hoy). */
export function last28Days() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: fmt(start), endDate: fmt(end) };
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable ${name} en .env`);
  return v;
}

/** Lee una variable que apunta a un fichero y comprueba que existe. */
export function requireFileEnv(name) {
  const p = requireEnv(name);
  if (!fs.existsSync(p)) throw new Error(`${name} apunta a un fichero que no existe: ${p}`);
  return p;
}

export function saveResult(source, data) {
  const dir = path.join(ROOT, 'seo-data', fmt(new Date()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${source}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return path.relative(ROOT, file);
}

export const top = (rows, n = 5) => rows.slice(0, n);

/** Ejecuta main() si el módulo se lanza directamente. */
export function runIfMain(metaUrl, main) {
  if (process.argv[1] && fileURLToPath(metaUrl) === path.resolve(process.argv[1])) {
    main().catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
  }
}
