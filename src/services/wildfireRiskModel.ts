/**
 * Wildfire Risk Prediction Engine
 *
 * A browser-native weighted ensemble model that runs entirely in TypeScript.
 * No external ML libraries — every factor is documented and transparent.
 *
 * Factor weights (sum = 1.0):
 *   fire_frequency   0.20
 *   frp_intensity    0.25
 *   proximity_cascade 0.20
 *   wind_transport   0.15
 *   biome_vuln       0.10
 *   season_factor    0.05
 *   daynight_factor  0.05
 */

import type { FireEvent } from './apiTypes';
import { fetchWeatherForCoords, type WeatherData } from './weatherApi';

// ─── Types ──────────────────────────────────────────────────────────────────

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';

export interface RiskFactorBreakdown {
  fireFrequency: number;    // 0-100
  frpIntensity: number;     // 0-100
  proximityCascade: number; // 0-100
  windTransport: number;    // 0-100
  biomeVulnerability: number; // 0-100
  seasonFactor: number;     // 0-100
  dayNightFactor: number;   // 0-100
}

export interface RiskCell {
  id: string;
  lat: number;
  lng: number;
  score: number;          // 0-100
  level: RiskLevel;
  country: string;
  countryFlag: string;
  region: string;         // State / province / sub-region
  locationLabel: string;  // "Queensland, Australia" style
  biome: string;
  biomeColor: string;
  factors: RiskFactorBreakdown;
  confidence: number;     // 0-100
  nearbyFireCount: number;
  dominantFRP: number;
}

export interface SpreadCone {
  fireId: string;
  fireName: string;
  coneCenter: [number, number];
  coneRadius: number;       // km
  coneDirection: number;    // degrees
  conePolygon: [number, number][]; // lat/lng points for polygon
  estimatedHectares24h: number;
  carbonRelease24h: number; // tonnes
  riskLevel: RiskLevel;
  windSpeed: number;
  windDeg: number;
}

