import fs from 'node:fs';
import { requireEnv, requireFileEnv, saveResult, top, runIfMain, last28Days } from './lib.js';

const API = 'https://ssl.bing.com/webmaster/api.svc/json/';

/** Bing devuelve fechas como "/Date(1699999999999-0800)/". */
const parseDate = (v) => {
  const m = typeof v === 'string' && v.match(/\/Date\((\d+)/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : v;
};
const normalize = (rows) => (rows || []).map((r) => ({ ...r, Date: parseDate(r.Date) }));

/**
 * GetQueryStats/GetPageStats devuelven una fila por día y clave (la URL de página
 * también viene en el campo `Query`). Agrega por clave: suma clics e impresiones y
 * pondera la posición media por impresiones (la de clic, por clics; -1 = sin dato).
 */
function aggregate(rows, keyName) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.Query) || { key: r.Query, clicks: 0, impressions: 0, impPos: 0, clickPos: 0, clickPosW: 0, days: 0 };
    const clicks = r.Clicks || 0;
    const impressions = r.Impressions || 0;
    g.clicks += clicks;
    g.impressions += impressions;
    if (r.AvgImpressionPosition > 0) g.impPos += r.AvgImpressionPosition * impressions;
    if (r.AvgClickPosition > 0 && clicks > 0) {
      g.clickPos += r.AvgClickPosition * clicks;
      g.clickPosW += clicks;
    }
    g.days += 1;
    groups.set(r.Query, g);
  }
  const round = (n) => Math.round(n * 10) / 10;
  return [...groups.values()].map((g) => ({
    [keyName]: g.key,
    Clicks: g.clicks,
    Impressions: g.impressions,
    AvgImpressionPosition: g.impressions ? round(g.impPos / g.impressions) : -1,
    AvgClickPosition: g.clickPosW ? round(g.clickPos / g.clickPosW) : -1,
    Days: g.days,
  }));
}

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

  const [rankAndTraffic, queriesDaily, pagesDaily] = await Promise.all([
    call('GetRankAndTrafficStats', siteUrl, apikey),
    call('GetQueryStats', siteUrl, apikey),
    call('GetPageStats', siteUrl, apikey),
  ]);

  // Mismo rango que GA4 y GSC: últimos 28 días completos (excluye hoy).
  const { startDate, endDate } = last28Days();
  const inRange = (r) => r.Date >= startDate && r.Date <= endDate;

  const queries = aggregate(queriesDaily.filter(inRange), 'Query');
  const pages = aggregate(pagesDaily.filter(inRange), 'Page');
  const queriesAllTime = aggregate(queriesDaily, 'Query');
  const pagesAllTime = aggregate(pagesDaily, 'Page');

  const last28 = rankAndTraffic.filter(inRange);
  const clicks = last28.reduce((s, r) => s + (r.Clicks || 0), 0);
  const impressions = last28.reduce((s, r) => s + (r.Impressions || 0), 0);

  const data = {
    source: 'bing', siteUrl, startDate, endDate,
    totalsLast28Days: { clicks, impressions },
    rankAndTraffic, queries, pages, queriesAllTime, pagesAllTime, queriesDaily, pagesDaily,
  };
  const file = saveResult('bing', data);

  const byClicks = (a, b) => (b.Clicks || 0) - (a.Clicks || 0);
  console.log(`\n== Bing Webmaster (${startDate} → ${endDate}) ==`);
  console.log(`Clics: ${clicks} | Impresiones: ${impressions} | Queries: ${queries.length} | Páginas: ${pages.length}`);
  console.log('Top queries (clics / impr):');
  top([...queries].sort(byClicks)).forEach((q) => console.log(`  ${q.Clicks} / ${q.Impressions}\t${q.Query}`));
  console.log(`Guardado en ${file}`);
  return data;
}

runIfMain(import.meta.url, runBing);
