import { useQuery } from '@tanstack/react-query';
import { fetchActiveFires } from '@/services/firmsApi';
import { fireEvents as mockFires } from '@/data/mockData';
import type { FireEvent } from '@/services/apiTypes';

const TWELVE_MINUTES = 12 * 60 * 1000;

export function useFireData() {
  return useQuery<FireEvent[], Error>({
    queryKey: ['fires'],
    queryFn: async () => {
      const key = import.meta.env.VITE_FIRMS_MAP_KEY;

      if (!key) {
        console.warn('[useFireData] ⚠ No VITE_FIRMS_MAP_KEY — showing mock data');
        return mockFires as FireEvent[];
      }

      try {
        const fires = await fetchActiveFires();
        return fires;
      } catch (err: any) {
        // Surface the exact error in console so you can see what's wrong
        console.error('[useFireData] ❌ Live fetch failed:', err?.message ?? err);
        console.info('[useFireData] Falling back to mock data');
        return mockFires as FireEvent[];
      }
    },
    staleTime: TWELVE_MINUTES,
    refetchInterval: TWELVE_MINUTES,
    retry: 2,
    retryDelay: attemptIndex => Math.min(4000 * (attemptIndex + 1), 15000),
  });
}
