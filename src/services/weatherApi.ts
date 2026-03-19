const API_KEY = import.meta.env.VITE_OPENWEATHER_API_KEY;
const BASE_URL = 'https://api.openweathermap.org/data/2.5/weather';

export interface WeatherData {
  windSpeed: number;    // in m/s
  windDeg: number;      // in degrees
  temperature: number;  // in °C
  humidity: number;     // in %
}

export const fetchWeatherForCoords = async (lat: number, lon: number): Promise<WeatherData> => {
  if (!API_KEY) {
    // Realistic fallback values for a fire zone
    return { windSpeed: 5, windDeg: 45, temperature: 32, humidity: 35 };
  }

  try {
    const url = `${BASE_URL}?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Weather API error: ${response.status}`);
    
    const data = await response.json();
    return {
      windSpeed: data.wind?.speed ?? 5,
      windDeg:   data.wind?.deg   ?? 45,
      temperature: data.main?.temp     ?? 32,
      humidity:    data.main?.humidity ?? 35,
    };
  } catch (error) {
    console.error('Error fetching weather data:', error);
    return { windSpeed: 5, windDeg: 45, temperature: 32, humidity: 35 };
  }
};
