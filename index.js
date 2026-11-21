import dotenv from 'dotenv';
dotenv.config({ override: true });
import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import os from 'os';
import * as web from './lib/web-target.js';

const { WP_URL, WP_USER, WP_APP_PASSWORD, ANTHROPIC_API_KEY } = process.env;
const PUBLISH_TARGET = process.env.PUBLISH_TARGET || 'wordpress';
const DRY_RUN = process.argv.includes('--dry-run');

const PAGES_FILE = path.resolve('data/pages.json');
const LOG_FILE = path.resolve('logs/publicados.json');
const PROMPTS_DIR = path.resolve('prompts');

const wpBaseUrl = WP_URL.replace(/\/+$/, '');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function authHeader() {
  const token = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

async function wpFetch(endpoint, options = {}) {
  const res = await fetch(`${wpBaseUrl}/wp-json/wp/v2/${endpoint}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WP API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function findPageId(slug, parentId = 0) {
  const results = await wpFetch(`pages?slug=${encodeURIComponent(slug)}&parent=${parentId}`);
  return results.length > 0 ? results[0].id : null;
}

async function resolveParentId(entry) {
  let parentId = 0;

  if (entry.grandparent_slug) {
    const gpId = await findPageId(entry.grandparent_slug, 0);
    if (gpId === null) {
      throw new Error(`No se encontró la página con slug "${entry.grandparent_slug}" (nivel superior)`);
    }
    parentId = gpId;
  }

  if (entry.parent_slug) {
    const pId = await findPageId(entry.parent_slug, parentId);
    if (pId === null) {
      throw new Error(`No se encontró la página con slug "${entry.parent_slug}" bajo el padre esperado`);
    }
    parentId = pId;
  }

  return parentId;
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] ?? ''));
}

function parseGeneratedContent(text) {
  const titleMatch = text.match(/^TITULO:\s*(.+)$/m);
  const metaMatch = text.match(/^META_DESCRIPCION:\s*(.+)$/m);

  const content = text
    .replace(/^TITULO:\s*.+$/m, '')
    .replace(/^META_DESCRIPCION:\s*.+$/m, '')
    .trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  return {
    content,
    title: titleMatch ? titleMatch[1].trim() : null,
    metaDescription: metaMatch ? metaMatch[1].trim() : null
  };
}

function wrapContent(html) {
  // Quita separadores sueltos tipo "—" o "---" en su propia línea, que Claude añade a veces
  const cleaned = html.replace(/^\s*[—\-–]{1,3}\s*$/gm, '').replace(/\n{3,}/g, '\n\n');

  return `<style>
.tp-article { max-width: 860px; margin: 0 auto; padding: 30px 15px; font-family: inherit; line-height: 1.75; color: #3a3a3a; font-size: 1.05em; }
.tp-article h2 { color: #1a5276; margin-top: 1.8em; margin-bottom: 0.6em; font-size: 1.7em; font-weight: 700; border-bottom: 2px solid #d6eaf8; padding-bottom: 0.3em; }
.tp-article h3 { color: #2874a6; margin-top: 1.4em; margin-bottom: 0.5em; font-size: 1.3em; font-weight: 600; }
.tp-article p { margin-bottom: 1.1em; }
.tp-article ul, .tp-article ol { padding-left: 1.6em; margin-bottom: 1.2em; }
.tp-article li { margin-bottom: 0.5em; }
.tp-article h2:first-of-type { margin-top: 0.4em; }
.tp-article strong { color: #1a5276; }
</style>
<div class="tp-article">
${cleaned}
</div>`;
}

async function generateContent(entry) {
  const templatePath = path.join(PROMPTS_DIR, `${entry.tipo}.txt`);
  const template = await fs.readFile(templatePath, 'utf-8');
  const prompt = fillTemplate(template, entry);

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return parseGeneratedContent(text);
}

async function searchPexelsImage(entry) {
  if (!PEXELS_API_KEY) return null;

  const queries = [
    `${entry.nombre} ${entry.provincia} Castilla La Mancha España`,
    `${entry.provincia} Castilla La Mancha España`,
    FALLBACK_QUERIES[entry.tipo] || 'paisaje Castilla La Mancha España'
  ];

  for (const query of queries) {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`, {
      headers: { Authorization: PEXELS_API_KEY }
    });

    if (!res.ok) continue;

    const data = await res.json();
    if (!data.photos || data.photos.length === 0) continue;

    const photo = data.photos.find((p) => {
      const text = `${p.alt || ''}`.toLowerCase();
      return !BLACKLIST_WORDS.some((word) => text.includes(word));
    });

    if (photo) {
      return {
        url: photo.src.large2x,
        alt: `${entry.nombre}, ${entry.provincia}`,
        credit: `Foto: ${photo.photographer} (Pexels)`
      };
    }
  }

  return null;
}

async function publishPage(entry, generated, parentId) {
  const body = {
    title: generated.title || entry.nombre,
    slug: entry.slug,
    content: generated.content,
    status: 'publish',
    parent: parentId,
    meta: {
      rank_math_title: generated.title || '',
      rank_math_description: generated.metaDescription || ''
    }
  };

  return wpFetch('pages', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function main() {
  const pages = JSON.parse(await fs.readFile(PAGES_FILE, 'utf-8'));
  const log = JSON.parse(await fs.readFile(LOG_FILE, 'utf-8'));
  const newlyPublished = [];

  for (const entry of pages) {
    if (entry.publicado) continue;

    console.log(`\nProcesando: ${entry.nombre} (${entry.tipo}, ${entry.provincia})...`);

    try {
      const parentId = await resolveParentId(entry);

      console.log('  -> Generando contenido con Claude...');
      const generated = await generateContent(entry);

      generated.content = wrapContent(generated.content);

      console.log('  -> Publicando en WordPress...');
      const result = await publishPage(entry, generated, parentId);

      entry.publicado = true;
      entry.wp_id = result.id;
      entry.wp_link = result.link;

      const logEntry = {
        id: entry.id,
        nombre: entry.nombre,
        tipo: entry.tipo,
        wp_id: result.id,
        wp_link: result.link,
        fecha: new Date().toISOString()
      };
      log.push(logEntry);
      newlyPublished.push(logEntry);

      await fs.writeFile(PAGES_FILE, JSON.stringify(pages, null, 2));
      await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2));

      console.log(`  OK Publicado: ${result.link}`);
    } catch (err) {
      console.error(`  ERROR en "${entry.nombre}": ${err.message}`);
    }
  }

  await submitToBing(newlyPublished, log);
}

/**
 * Envía a Bing solo las URLs recién publicadas y anota el resultado en cada entrada
 * del log (campo `bing`). Un fallo aquí se registra pero no detiene el pipeline.
 */
async function submitToBing(newlyPublished, log, linkKey = 'wp_link') {
  const urls = newlyPublished.map((e) => e[linkKey]).filter(Boolean);
  if (urls.length === 0) return;

  console.log(`\nEnviando ${urls.length} URL(s) nuevas a Bing...`);
  const fecha = new Date().toISOString();
  let outcome;
  try {
    const { submitUrls } = await import('./scripts/seo/bing-submit.js');
    const result = await submitUrls(urls, { log: (m) => console.log(`  ${m}`) });
    const submitted = new Set(result.submitted);
    const error = result.batches.find((b) => !b.ok)?.error || (result.notSubmitted.length ? 'Sin cuota diaria suficiente' : null);
    outcome = (url) => (submitted.has(url) ? { ok: true, fecha } : { ok: false, fecha, error });
    console.log(`  Bing: ${result.submitted.length}/${urls.length} enviadas${error ? ` (${error})` : ''}`);
  } catch (err) {
    console.error(`  ERROR enviando a Bing: ${err.message}`);
    outcome = () => ({ ok: false, fecha, error: err.message });
  }

  for (const entry of newlyPublished) {
    if (entry[linkKey]) entry.bing = outcome(entry[linkKey]);
  }
  try {
    await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error(`  ERROR guardando el resultado de Bing en el log: ${err.message}`);
  }
}

// ---------- Destino "web" (../turismo-clm-web) ----------

async function mainWeb() {
  const repoDir = web.webRepoDir();
  const env = web.webEnv();
  console.log(`Destino: web (${repoDir}), entorno ${env}`);

  const pages = JSON.parse(await fs.readFile(PAGES_FILE, 'utf-8'));
  const log = JSON.parse(await fs.readFile(LOG_FILE, 'utf-8'));
  if (!pages.some((e) => !e.publicado)) {
    console.log('No hay páginas pendientes.');
    return;
  }

  await web.prepareWebRepo(repoDir);
  const exp = await web.loadExport(repoDir);
  const exportDir = path.join(repoDir, 'export');
  const newlyPublished = [];

  for (const entry of pages) {
    if (entry.publicado) continue;

    console.log(`\nProcesando: ${entry.nombre} (${entry.tipo}, ${entry.provincia})...`);

    try {
      // Comprueba el padre antes de gastar una llamada a Claude.
      web.resolveWebParent(exp, entry);

      console.log('  -> Generando contenido con Claude...');
      const generated = await generateContent(entry);
      generated.content = wrapContent(generated.content);

      console.log('  -> Añadiendo al export de la web...');
      const item = web.buildWebEntry(exp, entry, generated);
      try {
        await web.writeExport(exportDir, exp, [item]);
      } catch (err) {
        exp.pages.pop();
        throw err;
      }

      entry.publicado = true;
      entry.destino = 'web';
      entry.web_id = item.id;
      entry.web_link = item.link;

      const logEntry = {
        id: entry.id,
        nombre: entry.nombre,
        tipo: entry.tipo,
        destino: 'web',
        web_id: item.id,
        web_link: item.link,
        fecha: new Date().toISOString()
      };
      log.push(logEntry);
      newlyPublished.push(logEntry);

      await fs.writeFile(PAGES_FILE, JSON.stringify(pages, null, 2));
      await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2));

      console.log(`  OK Añadida: ${item.link} (id ${item.id}, padre ${item.parent})`);
    } catch (err) {
      console.error(`  ERROR en "${entry.nombre}": ${err.message}`);
    }
  }

  if (newlyPublished.length === 0) return;

  const saveLog = async () => {
    try {
      await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2));
    } catch (err) {
      console.error(`  ERROR guardando el log: ${err.message}`);
    }
  };
  const setAll = (key, value) => newlyPublished.forEach((e) => (e[key] = value));

  // Commit, push y despliegue. Si algo falla, se anota en el log y no se avisa a buscadores.
  try {
    console.log(`\nCommit y push en ${repoDir}...`);
    const { commit, message } = await web.commitAndPush(repoDir, newlyPublished.length);
    console.log(`  ${commit} ${message}`);
    setAll('despliegue', { ok: false, commit, fecha: new Date().toISOString(), error: 'Despliegue no completado' });

    console.log(`\nDesplegando: ${web.deployCommand()}`);
    await web.deploy();
    setAll('despliegue', { ok: true, commit, fecha: new Date().toISOString() });
  } catch (err) {
    console.error(`  ERROR publicando la web: ${err.message}`);
    for (const e of newlyPublished) {
      e.despliegue = { ...(e.despliegue || {}), ok: false, fecha: new Date().toISOString(), error: err.message };
    }
    await saveLog();
    process.exitCode = 1;
    return;
  }
  await saveLog();

  if (env !== 'production') {
    console.log('\nWEB_ENV=staging: no se avisa a IndexNow ni a Bing.');
    return;
  }

  const urls = newlyPublished.map((e) => e.web_link);
  console.log(`\nAvisando a IndexNow de ${urls.length} URL(s)...`);
  try {
    await web.indexNow(urls);
    setAll('indexnow', { ok: true, fecha: new Date().toISOString() });
  } catch (err) {
    console.error(`  ERROR enviando a IndexNow: ${err.message}`);
    setAll('indexnow', { ok: false, fecha: new Date().toISOString(), error: err.message });
  }
  await saveLog();

  await submitToBing(newlyPublished, log, 'web_link');
}

