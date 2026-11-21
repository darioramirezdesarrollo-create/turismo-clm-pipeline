// Destino de publicación "web": la web Next.js de ../turismo-clm-web, que lee
// export/paginas.json (más bodegas.json y restaurantes.json) desde lib/data.ts.
// Las páginas nuevas se añaden al final de export/paginas.json y export/urls.csv
// sin tocar lo existente; al terminar el lote se hace commit, push y despliegue.
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

export const WEB_SITE_URL = 'https://turismoencastillalamancha.es';
// Se leen al usarse (no al importar), cuando index.js ya ha cargado el .env.
const deployHost = () => process.env.WEB_DEPLOY_HOST || 'root@128.140.100.221';
const deployDir = () => process.env.WEB_DEPLOY_DIR || '/var/www/turismo-clm-web';
const EXPORT_FILES = ['export/paginas.json', 'export/bodegas.json', 'export/restaurantes.json'];
const PAGES_JSON = 'export/paginas.json';
const URLS_CSV = 'export/urls.csv';
const CSV_HEADER = ['url', 'tipo', 'id', 'parent', 'titulo_seo'];

export function webRepoDir() {
  return path.resolve(process.env.WEB_REPO_DIR || '../turismo-clm-web');
}

/** WEB_ENV: solo "production" avisa a buscadores; cualquier otro valor es staging. */
export function webEnv() {
  return process.env.WEB_ENV === 'production' ? 'production' : 'staging';
}

// ---------- Export ----------

/** Lee el export de la web. `pages` se modifica en memoria al añadir páginas. */
export async function loadExport(repoDir) {
  const [pages, ...others] = await Promise.all(
    EXPORT_FILES.map(async (f) => JSON.parse(await fs.readFile(path.join(repoDir, f), 'utf-8')))
  );
  const all = [...pages, ...others.flat()];
  return {
    pages,
    nextId: Math.max(0, ...all.map((i) => i.id)) + 1,
    links: new Set(all.map((i) => new URL(i.link).pathname))
  };
}

/** Busca el índice padre igual que resolveParentId() en WordPress: slug + parent. */
export function resolveWebParent(exp, entry) {
  const find = (slug, parent) => exp.pages.find((p) => p.tipo === 'page' && p.slug === slug && p.parent === parent);
  let parentId = 0;

  if (entry.grandparent_slug) {
    const gp = find(entry.grandparent_slug, 0);
    if (!gp) throw new Error(`No se encontró en el export la página con slug "${entry.grandparent_slug}" (nivel superior)`);
    parentId = gp.id;
  }

  if (entry.parent_slug) {
    const p = find(entry.parent_slug, parentId);
    if (!p) throw new Error(`No se encontró en el export la página con slug "${entry.parent_slug}" bajo el padre esperado`);
    parentId = p.id;
  }

  return parentId;
}

/** Ruta completa recorriendo la jerarquía del export, como pathOf() en lib/data.ts. */
function pathFor(exp, slug, parentId) {
  const byId = new Map(exp.pages.map((p) => [p.id, p]));
  const segs = [slug];
  const seen = new Set();
  for (let cur = parentId; cur; ) {
    const parent = byId.get(cur);
    if (!parent || seen.has(cur)) throw new Error(`Jerarquía rota en el export al resolver el padre ${parentId}`);
    seen.add(cur);
    segs.unshift(parent.slug);
    cur = parent.parent;
  }
  return `/${segs.join('/')}/`;
}

/** Fecha como la exporta WordPress: "2026-11-14T11:13:45" (UTC, sin zona ni milisegundos). */
const wpDate = (d = new Date()) => d.toISOString().slice(0, 19);

/**
 * Construye la entrada con los mismos campos que export/paginas.json y la reserva
 * en `exp` (id y ruta), sin escribir nada en disco. Lanza si el padre no existe.
 */
export function buildWebEntry(exp, entry, generated) {
  const parentId = resolveWebParent(exp, entry);
  const pathname = pathFor(exp, entry.slug, parentId);
  if (exp.links.has(pathname)) throw new Error(`Ya existe en el export una página en ${pathname}`);

  const fecha = wpDate();
  const titulo = generated.title || entry.nombre;
  const item = {
    id: exp.nextId,
    tipo: 'page',
    slug: entry.slug,
    link: `${WEB_SITE_URL}${pathname}`,
    parent: parentId,
    titulo,
    contenido: generated.content,
    fecha,
    fecha_modificacion: fecha,
    imagen_destacada: null,
    seo_titulo: titulo,
    seo_descripcion: generated.metaDescription || '',
    seo_origen: 'pipeline',
    acf: null
  };

  exp.nextId += 1;
  exp.links.add(pathname);
  exp.pages.push(item);
  return item;
}

// Mismo formato que scripts/export-wordpress.mjs de la web.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (item) =>
  [item.link, item.tipo, item.id, item.parent, item.seo_titulo].map(csvCell).join(',');

/**
 * Escribe `exp.pages` en export/paginas.json (mismo formato: 2 espacios y salto final)
 * y añade las filas de `items` al final de export/urls.csv.
 * `exportDir` es la carpeta que contiene paginas.json y urls.csv.
 */
export async function writeExport(exportDir, exp, items) {
  await fs.writeFile(path.join(exportDir, 'paginas.json'), JSON.stringify(exp.pages, null, 2) + '\n');

  const csvPath = path.join(exportDir, 'urls.csv');
  const csv = await fs.readFile(csvPath, 'utf-8');
  if (csv.split('\n')[0] !== CSV_HEADER.join(',')) throw new Error(`Cabecera inesperada en ${csvPath}`);
  const sep = csv.endsWith('\n') ? '' : '\n';
  await fs.appendFile(csvPath, sep + items.map(csvRow).join('\n') + '\n');
}

// ---------- Git, despliegue y avisos ----------

function run(cmd, args, { cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')} terminó con código ${code}${err ? `: ${err.trim()}` : ''}`))
    );
  });
}

const git = (repoDir, ...args) => run('git', args, { cwd: repoDir, capture: true });

/**
 * Antes del lote: el export no puede tener cambios sin commit (p.ej. de un lote
 * anterior que falló al hacer commit) y se trae lo último del remoto.
 */
export async function prepareWebRepo(repoDir) {
  const dirty = await git(repoDir, 'status', '--porcelain', '--', PAGES_JSON, URLS_CSV);
  if (dirty) {
    throw new Error(`El export de la web tiene cambios sin commit (${repoDir}):\n${dirty}\nRevísalos antes de publicar.`);
  }
  await git(repoDir, 'pull', '--ff-only');
}

export async function commitAndPush(repoDir, count) {
  const message = count === 1 ? 'Pipeline: 1 página nueva' : `Pipeline: ${count} páginas nuevas`;
  await git(repoDir, 'add', '--', PAGES_JSON, URLS_CSV);
  await git(repoDir, 'commit', '-m', message, '--', PAGES_JSON, URLS_CSV);
  const commit = await git(repoDir, 'rev-parse', '--short', 'HEAD');
  await git(repoDir, 'push');
  return { commit, message };
}

const ssh = (remoteCmd) => run('ssh', ['-o', 'BatchMode=yes', deployHost(), remoteCmd]);
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const deployCommand = () => `ssh ${deployHost()} ${deployDir()}/scripts/deploy.sh`;

export async function deploy() {
  await ssh(`${deployDir()}/scripts/deploy.sh`);
}

export async function indexNow(urls) {
  await ssh(`cd ${shQuote(deployDir())} && npm run indexnow -- ${urls.map(shQuote).join(' ')}`);
}
