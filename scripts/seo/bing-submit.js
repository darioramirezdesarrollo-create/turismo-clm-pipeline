import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireEnv, requireFileEnv, saveResult, runIfMain } from './lib.js';
import { collectUrls } from './index.js';

const API = 'https://ssl.bing.com/webmaster/api.svc/json/';
const BATCH_SIZE = 100;
const SEO_DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../seo-data');

/** Compara URLs sin importar mayúsculas, protocolo ni barra final. */
const norm = (u) => u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

async function bing(method, apikey, { query = {}, body } = {}) {
  const url = `${API}${method}?${new URLSearchParams({ ...query, apikey })}`;
  const res = await fetch(url, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }
    : undefined);
  const text = await res.text();
  if (!res.ok) throw new Error(`Bing ${method} HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** pagesAllTime del bing.json más reciente en seo-data/AAAA-MM-DD/. */
function lastBingPages() {
  const dirs = fs.existsSync(SEO_DATA) ? fs.readdirSync(SEO_DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const file = path.join(SEO_DATA, d, 'bing.json');
    if (fs.existsSync(file)) {
      const { pagesAllTime = [] } = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { file: path.relative(path.dirname(SEO_DATA), file), pages: new Set(pagesAllTime.map((p) => norm(p.Page))) };
    }
  }
  return { file: null, pages: new Set() };
}

function bingConfig() {
  return {
    siteUrl: process.env.BING_SITE || requireEnv('GSC_SITE'),
    apikey: fs.readFileSync(requireFileEnv('BING_API_KEY_FILE'), 'utf8').trim(),
  };
}

const getQuota = async ({ siteUrl, apikey }) =>
  (await bing('GetUrlSubmissionQuota', apikey, { query: { siteUrl } }))?.d || {};

/**
 * Envía URLs a Bing (SubmitUrlBatch) en lotes de hasta 100 sin pasarse de la cuota.
 * Las URLs se envían en el orden dado. Si un lote falla, se detiene y lo registra en `batches`.
 * Lanza si no se puede leer la configuración o la cuota.
 */
export async function submitUrls(urls, { log = () => {} } = {}) {
  const config = bingConfig();
  const { siteUrl, apikey } = config;
  const quotaBefore = await getQuota(config);
  log(`Cuota Bing restante: diaria ${quotaBefore.DailyQuota} | mensual ${quotaBefore.MonthlyQuota}`);

  const limit = Math.max(0, Math.min(quotaBefore.DailyQuota ?? 0, quotaBefore.MonthlyQuota ?? Infinity));
  const toSend = urls.slice(0, limit);

  const batches = [];
  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    const urlList = toSend.slice(i, i + BATCH_SIZE);
    const batch = { urlList };
    try {
      batch.response = await bing('SubmitUrlBatch', apikey, { body: { siteUrl, urlList } });
      batch.ok = true;
    } catch (err) {
      batch.ok = false;
      batch.error = err.message;
    }
    batches.push(batch);
    log(`  Lote ${batches.length}: ${urlList.length} URLs → ${batch.ok ? 'OK' : batch.error}`);
    if (!batch.ok) break; // un error (cuota, clave, sitio) afectaría al resto
  }

  const quotaAfter = await getQuota(config).catch(() => null);
  const submitted = batches.filter((b) => b.ok).flatMap((b) => b.urlList);
  const sentSet = new Set(submitted);
  const notSubmitted = urls.filter((u) => !sentSet.has(u));
  return { siteUrl, quotaBefore, quotaAfter, batches, submitted, notSubmitted, ok: notSubmitted.length === 0 };
}

export async function runBingSubmit() {
  const { siteUrl } = bingConfig();
  console.log(`\n== Bing SubmitUrlBatch (${siteUrl}) ==`);

  // URLs del sitemap
  const { sitemaps, urls: entries } = await collectUrls();
  const urls = [...new Map(entries.map((e) => [norm(e.url), e.url])).values()];
  console.log(`Sitemap: ${urls.length} URLs únicas en ${sitemaps.length} sitemaps`);

  // Priorizar las que Bing nunca ha mostrado
  const seen = lastBingPages();
  const isNew = (u) => !seen.pages.has(norm(u));
  const neverShown = urls.filter(isNew);
  console.log(`Referencia: ${seen.file || '(sin bing.json previo)'} → ${neverShown.length} nunca mostradas, ${urls.length - neverShown.length} ya mostradas`);

  const result = await submitUrls([...neverShown, ...urls.filter((u) => !isNew(u))], { log: console.log });
  result.batches.forEach((b) => { b.neverShown = b.urlList.filter(isNew).length; });

  const { quotaBefore, quotaAfter, batches, submitted, notSubmitted } = result;
  const file = saveResult('bing-submit', {
    source: 'bing-submit', siteUrl, reference: seen.file, quotaBefore, quotaAfter,
    sitemaps, totalUrls: urls.length, neverShown: neverShown.length,
    submitted: submitted.length, batches, notSubmitted,
  });

  console.log(`Enviadas: ${submitted.length}/${urls.length} (${submitted.filter(isNew).length} nunca mostradas)`);
  if (notSubmitted.length) console.log(`Sin enviar: ${notSubmitted.length} (cuota o error)`);
  if (quotaAfter) console.log(`Cuota tras el envío: diaria ${quotaAfter.DailyQuota} | mensual ${quotaAfter.MonthlyQuota}`);
  console.log(`Guardado en ${file}`);
  if (batches.some((b) => !b.ok)) process.exitCode = 1;
}

runIfMain(import.meta.url, runBingSubmit);