export interface PredictionResult {
  riskCells: RiskCell[];
  spreadCones: SpreadCone[];
  weatherMap: Map<string, WeatherData>;
  modelMetadata: {
    totalFiresAnalyzed: number;
    gridCellsEvaluated: number;
    dataFreshness: 'live' | 'cached';
    computedAt: string;
    avgConfidence: number;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GRID_SIZE = 0.5; // degrees per cell
const MAX_CELLS_RETURNED = 50;
const PROXIMITY_RADIUS_DEG = 2.0; // ~200km for FRP influence
const CASCADE_RADIUS_DEG = 0.6;   // ~60km for cascade effect

const BIOME_VULNERABILITY: Record<string, number> = {
  'Tropical Forest':  0.90,
  'Savanna':          0.85,
  'Mediterranean':    0.75,
  'Grassland':        0.70,
  'Temperate Forest': 0.60,
  'Tundra':           0.55,
  'Boreal Forest':    0.50,
};

// Factor weights
const WEIGHTS = {
  fireFrequency:    0.20,
  frpIntensity:     0.25,
  proximityCascade: 0.20,
  windTransport:    0.15,
  biomeVuln:        0.10,
  seasonFactor:     0.05,
  dayNightFactor:   0.05,
};

// ─── Biome & Country Helpers (mirrors firmsApi.ts logic) ────────────────────

function getBiomeFromCoords(lat: number, lng: number): { biome: string; color: string } {
  if (lat > 60)  return { biome: 'Boreal Forest',    color: 'hsl(210,60%,50%)' };
  if (lat > 50)  return { biome: 'Temperate Forest', color: 'hsl(170,50%,45%)' };
  if (lat > 35 && lat <= 50) {
    if ((lng > -10 && lng < 40) || (lng > -125 && lng < -100))
      return { biome: 'Mediterranean', color: 'hsl(280,60%,50%)' };
    return { biome: 'Temperate Forest', color: 'hsl(170,50%,45%)' };
  }
  if (lat > 23 && lat <= 35)  return { biome: 'Mediterranean',   color: 'hsl(280,60%,50%)' };
  if (lat >= -5  && lat <= 23 && lng >= -80  && lng <= -35) return { biome: 'Tropical Forest', color: 'hsl(145,60%,40%)' };
  if (lat >= -5  && lat <= 5  && lng >= 10   && lng <= 30)  return { biome: 'Tropical Forest', color: 'hsl(145,60%,40%)' };
  if (lat >= -20 && lat <= 10 && lng >= -80  && lng <= -35) return { biome: 'Savanna',         color: 'hsl(50,70%,50%)' };
  if (lat >= -35 && lat <= -5 && lng >= 10   && lng <= 50)  return { biome: 'Savanna',         color: 'hsl(50,70%,50%)' };
  if (lat >= -10 && lat <= 10 && lng >= 95   && lng <= 145) return { biome: 'Tropical Forest', color: 'hsl(145,60%,40%)' };
  if (lat >= -45 && lat <= -10 && lng >= 110 && lng <= 155) return { biome: 'Savanna',         color: 'hsl(50,70%,50%)' };
  if (lat < -50) return { biome: 'Tundra',    color: 'hsl(200,30%,60%)' };
  return { biome: 'Grassland', color: 'hsl(80,55%,45%)' };
}

const COUNTRY_BOXES: {
  name: string; flag: string;
  minLat: number; maxLat: number; minLng: number; maxLng: number;
}[] = [
  { name: 'Alaska',                   flag: '🇺🇸', minLat:  54, maxLat:  72, minLng: -170, maxLng: -130 },
  { name: 'Brazil',                   flag: '🇧🇷', minLat: -33, maxLat:   5, minLng:  -74, maxLng:  -35 },
  { name: 'United States',            flag: '🇺🇸', minLat:  24, maxLat:  49, minLng: -125, maxLng:  -66 },
  { name: 'Canada',                   flag: '🇨🇦', minLat:  42, maxLat:  83, minLng: -141, maxLng:  -52 },
  { name: 'Mexico',                   flag: '🇲🇽', minLat:  14, maxLat:  33, minLng: -118, maxLng:  -86 },
  { name: 'Argentina',                flag: '🇦🇷', minLat: -55, maxLat: -21, minLng:  -74, maxLng:  -53 },
  { name: 'Bolivia',                  flag: '🇧🇴', minLat: -23, maxLat:  -9, minLng:  -69, maxLng:  -57 },
  { name: 'Peru',                     flag: '🇵🇪', minLat: -18, maxLat:   0, minLng:  -81, maxLng:  -68 },
  { name: 'Colombia',                 flag: '🇨🇴', minLat:  -4, maxLat:  13, minLng:  -79, maxLng:  -66 },
  { name: 'Venezuela',                flag: '🇻🇪', minLat:   0, maxLat:  13, minLng:  -73, maxLng:  -59 },
  { name: 'Angola',                   flag: '🇦🇴', minLat: -18, maxLat:  -4, minLng:  11,  maxLng:  25  },
  { name: 'DR Congo',                 flag: '🇨🇩', minLat: -15, maxLat:   5, minLng:  12,  maxLng:  31  },
  { name: 'Zambia',                   flag: '🇿🇲', minLat: -18, maxLat:  -8, minLng:  22,  maxLng:  33  },
  { name: 'Tanzania',                 flag: '🇹🇿', minLat: -11, maxLat:  -1, minLng:  29,  maxLng:  40  },
  { name: 'Mozambique',               flag: '🇲🇿', minLat: -27, maxLat: -10, minLng:  32,  maxLng:  41  },
  { name: 'Zimbabwe',                 flag: '🇿🇼', minLat: -22, maxLat: -15, minLng:  25,  maxLng:  33  },
  { name: 'Botswana',                 flag: '🇧🇼', minLat: -27, maxLat: -17, minLng:  20,  maxLng:  29  },
  { name: 'South Africa',             flag: '🇿🇦', minLat: -35, maxLat: -22, minLng:  16,  maxLng:  33  },
  { name: 'Nigeria',                  flag: '🇳🇬', minLat:   4, maxLat:  14, minLng:   2,  maxLng:  15  },
  { name: 'Sudan',                    flag: '🇸🇩', minLat:   8, maxLat:  23, minLng:  22,  maxLng:  39  },
  { name: 'Chad',                     flag: '🇹🇩', minLat:   7, maxLat:  24, minLng:  13,  maxLng:  24  },
  { name: 'Ethiopia',                 flag: '🇪🇹', minLat:   3, maxLat:  15, minLng:  33,  maxLng:  48  },
  { name: 'South Sudan',              flag: '🇸🇸', minLat:   3, maxLat:  13, minLng:  24,  maxLng:  36  },
  { name: 'Mali',                     flag: '🇲🇱', minLat:  10, maxLat:  25, minLng: -12,  maxLng:   4  },
  { name: 'Ghana',                    flag: '🇬🇭', minLat:   4, maxLat:  11, minLng:  -3,  maxLng:   1  },
  { name: 'Cameroon',                 flag: '🇨🇲', minLat:   1, maxLat:  13, minLng:   8,  maxLng:  16  },
  { name: 'Madagascar',               flag: '🇲🇬', minLat: -26, maxLat: -12, minLng:  43,  maxLng:  50  },
  { name: 'Russia',                   flag: '🇷🇺', minLat:  41, maxLat:  82, minLng:  26,  maxLng: 180  },
  { name: 'China',                    flag: '🇨🇳', minLat:  18, maxLat:  53, minLng:  73,  maxLng: 135  },
  { name: 'India',                    flag: '🇮🇳', minLat:   8, maxLat:  37, minLng:  68,  maxLng:  98  },
  { name: 'Indonesia',                flag: '🇮🇩', minLat: -11, maxLat:   6, minLng:  95,  maxLng: 141  },
  { name: 'Australia',                flag: '🇦🇺', minLat: -44, maxLat: -10, minLng: 113,  maxLng: 154  },
  { name: 'Myanmar',                  flag: '🇲🇲', minLat:   9, maxLat:  29, minLng:  92,  maxLng: 101  },
  { name: 'Thailand',                 flag: '🇹🇭', minLat:   5, maxLat:  21, minLng:  97,  maxLng: 106  },
  { name: 'Vietnam',                  flag: '🇻🇳', minLat:   8, maxLat:  23, minLng: 102,  maxLng: 110  },
  { name: 'Cambodia',                 flag: '🇰🇭', minLat:  10, maxLat:  15, minLng: 102,  maxLng: 108  },
  { name: 'Laos',                     flag: '🇱🇦', minLat:  13, maxLat:  23, minLng: 100,  maxLng: 108  },
  { name: 'Philippines',              flag: '🇵🇭', minLat:   4, maxLat:  21, minLng: 116,  maxLng: 127  },
  { name: 'Turkey',                   flag: '🇹🇷', minLat:  35, maxLat:  42, minLng:  25,  maxLng:  45  },
  { name: 'Greece',                   flag: '🇬🇷', minLat:  34, maxLat:  42, minLng:  19,  maxLng:  30  },
  { name: 'Spain',                    flag: '🇪🇸', minLat:  35, maxLat:  44, minLng: -10,  maxLng:   4  },
  { name: 'Portugal',                 flag: '🇵🇹', minLat:  36, maxLat:  42, minLng: -10,  maxLng:  -6  },
  { name: 'Italy',                    flag: '🇮🇹', minLat:  36, maxLat:  47, minLng:   6,  maxLng:  19  },
  { name: 'Kazakhstan',               flag: '🇰🇿', minLat:  40, maxLat:  55, minLng:  50,  maxLng:  87  },
  { name: 'Mongolia',                 flag: '🇲🇳', minLat:  41, maxLat:  52, minLng:  87,  maxLng: 120  },
];

function getCountryFromCoords(lat: number, lng: number): { name: string; flag: string } {
  for (const c of COUNTRY_BOXES) {
    if (lat >= c.minLat && lat <= c.maxLat && lng >= c.minLng && lng <= c.maxLng)
      return { name: c.name, flag: c.flag };
  }
  return { name: 'Remote Region', flag: '🌍' };
}

// Granular state/province/region lookup for specific location labels
interface RegionBox {
  region: string;
  minLat: number; maxLat: number; minLng: number; maxLng: number;
}

const REGION_BOXES: RegionBox[] = [
  // Australia
  { region: 'Queensland',           minLat: -29, maxLat: -10, minLng: 137, maxLng: 154 },
  { region: 'New South Wales',      minLat: -38, maxLat: -28, minLng: 140, maxLng: 154 },
  { region: 'Victoria',             minLat: -39, maxLat: -33, minLng: 140, maxLng: 150 },
  { region: 'Western Australia',    minLat: -44, maxLat: -14, minLng: 113, maxLng: 130 },
  { region: 'Northern Territory',   minLat: -26, maxLat: -10, minLng: 129, maxLng: 138 },
  { region: 'South Australia',      minLat: -38, maxLat: -25, minLng: 129, maxLng: 141 },
  // USA
  { region: 'California',           minLat:  32, maxLat:  42, minLng: -125, maxLng: -113 },
  { region: 'Oregon',               minLat:  41, maxLat:  47, minLng: -125, maxLng: -116 },
  { region: 'Washington State',     minLat:  45, maxLat:  49, minLng: -125, maxLng: -116 },
  { region: 'Idaho',                minLat:  41, maxLat:  49, minLng: -117, maxLng: -111 },
  { region: 'Montana',              minLat:  44, maxLat:  49, minLng: -116, maxLng: -104 },
  { region: 'Colorado',             minLat:  36, maxLat:  41, minLng: -109, maxLng: -102 },
  { region: 'Texas',                minLat:  25, maxLat:  36, minLng: -107, maxLng:  -93 },
  { region: 'Florida',              minLat:  24, maxLat:  31, minLng:  -88, maxLng:  -79 },
  { region: 'Arizona',              minLat:  31, maxLat:  37, minLng: -115, maxLng: -109 },
  { region: 'New Mexico',           minLat:  31, maxLat:  37, minLng: -109, maxLng: -103 },
  // Brazil
  { region: 'Mato Grosso',          minLat: -18, maxLat: -7,  minLng:  -61, maxLng:  -50 },
  { region: 'Pará',                 minLat:  -9, maxLat:   3, minLng:  -59, maxLng:  -45 },
  { region: 'Amazonas',             minLat:  -9, maxLat:   2, minLng:  -74, maxLng:  -59 },
  { region: 'Mato Grosso do Sul',   minLat: -24, maxLat: -17, minLng:  -59, maxLng:  -50 },
  { region: 'Rondônia',             minLat: -13, maxLat:  -7, minLng:  -66, maxLng:  -59 },
  { region: 'Tocantins',            minLat: -13, maxLat:  -5, minLng:  -50, maxLng:  -45 },
  // Russia
  { region: 'Siberia',              minLat:  55, maxLat:  72, minLng:  60,  maxLng: 130  },
  { region: 'Yakutia',              minLat:  55, maxLat:  72, minLng: 110,  maxLng: 155  },
  { region: 'Krasnoyarsk Krai',     minLat:  52, maxLat:  68, minLng:  80,  maxLng: 110  },
  { region: 'Irkutsk Oblast',       minLat:  50, maxLat:  60, minLng: 100,  maxLng: 115  },
  { region: 'Far East Russia',      minLat:  43, maxLat:  68, minLng: 130,  maxLng: 170  },
  { region: 'European Russia',      minLat:  50, maxLat:  65, minLng:  26,  maxLng:  60  },
  // China
  { region: 'Yunnan',               minLat:  21, maxLat:  29, minLng:  97,  maxLng: 107  },
  { region: 'Sichuan',              minLat:  26, maxLat:  34, minLng: 100,  maxLng: 109  },
  { region: 'Heilongjiang',         minLat:  43, maxLat:  53, minLng: 121,  maxLng: 135  },
  { region: 'Inner Mongolia',       minLat:  37, maxLat:  53, minLng: 100,  maxLng: 125  },
  { region: 'Guangdong',            minLat:  20, maxLat:  25, minLng: 109,  maxLng: 117  },
  // India
  { region: 'Odisha',               minLat:  17, maxLat:  22, minLng:  80,  maxLng:  87  },
  { region: 'Chhattisgarh',         minLat:  17, maxLat:  24, minLng:  80,  maxLng:  84  },
  { region: 'Madhya Pradesh',       minLat:  21, maxLat:  27, minLng:  74,  maxLng:  82  },
  { region: 'Jharkhand',            minLat:  21, maxLat:  25, minLng:  83,  maxLng:  87  },
  { region: 'Uttarakhand',          minLat:  28, maxLat:  32, minLng:  77,  maxLng:  81  },
  // Canada
  { region: 'British Columbia',     minLat:  48, maxLat:  60, minLng: -139, maxLng: -114 },
  { region: 'Alberta',              minLat:  48, maxLat:  60, minLng: -120, maxLng: -110 },
  { region: 'Ontario',              minLat:  41, maxLat:  57, minLng:  -96, maxLng:  -74 },
  { region: 'Quebec',               minLat:  44, maxLat:  63, minLng:  -80, maxLng:  -57 },
  { region: 'Saskatchewan',         minLat:  49, maxLat:  60, minLng: -110, maxLng:  -98 },
  // Indonesia
  { region: 'Kalimantan',           minLat:  -4, maxLat:   4, minLng: 108,  maxLng: 119  },
  { region: 'Sumatra',              minLat:  -6, maxLat:   6, minLng:  95,  maxLng: 108  },
  { region: 'Papua',                minLat:  -9, maxLat:   0, minLng: 130,  maxLng: 141  },
  // Africa
  { region: 'Miombo Woodlands',     minLat: -18, maxLat:  -5, minLng:  22,  maxLng:  35  },
  { region: 'Sahel Zone',           minLat:  10, maxLat:  18, minLng:  -5,  maxLng:  25  },
  { region: 'Congo Basin',          minLat:  -5, maxLat:   5, minLng:  15,  maxLng:  30  },
  { region: 'Eastern Highlands',    minLat:  -5, maxLat:  10, minLng:  32,  maxLng:  40  },
  // SE Asia
  { region: 'Northern Thailand',    minLat:  17, maxLat:  21, minLng:  97,  maxLng: 103  },
  { region: 'Central Vietnam',      minLat:  14, maxLat:  20, minLng: 105,  maxLng: 110  },
  { region: 'Mekong Delta',         minLat:   9, maxLat:  13, minLng: 103,  maxLng: 107  },
  { region: 'Myanmar Highlands',    minLat:  20, maxLat:  26, minLng:  96,  maxLng: 100  },
];

export function getSpecificRegion(lat: number, lng: number): string {
  for (const r of REGION_BOXES) {
    if (lat >= r.minLat && lat <= r.maxLat && lng >= r.minLng && lng <= r.maxLng)
      return r.region;
  }
  // Fallback: directional sub-region based on lat/lng
  const ns = lat > 10 ? 'Northern' : lat < -10 ? 'Southern' : 'Central';
  const ew = lng > 60 ? 'Eastern' : lng < -30 ? 'Western' : '';
  return [ew, ns].filter(Boolean).join(' ');
}



function getSeasonMultiplier(lat: number): number {
  const month = new Date().getMonth() + 1; // 1-12
  const isNorthernHemisphere = lat >= 0;

  // Northern hemisphere fire season: Jun-Oct
  // Southern hemisphere fire season: Nov-Mar
  if (isNorthernHemisphere) {
    if (month >= 6 && month <= 10) return 1.0;
    if (month === 5 || month === 11) return 0.7;
    return 0.4;
  } else {
    if (month >= 11 || month <= 3) return 1.0;
    if (month === 4 || month === 10) return 0.7;
    return 0.4;
  }
}

// ─── Distance helper ─────────────────────────────────────────────────────────

function latLngDist(lat1: number, lng1: number, lat2: number, lng2: number): number {
  // Fast Euclidean approximation in degrees
  const dlat = lat1 - lat2;
  const dlng = (lng1 - lng2) * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

// ─── Wind transport helper ────────────────────────────────────────────────────

function getWindTransportScore(
  cellLat: number, cellLng: number,
  fires: FireEvent[]
): number {
  let maxScore = 0;
  for (const fire of fires) {
    const [fLat, fLng] = fire.coordinates;
    const distDeg = latLngDist(cellLat, cellLng, fLat, fLng);
    if (distDeg > PROXIMITY_RADIUS_DEG) continue;

    // Convert wind degrees to unit vector (wind blows FROM windDeg TO windDeg+180)
    const spreadDir = ((fire.windDeg + 180) % 360) * (Math.PI / 180);
    const dLat = cellLat - fLat;
    const dLng = cellLng - fLng;
    const bearingToCell = Math.atan2(dLng, dLat); // radians

    // Dot product: how aligned is the downwind direction with the cell direction
    const alignment = Math.cos(spreadDir - bearingToCell); // -1 to 1
    if (alignment <= 0) continue;

    const windStrength = Math.min(fire.windSpeed / 30, 1);
    const frpStrength = Math.min(fire.frp / 2000, 1);
    const distDecay = Math.max(0, 1 - distDeg / PROXIMITY_RADIUS_DEG);

    const score = alignment * windStrength * frpStrength * distDecay * 100;
    maxScore = Math.max(maxScore, score);
  }
  return Math.min(maxScore, 100);
}

// ─── Risk Level classify ─────────────────────────────────────────────────────

function classifyRisk(score: number): RiskLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 40) return 'MODERATE';
  return 'LOW';
}

// ─── Main Risk Grid Computation ───────────────────────────────────────────────

export function computeRiskGrid(
  fires: FireEvent[],
  isLive: boolean
): RiskCell[] {
  if (!fires || fires.length === 0) return [];

  // Determine bounding box with padding
  const lats = fires.map(f => f.coordinates[0]);
  const lngs = fires.map(f => f.coordinates[1]);
  const minLat = Math.max(-75, Math.min(...lats) - 3);
  const maxLat = Math.min(75, Math.max(...lats) + 3);
  const minLng = Math.max(-180, Math.min(...lngs) - 3);
  const maxLng = Math.min(180, Math.max(...lngs) + 3);

  const cells: RiskCell[] = [];

  // Only evaluate a sampled grid to keep computation fast
  // We iterate at 0.5° resolution
  for (let lat = minLat; lat <= maxLat; lat += GRID_SIZE) {
    for (let lng = minLng; lng <= maxLng; lng += GRID_SIZE) {
      const cellLat = parseFloat(lat.toFixed(1));
      const cellLng = parseFloat(lng.toFixed(1));

      // ── Factor 1: Fire frequency (fires within 100km ~ 1 deg) ───────────
      const nearbyFires = fires.filter(f => latLngDist(cellLat, cellLng, f.coordinates[0], f.coordinates[1]) < 1.0);
      if (nearbyFires.length === 0 && latLngDist(cellLat, cellLng, fires[0].coordinates[0], fires[0].coordinates[1]) > PROXIMITY_RADIUS_DEG) {
        // Skip cells with zero relevant data far from all fires (perf)
        const closestDist = Math.min(...fires.map(f => latLngDist(cellLat, cellLng, f.coordinates[0], f.coordinates[1])));
        if (closestDist > PROXIMITY_RADIUS_DEG) continue;
      }

      const freqScore = Math.min((nearbyFires.length / 15) * 100, 100);

      // ── Factor 2: FRP Intensity (weighted average within 2 deg) ─────────
      const proximFires = fires.filter(f => latLngDist(cellLat, cellLng, f.coordinates[0], f.coordinates[1]) < PROXIMITY_RADIUS_DEG);
      let frpScore = 0;
      if (proximFires.length > 0) {
        const avgFRP = proximFires.reduce((s, f) => s + f.frp, 0) / proximFires.length;
        frpScore = Math.min((avgFRP / 3000) * 100, 100);
      }

      // ── Factor 3: Proximity cascade ──────────────────────────────────────
      const adjacentFires = fires.filter(f => latLngDist(cellLat, cellLng, f.coordinates[0], f.coordinates[1]) < CASCADE_RADIUS_DEG);
      const cascadeScore = Math.min((adjacentFires.length / 5) * 100, 100);

      // ── Factor 4: Wind transport ─────────────────────────────────────────
      const windScore = getWindTransportScore(cellLat, cellLng, fires);

      // ── Factor 5: Biome vulnerability ────────────────────────────────────
      const biomeInfo = getBiomeFromCoords(cellLat, cellLng);
      const biomeScore = (BIOME_VULNERABILITY[biomeInfo.biome] ?? 0.5) * 100;

      // ── Factor 6: Season multiplier ──────────────────────────────────────
      const seasonScore = getSeasonMultiplier(cellLat) * 100;

      // ── Factor 7: Day/Night ───────────────────────────────────────────────
      // Day fires are more common and observable; night fires spread farther
      const dayFires = nearbyFires.filter(f => {
        // daynight field lives on the raw record; we use time as proxy
        const h = new Date().getUTCHours();
        return h >= 6 && h <= 18;
      });
      const dayNightScore = nearbyFires.length === 0 ? 50 : (dayFires.length / nearbyFires.length) * 100;

      // ── Weighted ensemble ─────────────────────────────────────────────────
      const score = Math.round(
        freqScore    * WEIGHTS.fireFrequency    +
        frpScore     * WEIGHTS.frpIntensity     +
        cascadeScore * WEIGHTS.proximityCascade +
        windScore    * WEIGHTS.windTransport    +
        biomeScore   * WEIGHTS.biomeVuln        +
        seasonScore  * WEIGHTS.seasonFactor     +
        dayNightScore * WEIGHTS.dayNightFactor
      );

      if (score < 20) continue; // filter out noise cells early

      // ── Confidence ────────────────────────────────────────────────────────
      const dataPoints = proximFires.length;
      const freshnessBonus = isLive ? 20 : 0;
      const confidence = Math.min(
        50 + freshnessBonus + Math.min(dataPoints * 3, 30),
        100
      );

      const country = getCountryFromCoords(cellLat, cellLng);
      const region = getSpecificRegion(cellLat, cellLng);
      const locationLabel = region && region !== country.name
        ? `${region}, ${country.name}`
        : country.name;

      cells.push({
        id: `cell-${cellLat.toFixed(1)}-${cellLng.toFixed(1)}`,
        lat: cellLat,
        lng: cellLng,
        score,
        level: classifyRisk(score),
        country: country.name,
        countryFlag: country.flag,
        region,
        locationLabel,
        biome: biomeInfo.biome,
        biomeColor: biomeInfo.color,
        factors: {
          fireFrequency:     Math.round(freqScore),
          frpIntensity:      Math.round(frpScore),
          proximityCascade:  Math.round(cascadeScore),
          windTransport:     Math.round(windScore),
          biomeVulnerability:Math.round(biomeScore),
          seasonFactor:      Math.round(seasonScore),
          dayNightFactor:    Math.round(dayNightScore),
        },
        confidence,
        nearbyFireCount: proximFires.length,
        dominantFRP: proximFires.length > 0 ? Math.round(Math.max(...proximFires.map(f => f.frp))) : 0,
      });
    }
  }

  // Sort by score descending, return top 50
  return cells
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CELLS_RETURNED);
}

