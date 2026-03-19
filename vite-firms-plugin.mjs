/**
 * vite-firms-plugin.mjs
 * Proxies NASA FIRMS through Node.js — no CORS, no browser restrictions.
 * Tries multiple datasets in order until one returns actual fire records.
 */
import https from 'https';

function fetchNASA(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Dodoco/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      },
      timeout: 25000,
    }, (res) => {
      let data = '';
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return reject(new Error(`NASA redirected to ${res.headers.location} — key invalid`));
      }
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

export function firmsProxyPlugin() {
  return {
    name: 'firms-proxy',
    configureServer(server) {
      server.middlewares.use('/firms-live', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const key = url.searchParams.get('key');

        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing ?key= param' }));
        }

        const BASE = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}`;

        // Try datasets in order — use 2 days to get more records
        const attempts = [
          `${BASE}/VIIRS_SNPP_NRT/world/2`,
          `${BASE}/VIIRS_NOAA20_NRT/world/2`,
          `${BASE}/MODIS_NRT/world/2`,
          `${BASE}/VIIRS_SNPP_NRT/world/1`,
          `${BASE}/MODIS_NRT/world/1`,
        ];

        let lastError = '';
        for (const nasaUrl of attempts) {
          try {
            console.log(`[firms-proxy] → ${nasaUrl}`);
            const { status, body } = await fetchNASA(nasaUrl);

            if (body.trim().startsWith('<')) {
              lastError = 'NASA returned HTML (key may be invalid)';
              console.warn(`[firms-proxy] HTML response from ${nasaUrl}`);
              continue;
            }

            const lines = body.trim().split('\n').filter(l => l.trim());
            const recordCount = lines.length - 1; // subtract header

            console.log(`[firms-proxy] ${status} — ${body.length} chars, ${recordCount} records`);

            if (recordCount <= 0) {
              lastError = `0 records from ${nasaUrl.split('/').slice(-3).join('/')}`;
              console.warn(`[firms-proxy] ⚠ No data rows — trying next dataset...`);
              continue;
            }

            // Success — return the CSV
            console.log(`[firms-proxy] ✅ Returning ${recordCount} fire records`);
            res.writeHead(200, {
              'Content-Type': 'text/csv; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'X-FIRMS-Records': String(recordCount),
              'X-FIRMS-Source': nasaUrl.split(key + '/')[1],
            });
            return res.end(body);

          } catch (err) {
            lastError = err.message;
            console.warn(`[firms-proxy] ⚠ Failed: ${err.message}`);
            continue;
          }
        }

        // All attempts failed
        console.error(`[firms-proxy] ❌ All datasets returned 0 records. Last error: ${lastError}`);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `All NASA FIRMS datasets returned 0 records. This can happen with a brand-new key (wait 1-2 hours) or if your daily transaction limit is exhausted.`,
          lastError,
          tip: `Check transactions at: https://firms.modaps.eosdis.nasa.gov/api/transaction/${key}`,
        }));
      });
    },
  };
}
