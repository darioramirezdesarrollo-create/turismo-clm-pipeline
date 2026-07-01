import dotenv from 'dotenv';
dotenv.config({ override: true });
import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const { WP_URL, WP_USER, WP_APP_PASSWORD, ANTHROPIC_API_KEY } = process.env;

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

      log.push({
        id: entry.id,
        nombre: entry.nombre,
        tipo: entry.tipo,
        wp_id: result.id,
        wp_link: result.link,
        fecha: new Date().toISOString()
      });

      await fs.writeFile(PAGES_FILE, JSON.stringify(pages, null, 2));
      await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2));

      console.log(`  OK Publicado: ${result.link}`);
    } catch (err) {
      console.error(`  ERROR en "${entry.nombre}": ${err.message}`);
    }
  }
}

main();
