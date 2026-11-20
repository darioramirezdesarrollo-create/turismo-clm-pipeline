import { google } from 'googleapis';
import { requireEnv, requireFileEnv, saveResult, runIfMain } from './lib.js';

const SITEMAP_INDEX = 'https://turismoencastillalamancha.es/sitemap_index.xml';
const PAUSE_MS = 150; // Límite URL Inspection API: 600/min y 2000/día por propiedad.
const DAILY_QUOTA = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();

async function fetchXml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sitemap ${url} HTTP ${res.status}`);
  return res.text();
}

/** <loc> directo de cada <sitemap>/<url>, ignorando <image:loc>. */
const locsIn = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}>\\s*<loc>([\\s\\S]*?)</loc>`, 'g'))].map((m) => clean(m[1]));

/** Sitemaps esperados: páginas, entradas, bodegas y restaurantes. El resto (da_image, categorías…) se avisa. */
const isExpectedSitemap = (sitemapUrl) => /\/(page|post|bodega|restaurante)-sitemap\d*\.xml$/.test(sitemapUrl);

export async function collectUrls() {
  const sitemaps = locsIn(await fetchXml(SITEMAP_INDEX), 'sitemap');
  const urls = [];
  for (const sitemap of sitemaps) {
    for (const url of locsIn(await fetchXml(sitemap), 'url')) urls.push({ url, sitemap });
  }
  return { sitemaps, urls };
}

export async function runIndex() {
  requireFileEnv('GOOGLE_APPLICATION_CREDENTIALS');
  const siteUrl = requireEnv('GSC_SITE');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  const sc = google.searchconsole({ version: 'v1', auth });

  const { sitemaps, urls } = await collectUrls();
  if (urls.length > DAILY_QUOTA) {
    throw new Error(`El sitemap tiene ${urls.length} URLs y la cuota diaria es ${DAILY_QUOTA}.`);
  }
  console.log(`Inspeccionando ${urls.length} URLs de ${sitemaps.length} sitemaps…`);

  const results = [];
  for (const [i, { url, sitemap }] of urls.entries()) {
    if (i > 0) await sleep(PAUSE_MS);
    try {
      const { data } = await sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: url, siteUrl } });
      const r = data.inspectionResult?.indexStatusResult || {};
      results.push({
        url, sitemap,
        verdict: r.verdict, coverageState: r.coverageState, indexingState: r.indexingState,
        pageFetchState: r.pageFetchState, robotsTxtState: r.robotsTxtState,
        googleCanonical: r.googleCanonical, userCanonical: r.userCanonical, lastCrawlTime: r.lastCrawlTime,
      });
    } catch (err) {
      // 401/403/429 afectan a todas las URLs: abortar con el mensaje exacto de la API.
      if ([401, 403, 429].includes(err.code)) throw new Error(`URL Inspection HTTP ${err.code}: ${err.message}`);
      results.push({ url, sitemap, error: err.message });
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${urls.length}`);
  }

  const file = saveResult('index', { source: 'gsc-url-inspection', siteUrl, sitemapIndex: SITEMAP_INDEX, sitemaps, results });
  printSummary(sitemaps, results);
  console.log(`Guardado en ${file}`);
  return results;
}

function printSummary(sitemaps, results) {
  const countBy = (key) =>
    results.reduce((m, r) => m.set(r[key] ?? '(error)', (m.get(r[key] ?? '(error)') || 0) + 1), new Map());

  console.log('\n== Indexación en Google (URL Inspection) ==');
  console.log('URLs por sitemap:');
  for (const [s, n] of countBy('sitemap')) console.log(`  ${n}\t${s}`);

  console.log('Por coverageState:');
  for (const [s, n] of [...countBy('coverageState')].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${s}`);

  const notIndexed = results.filter((r) => r.verdict !== 'PASS');
  console.log(`No indexadas (${notIndexed.length}):`);
  notIndexed.forEach((r) => console.log(`  ${r.url}\n    → ${r.error || `${r.coverageState} [${r.verdict}]`}`));

  const canonMismatch = results.filter((r) => r.googleCanonical && r.userCanonical && r.googleCanonical !== r.userCanonical);
  console.log(`Canonical de Google distinto del declarado (${canonMismatch.length}):`);
  canonMismatch.forEach((r) => console.log(`  ${r.url}\n    usuario: ${r.userCanonical}\n    google:  ${r.googleCanonical}`));

  const odd = sitemaps.filter((s) => !isExpectedSitemap(s));
  if (odd.length) {
    console.log('\n⚠ AVISO: sitemaps que no son de páginas, entradas, bodegas ni restaurantes:');
    odd.forEach((s) => console.log(`  ${s}${/da_image/.test(s) ? '  (da_image)' : ''}`));
  }
}

runIfMain(import.meta.url, runIndex);
