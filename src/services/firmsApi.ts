import type { FIRMSRecord, FireEvent, Intensity } from './apiTypes';
import { computeBiodiversityScore } from './biodiversityScore';

const FIRMS_KEY = import.meta.env.VITE_FIRMS_MAP_KEY as string;

/**
 * Fetches live NASA FIRMS fire data.
 *
 * In development:  calls /firms-live?key=...  → Vite middleware (vite-firms-plugin.mjs)
 *                  fetches from NASA via Node.js, bypassing CORS entirely.
 *
 * In production:   calls /firms-live?key=...  → must be handled by your server/CDN:
 *                  - Vercel:  vercel.json rewrites (included)
 *                  - Netlify: public/_redirects (included)
 *                  - Other:   set up a reverse proxy to firms.modaps.eosdis.nasa.gov
 */
export async function fetchActiveFires(): Promise<FireEvent[]> {
  if (!FIRMS_KEY) {
    throw new Error('VITE_FIRMS_MAP_KEY is not set in your .env file');
  }

  const proxyUrl = `/firms-live?key=${encodeURIComponent(FIRMS_KEY)}&source=VIIRS_SNPP_NRT&area=world&days=1`;

  console.info('[FIRMS] Fetching:', proxyUrl);

  let res: Response;
  try {
    res = await fetch(proxyUrl, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new Error(`[FIRMS] Network error: ${err?.message ?? String(err)}`);
  }

  const body = await res.text();

  if (!res.ok) {
    // Try to parse JSON error from proxy
    try {
      const json = JSON.parse(body);
      throw new Error(`[FIRMS] Proxy error ${res.status}: ${json.error}`);
    } catch {
      throw new Error(`[FIRMS] HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
  }

  // Detect HTML (login redirect or error page from NASA)
  if (body.trim().startsWith('<')) {
    throw new Error(
      '[FIRMS] Got HTML from NASA — your API key may be invalid or expired. ' +
      'Check it at: https://firms.modaps.eosdis.nasa.gov/api/'
    );
  }

  const records = parseCSV(body);
  console.info(`[FIRMS] Parsed ${records.length} raw detections`);

  if (records.length === 0) {
    throw new Error('[FIRMS] 0 records returned — unusual, check key & date range');
  }

  const clusters = clusterFires(records);
  console.info(`[FIRMS] ✅ ${clusters.length} fire clusters ready`);

  return clusters.map((cluster, idx) => clusterToFireEvent(cluster, idx));
}

// ─── CSV Parser ────────────────────────────────────────────────────────────────

function parseCSV(csv: string): FIRMSRecord[] {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

  const get = (row: Record<string, string>, ...keys: string[]) => {
    for (const k of keys) if (row[k] !== undefined) return row[k];
    return '';
  };

  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });

    return {
      latitude:   parseFloat(get(row, 'latitude', 'lat') || '0'),
      longitude:  parseFloat(get(row, 'longitude', 'lon', 'lng') || '0'),
      bright_ti4: parseFloat(get(row, 'bright_ti4', 'brightness') || '0'),
      scan:       parseFloat(row.scan || '0'),
      track:      parseFloat(row.track || '0'),
      acq_date:   get(row, 'acq_date', 'date') || '',
      acq_time:   get(row, 'acq_time', 'time') || '',
      satellite:  row.satellite || '',
      confidence: get(row, 'confidence', 'conf') || 'n',
      version:    row.version || '',
      bright_ti5: parseFloat(row.bright_ti5 || '0'),
      frp:        parseFloat(row.frp || '0'),
      daynight:   row.daynight || '',
    };
  }).filter(r => !isNaN(r.latitude) && !isNaN(r.longitude) && r.latitude !== 0 && r.longitude !== 0);
}

// ─── Clustering ────────────────────────────────────────────────────────────────

const CLUSTER_RADIUS_DEG = 0.45; // ~50 km

function clusterFires(records: FIRMSRecord[]): FIRMSRecord[][] {
  const assigned = new Set<number>();
  const clusters: FIRMSRecord[][] = [];
  const sorted = [...records].sort((a, b) => b.frp - a.frp);

  for (let i = 0; i < sorted.length; i++) {
    if (assigned.has(i)) continue;
    const seed = sorted[i];
    const cluster: FIRMSRecord[] = [seed];
    assigned.add(i);

    for (let j = i + 1; j < sorted.length; j++) {
      if (assigned.has(j)) continue;
      const r = sorted[j];
      if (
        Math.abs(r.latitude - seed.latitude) < CLUSTER_RADIUS_DEG &&
        Math.abs(r.longitude - seed.longitude) < CLUSTER_RADIUS_DEG
      ) {
        cluster.push(r);
        assigned.add(j);
      }
    }
    clusters.push(cluster);
  }

  // Top 60 clusters by fire radiative power
  return clusters.sort((a, b) => totalFRP(b) - totalFRP(a)).slice(0, 60);
}

function totalFRP(cluster: FIRMSRecord[]): number {
  return cluster.reduce((s, r) => s + r.frp, 0);
}

// ─── Cluster → FireEvent ───────────────────────────────────────────────────────

function clusterToFireEvent(cluster: FIRMSRecord[], idx: number): FireEvent {
  const lat = cluster.reduce((s, r) => s + r.latitude, 0) / cluster.length;
  const lng = cluster.reduce((s, r) => s + r.longitude, 0) / cluster.length;
  const frp = Math.round(cluster.reduce((s, r) => s + r.frp, 0));
  const maxBrightness = Math.max(...cluster.map(r => r.bright_ti4));

  const intensity     = frpToIntensity(frp);
  const country       = getCountryFromCoords(lat, lng);
  const biomeInfo     = getBiomeFromCoords(lat, lng);
  const areaBurned    = Math.round(cluster.length * 53); // VIIRS pixel ≈ 375m² = ~14ha avg
  const carbonReleased = Math.round(areaBurned * 68);
  const recoveryYears = getRecoveryYears(biomeInfo.biome);

  const biodiversityScore = computeBiodiversityScore({
    frp: Math.min(frp, 1200), // cap to MAX_FRP for scoring purposes
    speciesRichness: Math.min(cluster.length, 30),
    threatRatio: getBiomeThreatRatio(biomeInfo.biome),
    hasEndemic: isBiomeEndemic(biomeInfo.biome),
    inProtectedArea: isLikelyProtectedArea(lat, lng),
  });

  const acqDate = cluster[0].acq_date;
  const acqTime = cluster[0].acq_time.padStart(4, '0');
  const startTime = `${acqDate}T${acqTime.slice(0, 2)}:${acqTime.slice(2, 4)}:00Z`;

  const regionDesc    = getRegionDescriptor(lat, lng);
  const countryName   = country.name !== 'Unknown' ? country.name : regionDesc;
  const region        = getSpecificRegion(lat, lng);
  const locationLabel = region && region !== countryName
    ? `${region}, ${countryName}`
    : countryName;

  // Fire name now includes the state/region for differentiation
  const fireName = `${biomeInfo.biome} Fire, ${locationLabel}`;

  return {
    id: `firms-${idx}-${acqDate}`,
    name: fireName,
    country: countryName,
    countryFlag: country.flag,
    region,
    locationLabel,
    coordinates: [lat, lng],
    intensity,
    frp,
    areaBurned,
    biodiversityScore,
    biome: biomeInfo.biome,
    biomeColor: biomeInfo.color,
    speciesIds: [],
    carbonReleased,
    recoveryYears,
    aiSummary: `Active fire detected at ${lat.toFixed(2)}°, ${lng.toFixed(2)}° in ${biomeInfo.biome} biome, ${locationLabel}. Total FRP: ${frp} MW across ${cluster.length} satellite pixel(s). Peak brightness: ${maxBrightness.toFixed(1)} K. Estimated ${areaBurned.toLocaleString()} ha affected.`,
    trend: 'up',
    trendPercent: Math.round(frp / 100),
    startTime,
    windSpeed: Math.round(15 + (frp / 100) + Math.random() * 20),
    windDeg: Math.round(Math.random() * 360),
    duration: 24,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function frpToIntensity(frp: number): Intensity {
  // frp here is the SUM of all pixels in a cluster (often 1000s of MW)
  // Thresholds are scaled accordingly
  if (frp >= 5000) return 'extreme';
  if (frp >= 1500) return 'high';
  if (frp >= 400)  return 'medium';
  return 'low';
}

function getRecoveryYears(biome: string): number {
  const map: Record<string, number> = {
    'Tropical Forest': 55, 'Boreal Forest': 80, 'Temperate Forest': 45,
    'Mediterranean': 15, 'Savanna': 8, 'Grassland': 5, 'Tundra': 40,
  };
  return map[biome] ?? 20;
}

/**
 * Returns the approximate fraction of species that are IUCN-threatened
 * in this biome, based on published estimates.
 */
function getBiomeThreatRatio(biome: string): number {
  const map: Record<string, number> = {
    'Tropical Forest':  0.45,
    'Mediterranean':    0.35,
    'Temperate Forest': 0.25,
    'Savanna':          0.20,
    'Tundra':           0.20,
    'Boreal Forest':    0.15,
    'Grassland':        0.10,
  };
  return map[biome] ?? 0.15;
}

/**
 * Tropical forests and Mediterranean shrublands harbour a disproportionate
 * share of the world's endemic species.
 */
function isBiomeEndemic(biome: string): boolean {
  return biome === 'Tropical Forest' || biome === 'Mediterranean';
}

/**
 * Very rough heuristic: fires in certain latitude bands / longitude ranges
 * commonly overlap with known protected-area networks (Amazon, Congo Basin,
 * SE-Asian reserves, Mediterranean national parks, etc.).
 */
function isLikelyProtectedArea(lat: number, lng: number): boolean {
  // Amazon basin
  if (lat >= -15 && lat <= 5 && lng >= -75 && lng <= -45) return true;
  // Congo basin
  if (lat >= -5 && lat <= 5 && lng >= 15 && lng <= 30)    return true;
  // SE-Asian tropical belt
  if (lat >= -5 && lat <= 15 && lng >= 100 && lng <= 140) return true;
  // Mediterranean Europe national parks
  if (lat >= 35 && lat <= 45 && (lng >= -5 && lng <= 20)) return true;
  return false;
}

function getBiomeFromCoords(lat: number, lng: number): { biome: string; color: string } {
  if (lat > 60)  return { biome: 'Boreal Forest',    color: 'hsl(210,60%,50%)' };
  if (lat > 50)  return { biome: 'Temperate Forest', color: 'hsl(170,50%,45%)' };
  if (lat > 35 && lat <= 50) {
    if ((lng > -10 && lng < 40) || (lng > -125 && lng < -100))
      return { biome: 'Mediterranean', color: 'hsl(280,60%,50%)' };
    return { biome: 'Temperate Forest', color: 'hsl(170,50%,45%)' };
  }
  if (lat > 23 && lat <= 35)  return { biome: 'Mediterranean',  color: 'hsl(280,60%,50%)' };
  if (lat >= -5 && lat <= 23 && lng >= -80 && lng <= -35) return { biome: 'Tropical Forest', color: 'hsl(145,60%,40%)' };
  if (lat >= -5 && lat <= 5  && lng >= 10  && lng <= 30)  return { biome: 'Tropical Forest', color: 'hsl(145,60%,40%)' };
  if (lat >= -20 && lat <= 10 && lng >= -80 && lng <= -35) return { biome: 'Savanna',         color: 'hsl(50,70%,50%)' };
  if (lat >= -35 && lat <= -5 && lng >= 10  && lng <= 50)  return { biome: 'Savanna',         color: 'hsl(50,70%,50%)' };
  if (lat >= -10 && lat <= 10 && lng >= 95  && lng <= 145) return { biome: 'Tropical Forest', color: 'hsl(145,60%,40%)' };
  if (lat >= -45 && lat <= -10 && lng >= 110 && lng <= 155) return { biome: 'Savanna',        color: 'hsl(50,70%,50%)' };
  if (lat < -50) return { biome: 'Tundra',    color: 'hsl(200,30%,60%)' };
  return { biome: 'Grassland', color: 'hsl(80,55%,45%)' };
}

const COUNTRY_BOXES: {
  name: string; flag: string;
  minLat: number; maxLat: number; minLng: number; maxLng: number;
}[] = [
  { name: 'Alaska',                     flag: '🇺🇸', minLat:  54, maxLat:  72, minLng: -170, maxLng: -130 },
  { name: 'Guatemala',                  flag: '🇬🇹', minLat:  13, maxLat:  18, minLng:  -92, maxLng:  -88 },
  { name: 'Honduras',                   flag: '🇭🇳', minLat:  13, maxLat:  16, minLng:  -89, maxLng:  -83 },
  { name: 'Cuba',                       flag: '🇨🇺', minLat:  19, maxLat:  24, minLng:  -85, maxLng:  -74 },
  { name: 'Ecuador',                    flag: '🇪🇨', minLat:  -5, maxLat:   2, minLng:  -81, maxLng:  -75 },
  { name: 'Paraguay',                   flag: '🇵🇾', minLat: -27, maxLat: -19, minLng:  -62, maxLng:  -54 },
  { name: 'Bolivia',                    flag: '🇧🇴', minLat: -23, maxLat:  -9, minLng:  -69, maxLng:  -57 },
  { name: 'Peru',                       flag: '🇵🇪', minLat: -18, maxLat:   0, minLng:  -81, maxLng:  -68 },
  { name: 'Chile',                      flag: '🇨🇱', minLat: -56, maxLat: -17, minLng:  -76, maxLng:  -66 },
  { name: 'Colombia',                   flag: '🇨🇴', minLat:  -4, maxLat:  13, minLng:  -79, maxLng:  -66 },
  { name: 'Venezuela',                  flag: '🇻🇪', minLat:   0, maxLat:  13, minLng:  -73, maxLng:  -59 },
  { name: 'Argentina',                  flag: '🇦🇷', minLat: -55, maxLat: -21, minLng:  -74, maxLng:  -53 },
  { name: 'Mexico',                     flag: '🇲🇽', minLat:  14, maxLat:  33, minLng: -118, maxLng:  -86 },
  { name: 'United States',              flag: '🇺🇸', minLat:  24, maxLat:  49, minLng: -125, maxLng:  -66 },
  { name: 'Canada',                     flag: '🇨🇦', minLat:  42, maxLat:  83, minLng: -141, maxLng:  -52 },
  { name: 'Brazil',                     flag: '🇧🇷', minLat: -33, maxLat:   5, minLng:  -74, maxLng:  -35 },
  { name: 'Portugal',                   flag: '🇵🇹', minLat:  36, maxLat:  42, minLng:  -10, maxLng:   -6 },
  { name: 'Greece',                     flag: '🇬🇷', minLat:  34, maxLat:  42, minLng:   19, maxLng:   30 },
  { name: 'Romania',                    flag: '🇷🇴', minLat:  43, maxLat:  48, minLng:   20, maxLng:   30 },
  { name: 'Italy',                      flag: '🇮🇹', minLat:  36, maxLat:  47, minLng:    6, maxLng:   19 },
  { name: 'Germany',                    flag: '🇩🇪', minLat:  47, maxLat:  55, minLng:    5, maxLng:   15 },
  { name: 'Spain',                      flag: '🇪🇸', minLat:  35, maxLat:  44, minLng:  -10, maxLng:    4 },
  { name: 'France',                     flag: '🇫🇷', minLat:  41, maxLat:  51, minLng:   -5, maxLng:    9 },
  { name: 'Ukraine',                    flag: '🇺🇦', minLat:  44, maxLat:  53, minLng:   22, maxLng:   40 },
  { name: 'Turkey',                     flag: '🇹🇷', minLat:  35, maxLat:  42, minLng:   25, maxLng:   45 },
  { name: 'Sweden',                     flag: '🇸🇪', minLat:  55, maxLat:  69, minLng:   11, maxLng:   24 },
  { name: 'Finland',                    flag: '🇫🇮', minLat:  59, maxLat:  70, minLng:   20, maxLng:   32 },
  { name: 'Norway',                     flag: '🇳🇴', minLat:  57, maxLat:  71, minLng:    4, maxLng:   31 },
  { name: 'Iraq',                       flag: '🇮🇶', minLat:  29, maxLat:  37, minLng:   38, maxLng:   49 },
  { name: 'Iran',                       flag: '🇮🇷', minLat:  25, maxLat:  40, minLng:   44, maxLng:   63 },
  { name: 'Saudi Arabia',               flag: '🇸🇦', minLat:  15, maxLat:  33, minLng:   34, maxLng:   56 },
  { name: 'Nepal',                      flag: '🇳🇵', minLat:  26, maxLat:  30, minLng:   80, maxLng:   88 },
  { name: 'Bangladesh',                 flag: '🇧🇩', minLat:  20, maxLat:  27, minLng:   88, maxLng:   93 },
  { name: 'South Korea',                flag: '🇰🇷', minLat:  33, maxLat:  39, minLng:  124, maxLng:  132 },
  { name: 'Cambodia',                   flag: '🇰🇭', minLat:  10, maxLat:  15, minLng:  102, maxLng:  108 },
  { name: 'Laos',                       flag: '🇱🇦', minLat:  13, maxLat:  23, minLng:  100, maxLng:  108 },
  { name: 'Vietnam',                    flag: '🇻🇳', minLat:   8, maxLat:  23, minLng:  102, maxLng:  110 },
  { name: 'Thailand',                   flag: '🇹🇭', minLat:   5, maxLat:  21, minLng:   97, maxLng:  106 },
  { name: 'Myanmar',                    flag: '🇲🇲', minLat:   9, maxLat:  29, minLng:   92, maxLng:  101 },
  { name: 'Pakistan',                   flag: '🇵🇰', minLat:  23, maxLat:  37, minLng:   60, maxLng:   77 },
  { name: 'Mongolia',                   flag: '🇲🇳', minLat:  41, maxLat:  52, minLng:   87, maxLng:  120 },
  { name: 'Japan',                      flag: '🇯🇵', minLat:  24, maxLat:  46, minLng:  122, maxLng:  154 },
  { name: 'Philippines',                flag: '🇵🇭', minLat:   4, maxLat:  21, minLng:  116, maxLng:  127 },
  { name: 'Malaysia',                   flag: '🇲🇾', minLat:   0, maxLat:   7, minLng:  100, maxLng:  119 },
  { name: 'India',                      flag: '🇮🇳', minLat:   8, maxLat:  37, minLng:   68, maxLng:   98 },
  { name: 'Kazakhstan',                 flag: '🇰🇿', minLat:  40, maxLat:  55, minLng:   50, maxLng:   87 },
  { name: 'China',                      flag: '🇨🇳', minLat:  18, maxLat:  53, minLng:   73, maxLng:  135 },
  { name: 'Russia',                     flag: '🇷🇺', minLat:  41, maxLat:  82, minLng:   26, maxLng:  180 },
  { name: 'Indonesia',                  flag: '🇮🇩', minLat: -11, maxLat:   6, minLng:   95, maxLng:  141 },
  { name: 'Papua New Guinea',           flag: '🇵🇬', minLat: -12, maxLat:   0, minLng:  140, maxLng:  160 },
  { name: 'Australia',                  flag: '🇦🇺', minLat: -44, maxLat: -10, minLng:  113, maxLng:  154 },
  { name: 'New Zealand',                flag: '🇳🇿', minLat: -47, maxLat: -34, minLng:  165, maxLng:  179 },
  { name: 'Morocco',                    flag: '🇲🇦', minLat:  27, maxLat:  36, minLng:  -13, maxLng:   -1 },
  { name: 'Egypt',                      flag: '🇪🇬', minLat:  22, maxLat:  31, minLng:   25, maxLng:   36 },
  { name: 'Ghana',                      flag: '🇬🇭', minLat:   4, maxLat:  11, minLng:   -3, maxLng:    1 },
  { name: 'Uganda',                     flag: '🇺🇬', minLat:  -1, maxLat:   4, minLng:   29, maxLng:   35 },
  { name: 'Kenya',                      flag: '🇰🇪', minLat:  -5, maxLat:   5, minLng:   33, maxLng:   42 },
  { name: 'Zimbabwe',                   flag: '🇿🇼', minLat: -22, maxLat: -15, minLng:   25, maxLng:   33 },
  { name: 'Botswana',                   flag: '🇧🇼', minLat: -27, maxLat: -17, minLng:   20, maxLng:   29 },
  { name: 'Mozambique',                 flag: '🇲🇿', minLat: -27, maxLat: -10, minLng:   32, maxLng:   41 },
  { name: 'Madagascar',                 flag: '🇲🇬', minLat: -26, maxLat: -12, minLng:   43, maxLng:   50 },
  { name: 'Zambia',                     flag: '🇿🇲', minLat: -18, maxLat:  -8, minLng:   22, maxLng:   33 },
  { name: 'Namibia',                    flag: '🇳🇦', minLat: -29, maxLat: -17, minLng:   12, maxLng:   25 },
  { name: 'Angola',                     flag: '🇦🇴', minLat: -18, maxLat:  -4, minLng:   11, maxLng:   25 },
  { name: 'Tanzania',                   flag: '🇹🇿', minLat: -11, maxLat:  -1, minLng:   29, maxLng:   40 },
  { name: 'Cameroon',                   flag: '🇨🇲', minLat:   1, maxLat:  13, minLng:    8, maxLng:   16 },
  { name: 'Nigeria',                    flag: '🇳🇬', minLat:   4, maxLat:  14, minLng:    2, maxLng:   15 },
  { name: 'Central African Republic',   flag: '🇨🇫', minLat:   2, maxLat:  11, minLng:   14, maxLng:   27 },
  { name: 'Ethiopia',                   flag: '🇪🇹', minLat:   3, maxLat:  15, minLng:   33, maxLng:   48 },
  { name: 'Somalia',                    flag: '🇸🇴', minLat:  -2, maxLat:  12, minLng:   40, maxLng:   51 },
  { name: 'South Sudan',                flag: '🇸🇸', minLat:   3, maxLat:  13, minLng:   24, maxLng:   36 },
  { name: 'DR Congo',                   flag: '🇨🇩', minLat: -15, maxLat:   5, minLng:   12, maxLng:   31 },
  { name: 'South Africa',               flag: '🇿🇦', minLat: -35, maxLat: -22, minLng:   16, maxLng:   33 },
  { name: 'Sudan',                      flag: '🇸🇩', minLat:   8, maxLat:  23, minLng:   22, maxLng:   39 },
  { name: 'Chad',                       flag: '🇹🇩', minLat:   7, maxLat:  24, minLng:   13, maxLng:   24 },
  { name: 'Niger',                      flag: '🇳🇪', minLat:  11, maxLat:  24, minLng:    0, maxLng:   16 },
  { name: 'Mali',                       flag: '🇲🇱', minLat:  10, maxLat:  25, minLng:  -12, maxLng:    4 },
  { name: 'Algeria',                    flag: '🇩🇿', minLat:  19, maxLat:  37, minLng:   -9, maxLng:   12 },
  { name: 'Libya',                      flag: '🇱🇾', minLat:  19, maxLat:  33, minLng:    9, maxLng:   25 },
];

function getCountryFromCoords(lat: number, lng: number): { name: string; flag: string } {
  for (const c of COUNTRY_BOXES) {
    if (lat >= c.minLat && lat <= c.maxLat && lng >= c.minLng && lng <= c.maxLng)
      return { name: c.name, flag: c.flag };
  }
  return { name: 'Unknown', flag: '🌍' };
}

function getRegionDescriptor(lat: number, lng: number): string {
  if (lat > 60) return 'Northern Eurasia';
  if (lat > 35 && lng >= -30 && lng <= 50)   return 'Southern Europe';
  if (lat > 35 && lng > 50  && lng <= 100)   return 'Central Asia';
  if (lat > 35 && lng > 100)                 return 'East Asia';
  if (lat > 23 && lng >= -130 && lng <= -60) return 'North America';
  if (lat > 0 && lat <= 23 && lng >= -120 && lng <= -60) return 'Central America';
  if (lat <= 0 && lat > -35 && lng >= -80 && lng <= -35) return 'South America';
  if (lat > 0 && lat <= 23 && lng >= -20 && lng <= 55)   return 'West Africa';
  if (lat > -35 && lat <= 0 && lng >= 10 && lng <= 55)   return 'East Africa';
  if (lat > 0 && lat <= 23 && lng >= 55 && lng <= 100)   return 'South Asia';
  if (lat > -10 && lat <= 23 && lng >= 95 && lng <= 145) return 'Southeast Asia';
  if (lat <= -10 && lng >= 100 && lng <= 180)            return 'Oceania';
  return 'Remote Region';
}

// Granular state / province / region lookup
interface RegionBox { region: string; minLat: number; maxLat: number; minLng: number; maxLng: number; }

const REGION_BOXES: RegionBox[] = [
  // Australia
  { region: 'Queensland',          minLat: -29, maxLat: -10, minLng: 137, maxLng: 154 },
  { region: 'New South Wales',     minLat: -38, maxLat: -28, minLng: 140, maxLng: 154 },
  { region: 'Victoria',            minLat: -39, maxLat: -33, minLng: 140, maxLng: 150 },
  { region: 'Western Australia',   minLat: -44, maxLat: -14, minLng: 113, maxLng: 130 },
  { region: 'Northern Territory',  minLat: -26, maxLat: -10, minLng: 129, maxLng: 138 },
  { region: 'South Australia',     minLat: -38, maxLat: -25, minLng: 129, maxLng: 141 },
  // USA
  { region: 'California',          minLat:  32, maxLat:  42, minLng: -125, maxLng: -113 },
  { region: 'Oregon',              minLat:  41, maxLat:  47, minLng: -125, maxLng: -116 },
  { region: 'Washington State',    minLat:  45, maxLat:  49, minLng: -125, maxLng: -116 },
  { region: 'Idaho',               minLat:  41, maxLat:  49, minLng: -117, maxLng: -111 },
  { region: 'Montana',             minLat:  44, maxLat:  49, minLng: -116, maxLng: -104 },
  { region: 'Colorado',            minLat:  36, maxLat:  41, minLng: -109, maxLng: -102 },
  { region: 'Texas',               minLat:  25, maxLat:  36, minLng: -107, maxLng:  -93 },
  { region: 'Florida',             minLat:  24, maxLat:  31, minLng:  -88, maxLng:  -79 },
  { region: 'Arizona',             minLat:  31, maxLat:  37, minLng: -115, maxLng: -109 },
  { region: 'New Mexico',          minLat:  31, maxLat:  37, minLng: -109, maxLng: -103 },
  { region: 'Utah',                minLat:  36, maxLat:  42, minLng: -114, maxLng: -109 },
  { region: 'Nevada',              minLat:  35, maxLat:  42, minLng: -120, maxLng: -114 },
  // Brazil
  { region: 'Mato Grosso',         minLat: -18, maxLat:  -7, minLng:  -61, maxLng:  -50 },
  { region: 'Pará',                minLat:  -9, maxLat:   3, minLng:  -59, maxLng:  -45 },
  { region: 'Amazonas',            minLat:  -9, maxLat:   2, minLng:  -74, maxLng:  -59 },
  { region: 'Mato Grosso do Sul',  minLat: -24, maxLat: -17, minLng:  -59, maxLng:  -50 },
  { region: 'Rondônia',            minLat: -13, maxLat:  -7, minLng:  -66, maxLng:  -59 },
  { region: 'Tocantins',           minLat: -13, maxLat:  -5, minLng:  -50, maxLng:  -45 },
  { region: 'Bahia',               minLat: -18, maxLat:  -8, minLng:  -45, maxLng:  -37 },
  // Russia
  { region: 'Yakutia',             minLat:  55, maxLat:  72, minLng: 110, maxLng: 155  },
  { region: 'Siberia',             minLat:  55, maxLat:  72, minLng:  60, maxLng: 110  },
  { region: 'Krasnoyarsk Krai',    minLat:  52, maxLat:  68, minLng:  80, maxLng: 110  },
  { region: 'Irkutsk Oblast',      minLat:  50, maxLat:  60, minLng: 100, maxLng: 115  },
  { region: 'Far East Russia',     minLat:  43, maxLat:  68, minLng: 130, maxLng: 170  },
  { region: 'European Russia',     minLat:  50, maxLat:  65, minLng:  26, maxLng:  60  },
  { region: 'Trans-Baikal',        minLat:  48, maxLat:  56, minLng: 113, maxLng: 122  },
  // China
  { region: 'Yunnan',              minLat:  21, maxLat:  29, minLng:  97, maxLng: 107  },
  { region: 'Sichuan',             minLat:  26, maxLat:  34, minLng: 100, maxLng: 109  },
  { region: 'Heilongjiang',        minLat:  43, maxLat:  53, minLng: 121, maxLng: 135  },
  { region: 'Inner Mongolia',      minLat:  37, maxLat:  53, minLng: 100, maxLng: 125  },
  { region: 'Guangdong',           minLat:  20, maxLat:  25, minLng: 109, maxLng: 117  },
  { region: 'Hunan',               minLat:  24, maxLat:  30, minLng: 108, maxLng: 114  },
  { region: 'Guizhou',             minLat:  24, maxLat:  29, minLng: 103, maxLng: 109  },
  { region: 'Xinjiang',            minLat:  35, maxLat:  49, minLng:  73, maxLng:  96  },
  // India
  { region: 'Odisha',              minLat:  17, maxLat:  22, minLng:  80, maxLng:  87  },
  { region: 'Chhattisgarh',        minLat:  17, maxLat:  24, minLng:  80, maxLng:  84  },
  { region: 'Madhya Pradesh',      minLat:  21, maxLat:  27, minLng:  74, maxLng:  82  },
  { region: 'Jharkhand',           minLat:  21, maxLat:  25, minLng:  83, maxLng:  87  },
  { region: 'Uttarakhand',         minLat:  28, maxLat:  32, minLng:  77, maxLng:  81  },
  { region: 'Telangana',           minLat:  15, maxLat:  20, minLng:  77, maxLng:  82  },
  { region: 'Andhra Pradesh',      minLat:  12, maxLat:  20, minLng:  76, maxLng:  85  },
  // Canada
  { region: 'British Columbia',    minLat:  48, maxLat:  60, minLng: -139, maxLng: -114 },
  { region: 'Alberta',             minLat:  48, maxLat:  60, minLng: -120, maxLng: -110 },
  { region: 'Ontario',             minLat:  41, maxLat:  57, minLng:  -96, maxLng:  -74 },
  { region: 'Quebec',              minLat:  44, maxLat:  63, minLng:  -80, maxLng:  -57 },
  { region: 'Saskatchewan',        minLat:  49, maxLat:  60, minLng: -110, maxLng:  -98 },
  { region: 'Manitoba',            minLat:  48, maxLat:  60, minLng:  -99, maxLng:  -89 },
  // Indonesia
  { region: 'Kalimantan',          minLat:  -4, maxLat:   4, minLng: 108, maxLng: 119  },
  { region: 'Sumatra',             minLat:  -6, maxLat:   6, minLng:  95, maxLng: 108  },
  { region: 'Papua',               minLat:  -9, maxLat:   0, minLng: 130, maxLng: 141  },
  { region: 'Sulawesi',            minLat:  -6, maxLat:   2, minLng: 119, maxLng: 125  },
  // Africa
  { region: 'Mato Grosso',         minLat: -18, maxLat:  -5, minLng:  22, maxLng:  35  },
  { region: 'Sahel Zone',          minLat:  10, maxLat:  18, minLng:  -5, maxLng:  25  },
  { region: 'Congo Basin',         minLat:  -5, maxLat:   5, minLng:  15, maxLng:  30  },
  { region: 'Eastern Highlands',   minLat:  -5, maxLat:  10, minLng:  32, maxLng:  40  },
  { region: 'Zambezi Valley',      minLat: -20, maxLat: -12, minLng:  26, maxLng:  35  },
  { region: 'Okavango Region',     minLat: -22, maxLat: -17, minLng:  20, maxLng:  28  },
  // SE Asia
  { region: 'Northern Thailand',   minLat:  17, maxLat:  21, minLng:  97, maxLng: 103  },
  { region: 'Central Vietnam',     minLat:  14, maxLat:  20, minLng: 105, maxLng: 110  },
  { region: 'Mekong Delta',        minLat:   9, maxLat:  13, minLng: 103, maxLng: 107  },
  { region: 'Myanmar Highlands',   minLat:  20, maxLat:  26, minLng:  96, maxLng: 100  },
  { region: 'Luzon',               minLat:  14, maxLat:  21, minLng: 119, maxLng: 127  },
  { region: 'Mindanao',            minLat:   5, maxLat:  11, minLng: 122, maxLng: 127  },
  // South America extra
  { region: 'Mato Grosso',         minLat: -13, maxLat:  -7, minLng:  -61, maxLng:  -55 },
  { region: 'Patagonia',           minLat: -55, maxLat: -38, minLng:  -75, maxLng:  -63 },
  { region: 'Cerrado',             minLat: -24, maxLat: -10, minLng:  -56, maxLng:  -43 },
  { region: 'Orinoco Llanos',      minLat:   4, maxLat:  10, minLng:  -73, maxLng:  -61 },
  // Europe
  { region: 'Iberian Peninsula',   minLat:  36, maxLat:  44, minLng:  -10, maxLng:    4 },
  { region: 'Balkans',             minLat:  37, maxLat:  47, minLng:   19, maxLng:   30 },
  { region: 'Anatolia',            minLat:  36, maxLat:  42, minLng:   26, maxLng:   44 },
  { region: 'Scandinavia',         minLat:  55, maxLat:  71, minLng:    4, maxLng:   32 },
];

function getSpecificRegion(lat: number, lng: number): string {
  for (const r of REGION_BOXES) {
    if (lat >= r.minLat && lat <= r.maxLat && lng >= r.minLng && lng <= r.maxLng)
      return r.region;
  }
  return ''; // empty = no sub-region found, just use country name
}

