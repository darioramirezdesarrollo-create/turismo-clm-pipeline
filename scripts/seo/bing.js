import fs from 'node:fs';
import { requireEnv, requireFileEnv, saveResult, top, runIfMain } from './lib.js';

const API = 'https://ssl.bing.com/webmaster/api.svc/json/';

/** Bing devuelve fechas como "/Date(1699999999999-0800)/". */
const parseDate = (v) => {
  const m = typeof v === 'string' && v.match(/\/Date\((\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : v;
};
const normalize = (rows) => (rows || []).map((r) => ({ ...r, Date: parseDate(r.Date) }));

async function call(method, siteUrl, apikey) {
  const url = `${API}${method}?${new URLSearchParams({ siteUrl, apikey })}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`Bing ${method} HTTP ${res.status}: ${body}`);
  return normalize(JSON.parse(body).d);
}

export async function runBing() {
  const siteUrl = process.env.BING_SITE || requireEnv('GSC_SITE');
  const apikey = fs.readFileSync(requireFileEnv('BING_API_KEY_FILE'), 'utf8').trim();

  const [rankAndTraffic, queries, pages] = await Promise.all([
    call('GetRankAndTrafficStats', siteUrl, apikey),
    call('GetQueryStats', siteUrl, apikey),
    call('GetPageStats', siteUrl, apikey),
  ]);

  const cutoff = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
  const last28 = rankAndTraffic.filter((r) => r.Date >= cutoff);
  const clicks = last28.reduce((s, r) => s + (r.Clicks || 0), 0);
  const impressions = last28.reduce((s, r) => s + (r.Impressions || 0), 0);

  const data = { source: 'bing', siteUrl, totalsLast28Days: { clicks, impressions }, rankAndTraffic, queries, pages };
  const file = saveResult('bing', data);

  const byClicks = (a, b) => (b.Clicks || 0) - (a.Clicks || 0);
  console.log('\n== Bing Webmaster ==');
  console.log(`Últimos 28 días → Clics: ${clicks} | Impresiones: ${impressions} | Queries: ${queries.length} | Páginas: ${pages.length}`);
  console.log('Top queries (clics / impr):');
  top([...queries].sort(byClicks)).forEach((q) => console.log(`  ${q.Clicks} / ${q.Impressions}\t${q.Query}`));
  console.log(`Guardado en ${file}`);
  return data;
}

runIfMain(import.meta.url, runBing);
