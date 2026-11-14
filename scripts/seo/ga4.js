import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { last28Days, requireEnv, requireFileEnv, saveResult, top, runIfMain } from './lib.js';

const toRows = ([res]) =>
  (res.rows || []).map((r) => ({
    ...Object.fromEntries(res.dimensionHeaders.map((h, i) => [h.name, r.dimensionValues[i].value])),
    ...Object.fromEntries(res.metricHeaders.map((h, i) => [h.name, Number(r.metricValues[i].value)])),
  }));

export async function runGa4() {
  requireFileEnv('GOOGLE_APPLICATION_CREDENTIALS');
  const property = requireEnv('GA4_PROPERTY');
  const client = new BetaAnalyticsDataClient();
  const dateRanges = [last28Days()];

  const [totals, pages, channels] = await Promise.all([
    client.runReport({ property, dateRanges, metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }] }),
    client.runReport({
      property, dateRanges,
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 1000,
    }),
    client.runReport({
      property, dateRanges,
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
  ]);

  const data = {
    source: 'ga4', property, dateRange: dateRanges[0],
    totals: toRows(totals)[0] || { sessions: 0, totalUsers: 0, screenPageViews: 0 },
    byPage: toRows(pages),
    byChannel: toRows(channels),
  };
  const file = saveResult('ga4', data);

  console.log(`\n== GA4 (${data.dateRange.startDate} → ${data.dateRange.endDate}) ==`);
  console.log(`Sesiones: ${data.totals.sessions} | Usuarios: ${data.totals.totalUsers} | Vistas: ${data.totals.screenPageViews}`);
  console.log('Canales:', data.byChannel.map((c) => `${c.sessionDefaultChannelGroup} ${c.sessions}`).join(', ') || '—');
  console.log('Top páginas:');
  top(data.byPage).forEach((p) => console.log(`  ${p.screenPageViews}\t${p.pagePath}`));
  console.log(`Guardado en ${file}`);
  return data;
}

runIfMain(import.meta.url, runGa4);