// ─── Spread Cone Engine ───────────────────────────────────────────────────────

/**
 * Build a polygon approximating a spread cone sector
 * (centered at origin, spreading in `direction` with half-angle 30°)
 */
function buildConePolygon(
  lat: number,
  lng: number,
  radiusKm: number,
  directionDeg: number
): [number, number][] {
  const points: [number, number][] = [[lat, lng]];
  const halfAngle = 35; // degrees each side
  const steps = 12;
  const KM_PER_DEG = 111.32;

  for (let i = 0; i <= steps; i++) {
    const angle = directionDeg - halfAngle + (i / steps) * halfAngle * 2;
    const rad = angle * (Math.PI / 180);
    const dLat = (radiusKm / KM_PER_DEG) * Math.cos(rad);
    const dLng = (radiusKm / (KM_PER_DEG * Math.cos(lat * Math.PI / 180))) * Math.sin(rad);
    points.push([lat + dLat, lng + dLng]);
  }
  points.push([lat, lng]);
  return points;
}

export async function buildWeatherMap(
  fires: FireEvent[]
): Promise<Map<string, WeatherData>> {
  // Fetch weather only for top 5 by FRP
  const top5 = [...fires]
    .sort((a, b) => b.frp - a.frp)
    .slice(0, 5);

  const weatherMap = new Map<string, WeatherData>();

  await Promise.allSettled(
    top5.map(async (fire) => {
      const [lat, lng] = fire.coordinates;
      const weather = await fetchWeatherForCoords(lat, lng);
      weatherMap.set(fire.id, weather);
    })
  );

  return weatherMap;
}

