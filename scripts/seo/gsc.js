import { google } from 'googleapis';
import { last28Days, requireEnv, requireFileEnv, saveResult, top, runIfMain } from './lib.js';

export async function runGsc() {
  requireFileEnv('GOOGLE_APPLICATION_CREDENTIALS');
  const siteUrl = requireEnv('GSC_SITE');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  const sc = google.searchconsole({ version: 'v1', auth });
  const range = last28Days();

  const query = async (dimension) => {
    const { data } = await sc.searchanalytics.query({
      siteUrl,
      requestBody: { ...range, dimensions: [dimension], rowLimit: 1000 },
    });
    return (data.rows || []).map((r) => ({
      [dimension]: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
    }));
  };

  const [byQuery, byPage] = await Promise.all([query('query'), query('page')]);
  const clicks = byPage.reduce((s, r) => s + r.clicks, 0);
  const impressions = byPage.reduce((s, r) => s + r.impressions, 0);

  const data = { source: 'gsc', siteUrl, dateRange: range, totals: { clicks, impressions }, byQuery, byPage };
  const file = saveResult('gsc', data);

  console.log(`\n== Search Console (${range.startDate} → ${range.endDate}) ==`);
  console.log(`Clics: ${clicks} | Impresiones: ${impressions} | Queries: ${byQuery.length} | Páginas: ${byPage.length}`);
  console.log('Top queries (clics / impr / pos):');
  top(byQuery).forEach((q) => console.log(`  ${q.clicks} / ${q.impressions} / ${q.position.toFixed(1)}\t${q.query}`));
  console.log(`Guardado en ${file}`);
  return data;
}

runIfMain(import.meta.url, runGsc);