const SAMPLE_ENTRY = {
  id: 'pueblo-de-prueba',
  tipo: 'pueblo',
  provincia: 'Toledo',
  nombre: 'Pueblo de Prueba',
  slug: 'pueblo-de-prueba',
  grandparent_slug: 'turismo-toledo',
  parent_slug: 'pueblos-de-toledo'
};

const SAMPLE_HTML = `<h2>Qué ver en {{nombre}}</h2>
<p>Página de prueba generada por el modo <strong>--dry-run</strong> del pipeline. {{nombre}} es un pueblo de la provincia de {{provincia}}.</p>
<h3>Monumentos</h3>
<ul>
<li>Iglesia parroquial</li>
<li>Plaza Mayor</li>
</ul>`;

/**
 * Simula la publicación en la web de una página de prueba: sin Claude, sin tocar
 * el repo de la web, sin marcar nada como publicado y sin desplegar.
 */
async function dryRunWeb() {
  const repoDir = web.webRepoDir();
  const pages = JSON.parse(await fs.readFile(PAGES_FILE, 'utf-8'));
  const entry = pages.find((e) => !e.publicado) || SAMPLE_ENTRY;
  console.log(`[dry-run] Destino web (${repoDir}), WEB_ENV=${web.webEnv()}`);
  if (PUBLISH_TARGET !== 'web') console.log(`[dry-run] Nota: PUBLISH_TARGET=${PUBLISH_TARGET}; el dry-run siempre simula el destino web.`);
  console.log(`[dry-run] Página: ${entry.nombre} (${entry === SAMPLE_ENTRY ? 'ejemplo, no hay pendientes' : 'primera pendiente'})`);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'turismo-web-dry-run-'));
  await fs.copyFile(path.join(repoDir, 'export/urls.csv'), path.join(tmpDir, 'urls.csv'));

  const exp = await web.loadExport(repoDir);
  const generated = {
    title: `Qué ver en ${entry.nombre} (${entry.provincia})`,
    metaDescription: `Descubre qué ver en ${entry.nombre}, en la provincia de ${entry.provincia}: monumentos, rutas y gastronomía.`,
    content: wrapContent(fillTemplate(SAMPLE_HTML, entry))
  };
  const item = web.buildWebEntry(exp, entry, generated);
  await web.writeExport(tmpDir, exp, [item]);
  await fs.writeFile(path.join(tmpDir, 'entrada.json'), JSON.stringify(item, null, 2) + '\n');

  console.log('\nEntrada resultante:');
  console.log(JSON.stringify(item, null, 2));
  console.log(`\nFila de urls.csv: ${web.csvRow(item)}`);
  console.log(`URL: ${item.link}`);
  console.log(`\nArchivos en ${tmpDir}: entrada.json, paginas.json, urls.csv`);
  console.log('Sin dry-run se haría: commit "Pipeline: N páginas nuevas" + push,');
  console.log(`  ${web.deployCommand()}`);
  console.log(web.webEnv() === 'production' ? '  y avisos a IndexNow y Bing.' : '  y ningún aviso a buscadores (staging).');
}

if (DRY_RUN) {
  dryRunWeb().catch((err) => {
    console.error(`ERROR en dry-run: ${err.message}`);
    process.exitCode = 1;
  });
} else if (PUBLISH_TARGET === 'web') {
  mainWeb().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  });
} else if (PUBLISH_TARGET === 'wordpress') {
  main();
} else {
  console.error(`PUBLISH_TARGET no válido: "${PUBLISH_TARGET}" (usa "wordpress" o "web")`);
  process.exitCode = 1;
}
