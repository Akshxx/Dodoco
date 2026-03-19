import { Globe, Wifi, Satellite } from 'lucide-react';
import { useFireData } from '@/hooks/useFireData';
import { useState, useEffect } from 'react';

const TopUtilityBar = () => {
  const { data: fires, isLoading, dataUpdatedAt } = useFireData();
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const isLive = !isLoading && fires && fires.length > 0 && fires[0].id.startsWith('firms-');
  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : time.toLocaleTimeString();

  return (
    <div
      className="w-full py-1.5 px-4 flex items-center justify-between text-xs font-mono"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 40,
        zIndex: 1000,
        background: 'hsl(var(--utility-bar))',
        color: 'hsl(var(--primary-foreground))',
      }}
    >
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1"><Wifi className="w-3 h-3" /> LIVE</span>
        <span className="live-dot inline-block w-2 h-2 rounded-full bg-red-500" />
        <span>Wildfire Monitoring Active</span>
        {isLive && (
          <span className="flex items-center gap-1 ml-2 opacity-90">
            <Satellite className="w-3 h-3" />
            <span style={{ color: '#4ade80', fontWeight: 700 }}>
              NASA FIRMS · {fires!.length} active clusters
            </span>
          </span>
        )}
        {isLoading && <span className="ml-2 opacity-70">⟳ Fetching NASA FIRMS...</span>}
      </div>
      <div className="flex items-center gap-3">
        <span>Last Updated: {lastUpdate}</span>
        <Globe className="w-3 h-3" />
      </div>
    </div>
  );
};

export default TopUtilityBar;
