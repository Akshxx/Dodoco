import { useState, useMemo, useEffect } from 'react';
import { MapContainer, TileLayer, Rectangle, CircleMarker, Polygon, Marker, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts';
import {
  Flame, Globe, Wind, AlertTriangle, Layers,
  ChevronDown, ChevronUp, Loader2, ZapIcon, Thermometer,
  TreePine, Activity, Info, BarChart3, Map as MapIcon,
  Shield, TrendingUp, Eye, HelpCircle, CheckCircle2,
} from 'lucide-react';
import TopUtilityBar from '@/components/TopUtilityBar';
import Navbar from '@/components/Navbar';
import AuthModal from '@/components/AuthModal';
import SettingsModal from '@/components/SettingsModal';
import { useFireData } from '@/hooks/useFireData';
import {
  computeRiskGrid,
  computeSpreadCones,
  buildWeatherMap,
  type RiskCell,
  type SpreadCone,
  type RiskLevel,
} from '@/services/wildfireRiskModel';
import 'leaflet/dist/leaflet.css';

// ── helpers ────────────────────────────────────────────────────────────────────

const levelColor: Record<RiskLevel, string> = {
  CRITICAL: '#ef4444',
  HIGH:     '#f97316',
  MODERATE: '#eab308',
  LOW:      '#22c55e',
};
const levelBg: Record<RiskLevel, string> = {
  CRITICAL: 'bg-red-500/20 text-red-400 border border-red-500/30',
  HIGH:     'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  MODERATE: 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/30',
  LOW:      'bg-green-500/20 text-green-400 border border-green-500/30',
};

function formatNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Fix Leaflet default icon
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ── Leaflet invalidate on mount ───────────────────────────────────────────────
function MapInvalidator() {
  const map = useMap();
  useEffect(() => {
    setTimeout(() => map.invalidateSize(), 100);
  }, [map]);
  return null;
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

const LOADING_STEPS = [
  'Fetching live fire detections from NASA FIRMS…',
  'Clustering fire events across 6 continents…',
  'Computing risk scores for each grid cell…',
  'Fetching wind data for top wildfire sites…',
  'Building 24h spread cone predictions…',
];

function LoadingView({ step }: { step: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col items-center justify-center py-32 gap-8"
    >
      <div className="relative w-24 h-24">
        <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping" />
        <div className="absolute inset-0 rounded-full border border-primary/40 animate-pulse" style={{ animationDelay: '0.5s' }} />
        <div className="w-24 h-24 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
          <Flame className="w-10 h-10 text-primary animate-pulse" />
        </div>
      </div>

      <div className="text-center">
        <p className="text-primary font-mono text-xs tracking-widest uppercase mb-2">ML Prediction Engine Running</p>
        <p className="text-foreground/80 text-lg font-semibold min-h-7">
          {LOADING_STEPS[Math.min(step, LOADING_STEPS.length - 1)]}
        </p>
      </div>

      <div className="w-80 space-y-2">
        <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-primary to-secondary"
            initial={{ width: '5%' }}
            animate={{ width: `${((step + 1) / LOADING_STEPS.length) * 100}%` }}
            transition={{ duration: 0.4 }}
          />
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Step {step + 1} of {LOADING_STEPS.length}</span>
          <span>{Math.round(((step + 1) / LOADING_STEPS.length) * 100)}% complete</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1.5 w-80">
        {LOADING_STEPS.map((s, i) => (
          <div key={i} className={`flex items-center gap-2 text-xs transition-all ${i <= step ? 'text-primary' : 'text-muted-foreground/50'}`}>
            {i < step ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            ) : i === step ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            ) : (
              <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
            )}
            {s}
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// ── KPI stat card ─────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accentClass = 'text-primary',
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  accentClass?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card rounded-2xl p-5 card-hover-lift"
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 p-2 rounded-xl bg-primary/10 ${accentClass}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs uppercase tracking-wider font-mono">{label}</p>
          <p className="text-2xl font-bold font-heading mt-0.5">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
        </div>
      </div>
    </motion.div>
  );
}

// ── Risk zone card (feed) ────────────────────────────────────────────────────

function RiskZoneCard({ cell, index }: { cell: RiskCell; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.035 }}
      className="glass-card rounded-xl p-4 card-hover-lift border-l-4"
      style={{ borderLeftColor: levelColor[cell.level] }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="font-semibold text-sm leading-tight">
            {cell.countryFlag} {cell.locationLabel}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{cell.biome} · {cell.lat.toFixed(1)}°, {cell.lng.toFixed(1)}°</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${levelBg[cell.level]}`}>
            {cell.level}
          </span>
          <span className="text-xl font-bold font-heading" style={{ color: levelColor[cell.level] }}>
            {cell.score}
            <span className="text-xs font-normal text-muted-foreground">/100</span>
          </span>
        </div>
      </div>

      {/* Factor mini-bars */}
      <div className="grid grid-cols-5 gap-x-2 gap-y-1">
        {[
          { label: 'Frequency', val: cell.factors.fireFrequency },
          { label: 'Intensity', val: cell.factors.frpIntensity },
          { label: 'Cascade',  val: cell.factors.proximityCascade },
          { label: 'Wind',     val: cell.factors.windTransport },
          { label: 'Biome',    val: cell.factors.biomeVulnerability },
        ].map(f => (
          <div key={f.label} className="flex flex-col gap-0.5">
            <div className="h-1 bg-border rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${f.val}%`, backgroundColor: levelColor[cell.level] }}
              />
            </div>
            <span className="text-[9px] text-muted-foreground text-center leading-none">{f.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{cell.nearbyFireCount} active fires nearby</span>
        <span className="text-primary/70">{cell.confidence}% confidence</span>
      </div>
    </motion.div>
  );
}

// ── Layer toggle ──────────────────────────────────────────────────────────────

function LayerToggle({ label, active, color, onClick }: {
  label: string; active: boolean; color: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
        active
          ? 'text-white border-transparent'
          : 'border-border text-muted-foreground hover:border-primary/40 hover:text-primary'
      }`}
      style={active ? { backgroundColor: color + '55', borderColor: color + '80', color } : {}}
    >
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: active ? color : 'currentColor', opacity: active ? 1 : 0.4 }} />
        {label}
      </span>
    </button>
  );
}

// ── Newcomer Guide Banner ─────────────────────────────────────────────────────

function GuideBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="glass-card rounded-2xl border-l-4 border-l-primary p-4"
    >
      <div className="flex items-start gap-4">
        <div className="p-2 rounded-xl bg-primary/10 text-primary shrink-0">
          <HelpCircle className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm mb-1">🌍 How to read this dashboard</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs text-muted-foreground">
            <div className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0 mt-0.5" />
              <span><strong className="text-foreground">Red zones</strong> = CRITICAL risk areas — wildfires most likely to occur or spread here within 24h</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-orange-400 shrink-0 mt-0.5" />
              <span><strong className="text-foreground">Orange cones</strong> = Predicted fire spread direction, calculated from real-time wind data</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-400 shrink-0 mt-0.5" />
              <span><strong className="text-foreground">Blue arrows</strong> = Wind direction at each active fire — shows where the fire is heading</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-primary shrink-0 mt-0.5" />
              <span><strong className="text-foreground">Risk score 0–100</strong> = Our ML model's certainty that this area is at risk (higher = more danger)</span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground transition-colors text-xs shrink-0"
        >
          Dismiss
        </button>
      </div>
    </motion.div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type FilterTab = 'ALL' | RiskLevel;

export default function PredictPage() {
  const { data: fires = [], isLoading, dataUpdatedAt } = useFireData() as any;
  const isLive = !!(import.meta.env.VITE_FIRMS_MAP_KEY);

  // Shell state for Navbar (mirrors Index.tsx pattern)
  const [authModal, setAuthModal] = useState<{ open: boolean; mode: 'login' | 'signup' }>({ open: false, mode: 'login' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Model state
  const [loadingStep, setLoadingStep] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [filterTab, setFilterTab] = useState<FilterTab>('ALL');
  const [showExplainer, setShowExplainer] = useState(false);
  const [spreadCones, setSpreadCones] = useState<SpreadCone[]>([]);

  // Layer visibility — all start true
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showFires,   setShowFires]   = useState(true);
  const [showCones,   setShowCones]   = useState(true);
  const [showWind,    setShowWind]    = useState(true);

  // Compute risk grid via useMemo
  const riskCells = useMemo(() => {
    if (!fires.length) return [];
    return computeRiskGrid(fires, isLive);
  }, [fires, isLive]);

  // Async: weather + cones
  useEffect(() => {
    if (!fires.length) return;
    let cancelled = false;

    async function run() {
      for (let i = 0; i < LOADING_STEPS.length - 1; i++) {
        if (cancelled) return;
        setLoadingStep(i);
        await new Promise(r => setTimeout(r, i === 2 ? 700 : 450));
      }
      const wm = await buildWeatherMap(fires);
      if (cancelled) return;
      setLoadingStep(LOADING_STEPS.length - 1);
      await new Promise(r => setTimeout(r, 350));
      const cones = computeSpreadCones(fires, wm);
      if (!cancelled) { setSpreadCones(cones); setModelReady(true); }
    }
    run();
    return () => { cancelled = true; };
  }, [fires]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const criticalCells = riskCells.filter(c => c.level === 'CRITICAL');
  const highCells     = riskCells.filter(c => c.level === 'HIGH');
  const topCell       = riskCells[0];
  const totalAreaHa   = (criticalCells.length + highCells.length) * 250_000;
  const avgConf       = riskCells.length
    ? Math.round(riskCells.reduce((s, c) => s + c.confidence, 0) / riskCells.length)
    : 0;

  const filteredCells = filterTab === 'ALL'
    ? riskCells.slice(0, 15)
    : riskCells.filter(c => c.level === filterTab).slice(0, 15);

  const countryRisk = useMemo(() => {
    const map = new Map<string, { flag: string; score: number }>();
    for (const c of riskCells) {
      const ex = map.get(c.country) ?? { flag: c.countryFlag, score: 0 };
      if (c.score > ex.score) map.set(c.country, { flag: c.countryFlag, score: c.score });
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name: `${v.flag} ${name}`, score: v.score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [riskCells]);

  const biomeData = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of riskCells) map.set(c.biome, (map.get(c.biome) ?? 0) + 1);
    return [...map.entries()].map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value).slice(0, 6);
  }, [riskCells]);

  const BIOME_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6'];

  const mapCenter: [number, number] = topCell ? [topCell.lat, topCell.lng] : [10, 20];

  const LAST_UPDATED = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : '–';

  const factorInfo = [
    { name: 'FRP Intensity',       weight: 25, icon: Flame,         desc: 'Fire Radiative Power from NASA FIRMS satellite pixels' },
    { name: 'Fire Frequency',      weight: 20, icon: Activity,       desc: 'Historical occurrence density within 100 km' },
    { name: 'Proximity Cascade',   weight: 20, icon: AlertTriangle,  desc: 'Adjacent cells to active fires get boosted risk' },
    { name: 'Wind Transport',      weight: 15, icon: Wind,           desc: 'Downwind cells boosted by real-time wind speed & direction' },
    { name: 'Biome Vulnerability', weight: 10, icon: TreePine,       desc: 'Tropical Forest 90% → Boreal Forest 50%' },
    { name: 'Season Multiplier',   weight: 5,  icon: Thermometer,    desc: 'Fire season factor by hemisphere and month' },
    { name: 'Day/Night Factor',    weight: 5,  icon: ZapIcon,        desc: 'Day vs night fire spread dynamics from satellite data' },
  ];

  const windIcon = (deg: number) => L.divIcon({
    html: `<div style="transform:rotate(${deg}deg);font-size:18px;color:#60a5fa;line-height:1;filter:drop-shadow(0 0 3px rgba(96,165,250,0.8))">➤</div>`,
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  return (
    <div className="min-h-screen bg-background text-foreground" style={{ paddingTop: 110 }}>
      {/* ── Navbar (same as Index page) ── */}
      <TopUtilityBar />
      <Navbar
        onOpenAuth={(mode) => setAuthModal({ open: true, mode })}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleSidebar={() => setSidebarOpen(prev => !prev)}
      />

      {/* ── Page content ── */}
      <div className="max-w-[1600px] mx-auto px-4 py-8 space-y-6">

        {/* ── Page header ── */}
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4"
        >
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Shield className="w-5 h-5 text-primary" />
              <span className="text-xs font-mono text-primary uppercase tracking-widest">AI Risk Engine</span>
              <span className={`ml-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${
                isLive ? 'bg-primary/15 text-primary' : 'bg-secondary/15 text-secondary'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-primary animate-pulse' : 'bg-secondary'}`} />
                {isLive ? 'Live Data' : 'Demo Mode'}
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-heading font-bold leading-tight">
              Wildfire Risk Prediction
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Browser-native ML ensemble model · {fires.length} fire clusters · Updated {LAST_UPDATED}
            </p>
          </div>
          {modelReady && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20">
                <TrendingUp className="w-3.5 h-3.5 text-primary" />
                <span className="text-primary text-xs font-medium">Model Active · {avgConf}% avg confidence</span>
              </div>
            </div>
          )}
        </motion.div>

        {/* ── Newcomer guide ── */}
        <AnimatePresence>
          <GuideBanner />
        </AnimatePresence>

        {/* ── Loading / Content ── */}
        <AnimatePresence mode="wait">
          {!modelReady ? (
            <LoadingView key="loading" step={loadingStep} />
          ) : (
            <motion.div
              key="content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="space-y-6"
            >
              {/* ── KPI cards ── */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  icon={AlertTriangle}
                  label="High-Risk Zones"
                  value={criticalCells.length + highCells.length}
                  sub={`${criticalCells.length} CRITICAL · ${highCells.length} HIGH`}
                  accentClass="text-red-400"
                />
                <StatCard
                  icon={Flame}
                  label="Highest Risk Score"
                  value={topCell?.score ?? '—'}
                  sub={topCell ? topCell.locationLabel : ''}
                  accentClass="text-secondary"
                />
                <StatCard
                  icon={Globe}
                  label="Total Area at Risk"
                  value={formatNum(totalAreaHa) + ' ha'}
                  sub="CRITICAL + HIGH zones combined"
                  accentClass="text-blue-400"
                />
                <StatCard
                  icon={Eye}
                  label="Model Confidence"
                  value={`${avgConf}%`}
                  sub={isLive ? 'Live NASA FIRMS data' : 'Running on demo data'}
                  accentClass="text-primary"
                />
              </div>

              {/* ── Main two-col layout ── */}
              <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">

                {/* LEFT: Risk Feed */}
                <div className="xl:col-span-2 glass-card rounded-2xl flex flex-col overflow-hidden" style={{ maxHeight: 640 }}>
                  <div className="p-4 border-b border-border">
                    <div className="flex items-center gap-2 mb-3">
                      <Activity className="w-4 h-4 text-primary" />
                      <h2 className="font-semibold text-sm uppercase tracking-wider text-primary">Risk Zone Intelligence</h2>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      Areas ranked by our 7-factor wildfire risk model. Scores above 60 indicate active danger.
                    </p>
                    {/* Filter tabs */}
                    <div className="flex gap-1.5 flex-wrap">
                      {(['ALL', 'CRITICAL', 'HIGH', 'MODERATE'] as FilterTab[]).map(tab => (
                        <button
                          key={tab}
                          onClick={() => setFilterTab(tab)}
                          className={`px-3 py-1 rounded-full text-xs font-semibold transition-all border ${
                            filterTab === tab
                              ? tab === 'ALL'
                                ? 'bg-primary/20 border-primary/40 text-primary'
                                : `${levelBg[tab as RiskLevel]}`
                              : 'border-border text-muted-foreground hover:border-primary/30'
                          }`}
                        >
                          {tab}
                          {tab !== 'ALL' && (
                            <span className="ml-1.5 opacity-70 text-[10px]">
                              {riskCells.filter(c => c.level === tab).length}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="overflow-y-auto flex-1 p-3 space-y-2 scrollbar-hide">
                    <AnimatePresence mode="popLayout">
                      {filteredCells.map((cell, i) => (
                        <RiskZoneCard key={cell.id} cell={cell} index={i} />
                      ))}
                      {filteredCells.length === 0 && (
                        <p className="text-center text-muted-foreground text-sm py-10">
                          No {filterTab} risk zones found.
                        </p>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* RIGHT: Map */}
                <div className="xl:col-span-3 glass-card rounded-2xl flex flex-col overflow-hidden" style={{ height: 640 }}>
                  {/* Layer toggles */}
                  <div className="p-3 border-b border-border flex items-center gap-2 flex-wrap shrink-0">
                    <MapIcon className="w-4 h-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-mono uppercase tracking-wide mr-1">Layers</span>
                    <LayerToggle label="Risk Heatmap" active={showHeatmap} color="#ef4444" onClick={() => setShowHeatmap(v => !v)} />
                    <LayerToggle label="Active Fires"  active={showFires}   color="#f97316" onClick={() => setShowFires(v => !v)} />
                    <LayerToggle label="Spread Cones"  active={showCones}   color="#f59e0b" onClick={() => setShowCones(v => !v)} />
                    <LayerToggle label="Wind Vectors"  active={showWind}    color="#60a5fa" onClick={() => setShowWind(v => !v)} />
                  </div>

                  <div className="relative flex-1">
                    <MapContainer
                      center={mapCenter}
                      zoom={3}
                      style={{ height: '100%', width: '100%' }}
                      className="rounded-b-2xl"
                      preferCanvas
                    >
                      <MapInvalidator />
                      <TileLayer
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        attribution="Tiles &copy; Esri"
                      />

                      {/* Risk heatmap — rendered only when showHeatmap is true */}
                      {showHeatmap && riskCells.map(cell => {
                        const half = 0.25;
                        return (
                          <Rectangle
                            key={cell.id}
                            bounds={[
                              [cell.lat - half, cell.lng - half],
                              [cell.lat + half, cell.lng + half],
                            ]}
                            pathOptions={{
                              color: levelColor[cell.level],
                              fillColor: levelColor[cell.level],
                              fillOpacity: cell.level === 'CRITICAL' ? 0.55 : cell.level === 'HIGH' ? 0.40 : 0.22,
                              weight: cell.level === 'CRITICAL' ? 1.5 : 0.5,
                              opacity: 0.7,
                            }}
                          >
                            <Tooltip sticky>
                              <div className="text-xs">
                                <strong>{cell.level} RISK — Score {cell.score}/100</strong><br />
                                📍 {cell.locationLabel}<br />
                                🌿 {cell.biome}<br />
                                🔥 FRP: {cell.dominantFRP} MW · Conf: {cell.confidence}%
                              </div>
                            </Tooltip>
                          </Rectangle>
                        );
                      })}

                      {/* Active fires */}
                      {showFires && fires.map((fire: any, i: number) => (
                        <CircleMarker
                          key={fire.id ?? i}
                          center={fire.coordinates}
                          radius={Math.min(4 + Math.log1p(fire.frp) * 1.2, 16)}
                          pathOptions={{
                            color: '#ef4444',
                            fillColor: '#f97316',
                            fillOpacity: 0.85,
                            weight: 1.5,
                          }}
                        >
                          <Tooltip>
                            <div className="text-xs">
                              <strong>🔥 {fire.name}</strong><br />
                              FRP: {fire.frp} MW · {fire.biome}
                            </div>
                          </Tooltip>
                        </CircleMarker>
                      ))}

                      {/* Spread cones */}
                      {showCones && spreadCones.map(cone => (
                        <Polygon
                          key={cone.fireId}
                          positions={cone.conePolygon}
                          pathOptions={{
                            color: '#f59e0b',
                            fillColor: '#f59e0b',
                            fillOpacity: 0.28,
                            weight: 1.5,
                            opacity: 0.8,
                            dashArray: '5 4',
                          }}
                        >
                          <Tooltip>
                            <div className="text-xs">
                              <strong>24h Spread — {cone.fireName}</strong><br />
                              Estimated spread: {cone.estimatedHectares24h.toLocaleString()} ha<br />
                              Wind: {cone.windDeg}° at {cone.windSpeed} m/s<br />
                              Carbon: {formatNum(cone.carbonRelease24h)} tonnes
                            </div>
                          </Tooltip>
                        </Polygon>
                      ))}

                      {/* Wind arrows */}
                      {showWind && spreadCones.map(cone => (
                        <Marker
                          key={`wind-${cone.fireId}`}
                          position={cone.coneCenter}
                          icon={windIcon(cone.windDeg)}
                        >
                          <Tooltip direction="top" offset={[0, -14]}>
                            <span className="text-xs">Wind: {cone.windDeg}° · {cone.windSpeed} m/s</span>
                          </Tooltip>
                        </Marker>
                      ))}
                    </MapContainer>

                    {/* Map legend overlay */}
                    <div className="absolute bottom-3 right-3 bg-background/90 backdrop-blur-sm rounded-xl border border-border p-2.5 text-xs z-[400] space-y-1">
                      {(Object.entries(levelColor) as [RiskLevel, string][]).map(([level, color]) => (
                        <div key={level} className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-sm opacity-70" style={{ backgroundColor: color }} />
                          <span className="text-muted-foreground">{level}</span>
                        </div>
                      ))}
                      <div className="border-t border-border pt-1 mt-1">
                        <div className="flex items-center gap-2">
                          <span style={{ color: '#f59e0b' }}>▷</span>
                          <span className="text-muted-foreground">24h Spread</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span style={{ color: '#60a5fa' }}>➤</span>
                          <span className="text-muted-foreground">Wind Direction</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Bottom 3-col analytics ── */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {/* Country bar chart */}
                <div className="glass-card rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-1">
                    <BarChart3 className="w-4 h-4 text-secondary" />
                    <h3 className="font-semibold text-sm">Top Countries at Risk</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">Peak risk score per country from our model</p>
                  <ResponsiveContainer width="100%" height={175}>
                    <BarChart data={countryRisk} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: 'hsl(var(--foreground))' }} width={96} axisLine={false} tickLine={false} />
                      <RTooltip
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 10, fontSize: 12 }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                      />
                      <Bar dataKey="score" radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}>
                        {countryRisk.map((_, i) => (
                          <Cell key={i} fill={['#ef4444','#f97316','#f59e0b','#22c55e','#3b82f6'][i % 5]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Biome donut */}
                <div className="glass-card rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-1">
                    <TreePine className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold text-sm">Risk Zones by Biome</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">Which ecosystems are most endangered</p>
                  <ResponsiveContainer width="100%" height={175}>
                    <PieChart>
                      <Pie data={biomeData} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={60} innerRadius={32} paddingAngle={2}>
                        {biomeData.map((_, i) => <Cell key={i} fill={BIOME_COLORS[i % BIOME_COLORS.length]} />)}
                      </Pie>
                      <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 10 }} />
                      <RTooltip
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 10, fontSize: 12 }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                {/* Spread forecast */}
                <div className="glass-card rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-1">
                    <Wind className="w-4 h-4 text-blue-400" />
                    <h3 className="font-semibold text-sm">24h Spread Forecast</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">Largest fires with predicted spread area using live wind data</p>
                  <div className="space-y-3">
                    {spreadCones.length === 0 && (
                      <p className="text-xs text-muted-foreground">Computing spread predictions…</p>
                    )}
                    {spreadCones.map((cone, i) => (
                      <motion.div
                        key={cone.fireId}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.08 }}
                        className="flex items-center gap-3 pb-3 border-b border-border last:border-0 last:pb-0"
                      >
                        <div className="w-8 h-8 rounded-lg bg-secondary/10 flex items-center justify-center shrink-0">
                          <Flame className="w-4 h-4 text-secondary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold truncate">{cone.fireName}</p>
                          <p className="text-[10px] text-muted-foreground">
                            Wind {cone.windDeg}° · {cone.windSpeed} m/s
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-secondary">{formatNum(cone.estimatedHectares24h)} ha</p>
                          <p className="text-[10px] text-muted-foreground">{formatNum(cone.carbonRelease24h)} t CO₂</p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ── Model explainability ── */}
              <div className="glass-card rounded-2xl overflow-hidden">
                <button
                  onClick={() => setShowExplainer(!showExplainer)}
                  className="w-full px-5 py-4 flex items-center justify-between hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Info className="w-4 h-4 text-primary" />
                    <span className="font-semibold text-sm">How our prediction model works</span>
                    <span className="hidden sm:inline text-xs text-muted-foreground">— Fully transparent, not a black box</span>
                  </div>
                  {showExplainer ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </button>

                <AnimatePresence>
                  {showExplainer && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden border-t border-border"
                    >
                      <div className="p-5 space-y-5">
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          Dodoco's risk engine scores each <strong>0.5° × 0.5° geographic cell</strong> (approx. 55 km²) using 7 weighted factors derived entirely from live satellite data and real-time weather. Every number is directly traceable to a real observation — no hidden parameters.
                        </p>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                          {factorInfo.map(f => (
                            <div key={f.name} className="glass-card rounded-xl p-3 border-t-2" style={{ borderTopColor: `hsl(${(f.weight * 10) + 20}, 80%, 55%)` }}>
                              <div className="flex items-center gap-2 mb-2">
                                <f.icon className="w-4 h-4 text-primary shrink-0" />
                                <span className="text-xs font-bold">{f.name}</span>
                                <span className="ml-auto text-xs font-mono font-bold text-primary">{f.weight}%</span>
                              </div>
                              <div className="h-1 bg-muted rounded-full mb-2 overflow-hidden">
                                <div className="h-full bg-primary rounded-full" style={{ width: `${(f.weight / 25) * 100}%` }} />
                              </div>
                              <p className="text-[10px] text-muted-foreground leading-relaxed">{f.desc}</p>
                            </div>
                          ))}
                        </div>

                        {/* Data quality panel */}
                        <div className="bg-primary/5 border border-primary/15 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                          <div>
                            <p className="text-2xl font-bold text-primary font-heading">{fires.length}</p>
                            <p className="text-xs text-muted-foreground mt-1">Fire clusters fed to model</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-secondary font-heading">{riskCells.length}</p>
                            <p className="text-xs text-muted-foreground mt-1">Grid cells evaluated</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold font-heading" style={{ color: isLive ? 'hsl(var(--primary))' : 'hsl(var(--secondary))' }}>
                              {isLive ? 'LIVE' : 'DEMO'}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">NASA FIRMS data source</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-blue-400 font-heading">{LAST_UPDATED}</p>
                            <p className="text-xs text-muted-foreground mt-1">Data last refreshed</p>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Modals (same as Index page) ── */}
      <AuthModal
        isOpen={authModal.open}
        onClose={() => setAuthModal({ ...authModal, open: false })}
        initialMode={authModal.mode}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
