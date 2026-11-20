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

export async function runBingSubmit() {
  const siteUrl = process.env.BING_SITE || requireEnv('GSC_SITE');
  const apikey = fs.readFileSync(requireFileEnv('BING_API_KEY_FILE'), 'utf8').trim();

  // 1. Cuota
  const quota = (await bing('GetUrlSubmissionQuota', apikey, { query: { siteUrl } }))?.d || {};
  console.log(`\n== Bing SubmitUrlBatch (${siteUrl}) ==`);
  console.log(`Cuota restante: diaria ${quota.DailyQuota} | mensual ${quota.MonthlyQuota}`);

  // 2. URLs del sitemap
  const { sitemaps, urls: entries } = await collectUrls();
  const urls = [...new Map(entries.map((e) => [norm(e.url), e])).values()];
  console.log(`Sitemap: ${urls.length} URLs únicas en ${sitemaps.length} sitemaps`);

  // 3. Priorizar las que Bing nunca ha mostrado
  const seen = lastBingPages();
  const neverShown = urls.filter((e) => !seen.pages.has(norm(e.url)));
  const shown = urls.filter((e) => seen.pages.has(norm(e.url)));
  console.log(`Referencia: ${seen.file || '(sin bing.json previo)'} → ${neverShown.length} nunca mostradas, ${shown.length} ya mostradas`);

  const limit = Math.max(0, Math.min(quota.DailyQuota ?? 0, quota.MonthlyQuota ?? Infinity));
  const toSend = [...neverShown, ...shown].slice(0, limit);

  const batches = [];
  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    const urlList = toSend.slice(i, i + BATCH_SIZE).map((e) => e.url);
    const batch = { urlList, neverShown: urlList.filter((u) => !seen.pages.has(norm(u))).length };
    try {
      batch.response = await bing('SubmitUrlBatch', apikey, { body: { siteUrl, urlList } });
      batch.ok = true;
    } catch (err) {
      batch.ok = false;
      batch.error = err.message;
    }
    batches.push(batch);
    console.log(`  Lote ${batches.length}: ${urlList.length} URLs → ${batch.ok ? 'OK' : batch.error}`);
    if (!batch.ok) break; // un error (cuota, clave, sitio) afectaría al resto
  }

  const quotaAfter = (await bing('GetUrlSubmissionQuota', apikey, { query: { siteUrl } }).catch(() => null))?.d || null;

  const sentOk = batches.filter((b) => b.ok).flatMap((b) => b.urlList);
  const sentSet = new Set(sentOk.map(norm));
  const pending = urls.filter((e) => !sentSet.has(norm(e.url))).map((e) => e.url);
  const file = saveResult('bing-submit', {
    source: 'bing-submit', siteUrl, reference: seen.file, quotaBefore: quota, quotaAfter,
    sitemaps, totalUrls: urls.length, neverShown: neverShown.length,
    submitted: sentOk.length, batches, notSubmitted: pending,
  });

  console.log(`Enviadas: ${sentOk.length}/${urls.length} (${sentOk.filter((u) => !seen.pages.has(norm(u))).length} nunca mostradas)`);
  if (pending.length) console.log(`Sin enviar: ${pending.length} (cuota o error)`);
  if (quotaAfter) console.log(`Cuota tras el envío: diaria ${quotaAfter.DailyQuota} | mensual ${quotaAfter.MonthlyQuota}`);
  console.log(`Guardado en ${file}`);
  if (batches.some((b) => !b.ok)) process.exitCode = 1;
}

runIfMain(import.meta.url, runBingSubmit);
