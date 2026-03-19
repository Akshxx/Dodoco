import type { FireEvent, Species } from '@/services/apiTypes';
import type { WeatherData } from '@/services/weatherApi';

const GEMINI_API_KEY = 'AIzaSyCmbKG1zZwfKLoKs2J-783Q7JiKYBDuST4';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

export async function generateFireAnalysis(
  fire: FireEvent,
  species: Species[],
  weather: WeatherData | null
): Promise<string> {
  const threatened = species.filter(s => ['CR', 'EN', 'VU'].includes(s.iucnStatus));
  const endemics = species.filter(s => s.isEndemic);

  const prompt = `You are DODOCO, a professional wildfire intelligence platform. Generate a precise, data-driven fire analysis report paragraph (exactly 4 sentences) for this active fire event. Be technical, specific, and authoritative.

FIRE DATA:
- Name: ${fire.name}
- Country: ${fire.country} ${fire.countryFlag}
- Biome: ${fire.biome}
- Intensity: ${fire.intensity.toUpperCase()}
- Fire Radiative Power (FRP): ${fire.frp} MW
- Area Burned: ${fire.areaBurned.toLocaleString()} hectares
- Active Duration: ${fire.duration} hours
- Carbon Released: ${(fire.carbonReleased / 1000).toFixed(1)}K tonnes
- Ecosystem Recovery: ~${fire.recoveryYears} years
- Biodiversity Score: ${fire.biodiversityScore}/100
- Trend: ${fire.trend === 'up' ? `expanding +${fire.trendPercent}%` : fire.trend === 'down' ? `contracting -${fire.trendPercent}%` : 'stable'} in last 24h
- Coordinates: ${fire.coordinates[0].toFixed(4)}°N, ${fire.coordinates[1].toFixed(4)}°E

SPECIES IMPACT:
- Total Species at Risk: ${species.length}
- Threatened Species (VU/EN/CR): ${threatened.length} — ${threatened.map(s => `${s.commonName} (${s.iucnStatus})`).join(', ') || 'None detected'}
- Endemic Species: ${endemics.length} — ${endemics.map(s => s.commonName).join(', ') || 'None'}

METEOROLOGICAL:
${weather ? `- Wind Speed: ${weather.windSpeed} m/s (${(weather.windSpeed * 3.6).toFixed(1)} km/h)
- Wind Direction: ${weather.windDeg}°
${(weather as any).temperature !== undefined ? `- Surface Temp: ${(weather as any).temperature}°C` : ''}
${(weather as any).humidity !== undefined ? `- Humidity: ${(weather as any).humidity}%` : ''}` : '- Weather data unavailable'}

Generate exactly 4 sentences:
1. Current fire behavior and thermal intensity assessment
2. Ecological impact on biodiversity and habitat corridors
3. Meteorological factors influencing fire behavior and spread trajectory
4. Priority response recommendations with specific actionable steps

Output ONLY the 4-sentence paragraph, no headers or bullet points.`;

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 400,
          temperature: 0.65,
          topP: 0.9,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[geminiApi] Error response:', errText);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Empty Gemini response');
    return text;
  } catch (err) {
    console.warn('[geminiApi] Falling back to existing aiSummary:', err);
    return fire.aiSummary;
  }
}