export function computeSpreadCones(
  fires: FireEvent[],
  weatherMap: Map<string, WeatherData>
): SpreadCone[] {
  const top5 = [...fires]
    .sort((a, b) => b.frp - a.frp)
    .slice(0, 5);

  return top5.map(fire => {
    const weather = weatherMap.get(fire.id);
    const windSpeed = weather?.windSpeed ?? fire.windSpeed / 3.6; // convert km/h → m/s if needed
    const windDeg   = weather?.windDeg   ?? fire.windDeg;

    // Spread direction: opposite of wind origin (wind blows FROM windDeg)
    const spreadDirection = (windDeg + 180) % 360;

    // Spread radius: FRP-weighted × wind speed factor
    const frpFactor = Math.min(fire.frp / 100, 20);
    const windFactor = Math.min(windSpeed * 1.5, 15);
    const radiusKm = Math.max(5, frpFactor + windFactor);

    // Estimated area (sector area, half-angle = 35°)
    const halfAngleRad = 35 * (Math.PI / 180);
    const areaSqKm = halfAngleRad * radiusKm * radiusKm;
    const hectares = Math.round(areaSqKm * 100);
    const carbon   = Math.round(hectares * 68);

    const [lat, lng] = fire.coordinates;

    return {
      fireId:                fire.id,
      fireName:              fire.name,
      coneCenter:            [lat, lng],
      coneRadius:            radiusKm,
      coneDirection:         spreadDirection,
      conePolygon:           buildConePolygon(lat, lng, radiusKm, spreadDirection),
      estimatedHectares24h:  hectares,
      carbonRelease24h:      carbon,
      riskLevel:             classifyRisk(Math.min((fire.frp / 30) + windSpeed * 2, 100)),
      windSpeed:             Math.round(windSpeed * 10) / 10,
      windDeg,
    };
  });
}

// ─── Full prediction pipeline ─────────────────────────────────────────────────

export async function runPredictionPipeline(
  fires: FireEvent[],
  isLive: boolean
): Promise<PredictionResult> {
  const [riskCells, weatherMap] = await Promise.all([
    Promise.resolve(computeRiskGrid(fires, isLive)),
    buildWeatherMap(fires),
  ]);

  const spreadCones = computeSpreadCones(fires, weatherMap);
  const avgConfidence = riskCells.length
    ? Math.round(riskCells.reduce((s, c) => s + c.confidence, 0) / riskCells.length)
    : 0;

  return {
    riskCells,
    spreadCones,
    weatherMap,
    modelMetadata: {
      totalFiresAnalyzed:  fires.length,
      gridCellsEvaluated:  riskCells.length,
      dataFreshness:       isLive ? 'live' : 'cached',
      computedAt:          new Date().toISOString(),
      avgConfidence,
    },
  };
}
