import { useRef } from 'react';
import type { FireEvent, Species } from '@/services/apiTypes';

// ─── TYPES ────────────────────────────────────────────────────────────────────
export interface ReportWeather {
  windSpeed: number;
  windDeg: number;
  temperature: number;
  humidity: number;
}

interface Props {
  fire: FireEvent;
  species: Species[];
  weather: ReportWeather;
}

// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const T = {
  bg:          '#f4f6f9',
  surface:     '#ffffff',
  surfaceHigh: '#f8fafc',
  border:      '#e2e8f0',
  borderSub:   '#edf2f7',
  textPrimary: '#0f172a',
  textSec:     '#475569',
  textMuted:   '#94a3b8',
  amber:       '#d97706',
  red:         '#dc2626',
  orange:      '#ea580c',
  yellow:      '#ca8a04',
  green:       '#16a34a',
  blue:        '#2563eb',
  purple:      '#7c3aed',
  mono:        "'JetBrains Mono', 'Fira Code', monospace",
  sans:        "'DM Sans', 'Barlow', system-ui, sans-serif",
  heading:     "'Barlow Condensed', 'DM Sans', system-ui, sans-serif",
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const IUCN_COLORS: Record<string, string> = { CR: '#ef4444', EN: '#f97316', VU: '#eab308', NT: '#3b82f6', LC: '#22c55e' };
const IUCN_LABELS: Record<string, string> = { CR: 'Critically Endangered', EN: 'Endangered', VU: 'Vulnerable', NT: 'Near Threatened', LC: 'Least Concern' };
const INTENSITY_COLORS: Record<string, string> = { extreme: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' };

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}
function windDirLabel(deg: number) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}
function severityLabel(score: number) {
  if (score >= 80) return { label: 'Catastrophic', color: T.red };
  if (score >= 60) return { label: 'Severe',       color: T.orange };
  if (score >= 40) return { label: 'Moderate',     color: T.yellow };
  return                   { label: 'Low',          color: T.green };
}

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300&family=JetBrains+Mono:wght@400;500;700&display=swap');

  .dfr * { box-sizing: border-box; margin: 0; padding: 0; }

  @keyframes dfr-fadein { from { opacity:0; transform:translateY(5px) } to { opacity:1; transform:translateY(0) } }
  @keyframes dfr-pulse  { 0%,100%{opacity:1} 50%{opacity:.3} }
  @keyframes dfr-bar    { from{width:0} to{width:var(--bw)} }

  .dfr { animation: dfr-fadein .45s ease both; font-family: 'DM Sans', system-ui, sans-serif; }
  .dfr-pulse { animation: dfr-pulse 2.2s ease infinite; }
  .dfr-animbar { animation: dfr-bar 1s cubic-bezier(.4,0,.2,1) both; }
  .dfr-statcard { transition: border-color .15s, background .15s; }
  .dfr-statcard:hover { background: #f8fafc !important; border-color: #cbd5e1 !important; }
  .dfr-row:hover td { background: #f8fafc !important; }
  .dfr-activerow td { background: #fffbeb !important; }
  .dfr-card:hover { background: #f8fafc !important; }
  .dfr-scanlines {
    background-image: repeating-linear-gradient(
      180deg,
      transparent 0px, transparent 3px,
      rgba(0,0,0,.012) 3px, rgba(0,0,0,.012) 4px
    );
  }
`;

// ─── ATOMS ────────────────────────────────────────────────────────────────────
function Badge({ children, color, dot }: { children: React.ReactNode; color: string; dot?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 3,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.11em',
      color, background: color + '15', border: `1px solid ${color}35`,
      textTransform: 'uppercase', fontFamily: T.mono, flexShrink: 0,
    }}>
      {dot && (
        <span className="dfr-pulse" style={{
          width: 5, height: 5, borderRadius: '50%',
          background: color, display: 'inline-block', flexShrink: 0,
        }} />
      )}
      {children}
    </span>
  );
}

function MetaTag({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 2,
      fontSize: 9, fontWeight: 600, letterSpacing: '0.1em',
      color: T.textMuted, background: T.bg,
      border: `1px solid ${T.border}`,
      textTransform: 'uppercase', fontFamily: T.mono,
    }}>{children}</span>
  );
}

function HRule({ label }: { label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '26px 0 22px' }}>
      {label && (
        <span style={{
          fontFamily: T.mono, fontSize: 8, fontWeight: 600,
          color: T.textMuted, letterSpacing: '0.2em',
          textTransform: 'uppercase', flexShrink: 0,
        }}>{label}</span>
      )}
      <div style={{ flex: 1, height: '1px', background: T.borderSub }} />
    </div>
  );
}

function SectionHeader({ number, title }: { number: string | number; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
      <span style={{
        fontFamily: T.mono, fontSize: 10, fontWeight: 500,
        color: T.textMuted, letterSpacing: '0.1em', flexShrink: 0,
      }}>§{String(number).padStart(2, '0')}</span>
      <h2 style={{
        fontFamily: T.heading, fontSize: 12, fontWeight: 700,
        color: T.textPrimary, letterSpacing: '0.1em',
        textTransform: 'uppercase',
      }}>{title}</h2>
      <div style={{ flex: 1, height: '1px', background: T.border }} />
    </div>
  );
}

function StatCard({ icon, value, label, sub, accent }: { icon: string; value: string; label: string; sub?: string; accent?: string }) {
  return (
    <div className="dfr-statcard" style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderTop: `2px solid ${accent || T.amber}`,
      borderRadius: 5, padding: '16px 18px',
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      <span style={{ fontSize: 14, lineHeight: 1 }}>{icon}</span>
      <span style={{
        fontFamily: T.mono, fontSize: 21, fontWeight: 700,
        color: accent || T.amber, lineHeight: 1.05,
        letterSpacing: '-0.02em',
      }}>{value}</span>
      <span style={{
        fontFamily: T.sans, fontSize: 9, fontWeight: 600,
        color: T.textSec, textTransform: 'uppercase', letterSpacing: '0.1em',
      }}>{label}</span>
      {sub && (
        <span style={{ fontFamily: T.sans, fontSize: 10, color: T.textMuted, lineHeight: 1.5 }}>{sub}</span>
      )}
    </div>
  );
}

function ProgressRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
        <span style={{ fontFamily: T.sans, fontSize: 11, color: T.textSec }}>{label}</span>
        <span style={{ fontFamily: T.mono, fontSize: 10, color, fontWeight: 700 }}>{value} / {max}</span>
      </div>
      <div style={{ height: 2, background: T.borderSub, borderRadius: 1, overflow: 'hidden' }}>
        <div className="dfr-animbar" style={{
          ['--bw' as string]: `${pct}%`, width: `${pct}%`,
          height: '100%', background: color, borderRadius: 1,
        }} />
      </div>
    </div>
  );
}

function IUCNBar({ species }: { species: Species[] }) {
  const counts: Record<string, number> = { CR: 0, EN: 0, VU: 0, NT: 0, LC: 0 };
  species.forEach(s => { if (s.iucnStatus in counts) counts[s.iucnStatus]++; });
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', gap: 1, marginBottom: 9 }}>
        {Object.entries(counts).map(([status, count]) =>
          count > 0 && (
            <div key={status} style={{
              flex: count, background: IUCN_COLORS[status], minWidth: 4,
            }} title={`${IUCN_LABELS[status]}: ${count}`} />
          )
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 14px' }}>
        {Object.entries(counts).map(([status, count]) =>
          count > 0 && (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 5, height: 5, borderRadius: 1, background: IUCN_COLORS[status], flexShrink: 0 }} />
              <span style={{ fontFamily: T.sans, fontSize: 10, color: T.textSec }}>
                <b style={{ color: IUCN_COLORS[status] }}>{count}</b> {IUCN_LABELS[status]}
              </span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function ScoreGauge({ score }: { score: number }) {
  const { label, color } = severityLabel(score);
  const W = 148, H = 86;
  const cx = 74, cy = 80, R = 58;

  function polarXY(pct: number, radius: number): [number, number] {
    const angle = Math.PI + (pct / 100) * Math.PI;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  }
  function arc(from: number, to: number, r: number) {
    const [x1, y1] = polarXY(from, r);
    const [x2, y2] = polarXY(to, r);
    const large = (to - from) > 50 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  const ticks = Array.from({ length: 11 }, (_, i) => i * 10);
  const [nx, ny] = polarXY(score, R - 10);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {([[0,40,T.green],[40,70,T.yellow],[70,85,T.orange],[85,100,T.red]] as [number,number,string][]).map(([f,t,c]) => (
          <path key={f} d={arc(f, t, R)} fill="none" stroke={c + '28'} strokeWidth="8" />
        ))}
        <path d={arc(0, 100, R)} fill="none" stroke={T.border} strokeWidth="1.5" strokeLinecap="butt" />
        <path d={arc(0, score, R)} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        {ticks.map(t => {
          const [ox, oy] = polarXY(t, R + 5);
          const [ix, iy] = polarXY(t, R + 10);
          return (
            <line key={t} x1={ox} y1={oy} x2={ix} y2={iy}
              stroke={t % 50 === 0 ? T.textSec : T.textMuted}
              strokeWidth={t % 50 === 0 ? 1.5 : 0.75}
            />
          );
        })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="3.5" fill="#ffffff" stroke={color} strokeWidth="1.5" />
        <text x={cx} y={cy - 16} textAnchor="middle" fontSize="20" fontWeight="700" fill={color} fontFamily={T.mono}>{score}</text>
        <text x={cx} y={cy - 5} textAnchor="middle" fontSize="7" fill={T.textMuted} fontFamily={T.mono} letterSpacing="0.1em">/ 100</text>
      </svg>
      <Badge color={color}>{label} Impact</Badge>
    </div>
  );
}

function WindRose({ deg, speed }: { deg: number; speed: number }) {
  const cx = 42, cy = 42, R = 30;
  const rad = ((deg - 90) * Math.PI) / 180;
  const nx = cx + R * Math.cos(rad);
  const ny = cy + R * Math.sin(rad);
  const tx = cx - R * 0.45 * Math.cos(rad);
  const ty = cy - R * 0.45 * Math.sin(rad);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <svg width={84} height={84} viewBox="0 0 84 84">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={T.border} strokeWidth="1" />
        <circle cx={cx} cy={cy} r={R * 0.55} fill="none" stroke={T.borderSub} strokeWidth="0.5" strokeDasharray="2 3" />
        <line x1={cx} y1={cy - R - 5} x2={cx} y2={cy + R + 5} stroke={T.border} strokeWidth="0.75" />
        <line x1={cx - R - 5} y1={cy} x2={cx + R + 5} y2={cy} stroke={T.border} strokeWidth="0.75" />
        {(['N', cx, cy - R - 7] as const) && (
          [['N', cx, cy - R - 7], ['S', cx, cy + R + 11], ['E', cx + R + 10, cy + 3.5], ['W', cx - R - 10, cy + 3.5]].map(([d, x, y]) => (
            <text key={d} x={x} y={y} textAnchor="middle" fontSize="7" fill={T.textMuted} fontFamily={T.mono} fontWeight="600">{d}</text>
          ))
        )}
        <line x1={tx} y1={ty} x2={nx} y2={ny} stroke={T.amber} strokeWidth="2" strokeLinecap="round" />
        <circle cx={nx} cy={ny} r="3.5" fill={T.amber} />
        <circle cx={cx} cy={cy} r="2.5" fill="#ffffff" stroke={T.textSec} strokeWidth="1" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ fontFamily: T.mono, fontSize: 24, fontWeight: 700, color: T.textPrimary, lineHeight: 1 }}>
          {speed}<span style={{ fontSize: 12, color: T.textSec, marginLeft: 3, fontWeight: 400 }}>m/s</span>
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, letterSpacing: '0.08em' }}>
          WIND · {windDirLabel(deg)} · {deg}°
        </div>
      </div>
    </div>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
const DodocoFireReport = ({ fire, species, weather }: Props) => {
  const reportRef = useRef<HTMLDivElement>(null);
  const generatedAt = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' });
  const severity = severityLabel(fire.biodiversityScore);
  const threatened = species.filter(s => ['CR', 'EN', 'VU'].includes(s.iucnStatus));
  const endemics = species.filter(s => s.isEndemic);
  const intColor = INTENSITY_COLORS[fire.intensity] || INTENSITY_COLORS.medium;

  const scoreComponents = [
    { factor: 'Species Richness (30%)', value: Math.round(Math.min(species.length / 30, 1) * 30), max: 30 },
    { factor: 'Threat Ratio (25%)',     value: Math.round((threatened.length / Math.max(species.length, 1)) * 25), max: 25 },
    { factor: 'Fire Intensity (20%)',   value: Math.round(Math.min(fire.frp / 1200, 1) * 20), max: 20 },
    { factor: 'Endemic Species (15%)',  value: endemics.length > 0 ? 15 : 0, max: 15 },
    { factor: 'Protected Area (10%)',   value: 0, max: 10 },
  ];

  return (
    <div className="dfr" style={{ background: T.bg, minHeight: '100vh', padding: '20px 16px' }}>
      <style>{GLOBAL_CSS}</style>

      <div ref={reportRef} style={{ maxWidth: 930, margin: '0 auto' }}>

        {/* ── CLASSIFICATION STRIP ──────────────────────────────────────── */}
        <div style={{
          background: T.red + '16',
          border: `1px solid ${T.red}30`,
          borderBottom: 'none',
          borderRadius: '5px 5px 0 0',
          padding: '5px 18px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, color: T.red, letterSpacing: '0.2em' }}>
            ▲ OFFICIAL USE — VERIFY ALL DATA BEFORE FIELD DEPLOYMENT
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.12em' }}>
            DODOCO / WILDFIRE INTELLIGENCE PLATFORM
          </span>
        </div>

        {/* ── COMMAND HEADER ────────────────────────────────────────────── */}
        <div className="dfr-scanlines" style={{
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderTop: `2px solid ${intColor}`,
          borderBottom: `1px solid ${T.border}`,
          padding: '24px 28px 20px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}>
                <Badge color={intColor} dot>{fire.intensity} intensity</Badge>
                <MetaTag>{fire.biome}</MetaTag>
                <MetaTag>{fire.country}</MetaTag>
                <MetaTag>Duration: {fire.duration}h</MetaTag>
              </div>
              <div style={{
                fontFamily: T.heading, fontSize: 30, fontWeight: 800,
                color: T.textPrimary, lineHeight: 1.1, letterSpacing: '0.01em',
                marginBottom: 12,
              }}>
                {fire.countryFlag}&nbsp; {fire.name}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px' }}>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textSec }}>
                  {fire.coordinates[0].toFixed(4)}°N, {fire.coordinates[1].toFixed(4)}°E
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                  DETECTED {formatDate(fire.startTime)}
                </span>
              </div>
            </div>
            <div style={{
              background: T.bg, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: '18px 22px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            }}>
              <ScoreGauge score={fire.biodiversityScore} />
              <span style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
                Biodiversity Impact Score
              </span>
            </div>
          </div>

          <div style={{
            marginTop: 16, paddingTop: 14,
            borderTop: `1px solid ${T.borderSub}`,
            display: 'flex', flexWrap: 'wrap', gap: '6px 28px',
          }}>
            {[
              ['REPORT ID',  fire.id.toUpperCase()],
              ['SATELLITE',  'VIIRS SNPP NRT'],
              ['SPECIES DB', 'GBIF + IUCN v3'],
              ['GENERATED',  generatedAt],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.14em' }}>{k}</span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textSec }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── BODY ──────────────────────────────────────────────────────── */}
        <div style={{
          background: T.bg,
          border: `1px solid ${T.border}`,
          borderTop: 'none',
          borderRadius: '0 0 5px 5px',
          padding: '28px',
        }}>

          {/* §01 · FIRE STATISTICS */}
          <section style={{ marginBottom: 30 }}>
            <SectionHeader number="01" title="Fire Statistics at a Glance" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
              <StatCard icon="🔥" value={`${fire.frp.toLocaleString()}`}                label="FRP (MW)"         sub="Satellite-measured thermal output" accent={intColor} />
              <StatCard icon="⬛" value={`${fire.areaBurned.toLocaleString()}`}          label="Area Burned (ha)"  sub="~375m² per VIIRS pixel" accent={T.orange} />
              <StatCard icon="☁️" value={`${(fire.carbonReleased/1000).toFixed(0)}K`}    label="Carbon (tC)"       sub={`~${fire.recoveryYears} yr ecosystem recovery`} accent={T.yellow} />
              <StatCard icon="⏱" value={`${fire.duration}h`}                            label="Active Duration"   sub={`Trend: ↑${fire.trendPercent}% last 24h`} accent={T.blue} />
              <StatCard icon="💨" value={`${weather.windSpeed}`}                         label="Wind (m/s)"        sub={`Dir: ${windDirLabel(weather.windDeg)} · ${weather.windDeg}°`} accent={T.purple} />
              <StatCard icon="🌡" value={`${weather.temperature}°C`}                    label="Surface Temp"      sub={`Humidity: ${weather.humidity}% · ${weather.humidity < 30 ? 'Extreme dryness' : 'Dry conditions'}`} accent={T.red} />
            </div>
          </section>

          <HRule />

          {/* §02 · AI SUMMARY */}
          <section style={{ marginBottom: 30 }}>
            <SectionHeader number="02" title="AI Fire Intelligence Summary" />
            <div style={{
              background: T.surface,
              border: `1px solid ${T.border}`,
              borderLeft: `3px solid ${T.blue}`,
              borderRadius: 5, padding: '18px 20px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, color: T.blue, letterSpacing: '0.18em' }}>
                  ◈ GEMINI AI-POWERED ANALYSIS
                </span>
                <div style={{ flex: 1, height: 1, background: T.borderSub }} />
              </div>
              <p style={{
                fontFamily: T.sans, fontSize: 13, lineHeight: 1.85,
                color: T.textSec, fontWeight: 300, fontStyle: 'italic',
              }}>
                {fire.aiSummary}
              </p>
            </div>
          </section>

          <HRule />

          {/* §03 · BIODIVERSITY IMPACT */}
          <section style={{ marginBottom: 30 }}>
            <SectionHeader number="03" title="Biodiversity Impact Assessment" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div>
                <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.16em', marginBottom: 12 }}>
                  SPECIES AT RISK — ~50KM BURN ZONE RADIUS
                </div>
                <IUCNBar species={species} />
                <div>
                  {species.map((sp, i) => (
                    <div key={i} className="dfr-card" style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 12px',
                      background: i % 2 === 0 ? T.surface : 'transparent',
                      borderBottom: `1px solid ${T.borderSub}`,
                      transition: 'background .12s',
                    }}>
                      <div>
                        <div style={{ fontFamily: T.sans, fontWeight: 600, fontSize: 12, color: T.textPrimary }}>{sp.commonName}</div>
                        <div style={{ fontFamily: T.sans, fontStyle: 'italic', fontSize: 10, color: T.textMuted, marginTop: 1 }}>{sp.scientificName}</div>
                        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textMuted, marginTop: 2 }}>
                          {sp.population}{sp.isEndemic ? ' · ENDEMIC' : ''}
                        </div>
                      </div>
                      <Badge color={IUCN_COLORS[sp.iucnStatus]}>{sp.iucnStatus}</Badge>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div>
                  <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.16em', marginBottom: 14 }}>
                    IMPACT METRICS
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                    <ProgressRow label="Total Species Detected"       value={species.length}    max={30}              color={T.green} />
                    <ProgressRow label="Threatened (VU / EN / CR)"    value={threatened.length} max={species.length}  color={T.red} />
                    <ProgressRow label="Endemic Species"              value={endemics.length}   max={species.length}  color={T.purple} />
                  </div>
                </div>

                <div style={{
                  background: T.surface, border: `1px solid ${T.border}`,
                  borderRadius: 5, padding: '14px 16px',
                }}>
                  <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.16em', marginBottom: 14 }}>
                    BIODIVERSITY SCORE COMPONENTS
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                    {scoreComponents.map(({ factor, value, max }) => (
                      <div key={factor}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                          <span style={{ fontFamily: T.sans, fontSize: 11, color: T.textSec }}>{factor}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.amber, fontWeight: 700 }}>{value}/{max}</span>
                        </div>
                        <div style={{ height: 2, background: T.borderSub, borderRadius: 1, overflow: 'hidden' }}>
                          <div className="dfr-animbar" style={{
                            ['--bw' as string]: `${(value / max) * 100}%`,
                            width: `${(value / max) * 100}%`,
                            height: '100%', background: T.amber, borderRadius: 1,
                          }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{
                    borderTop: `1px solid ${T.border}`, marginTop: 14, paddingTop: 12,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <span style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.14em' }}>COMPOSITE SCORE</span>
                    <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color: severity.color }}>
                      {fire.biodiversityScore}<span style={{ fontSize: 12, color: T.textMuted, fontWeight: 400 }}>/100</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <HRule />

          {/* §04 · METEOROLOGICAL */}
          <section style={{ marginBottom: 30 }}>
            <SectionHeader number="04" title="Meteorological Conditions & Spread Risk" />
            <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 16 }}>
              <div style={{
                background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 5, padding: '18px 16px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18,
              }}>
                <WindRose deg={weather.windDeg} speed={weather.windSpeed} />
                <div style={{
                  width: '100%', display: 'flex', justifyContent: 'space-around',
                  paddingTop: 14, borderTop: `1px solid ${T.borderSub}`,
                }}>
                  {[['TEMP', `${weather.temperature}°C`, T.red], ['HUMID', `${weather.humidity}%`, T.blue]].map(([k, v, c]) => (
                    <div key={k} style={{ textAlign: 'center' }}>
                      <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.12em' }}>{k}</div>
                      <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: c, marginTop: 3 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  {
                    risk: 'Spread Velocity',
                    level: weather.windSpeed > 30 ? 'High' : weather.windSpeed > 15 ? 'Moderate' : 'Low',
                    color: weather.windSpeed > 30 ? T.red : weather.windSpeed > 15 ? T.orange : T.green,
                    detail: `Wind at ${weather.windSpeed} m/s from ${windDirLabel(weather.windDeg)} can drive fire spread of ~${Math.round(weather.windSpeed * 0.6 * 10) / 10} km/h in open terrain.`,
                  },
                  {
                    risk: 'Containment Difficulty',
                    level: fire.intensity === 'extreme' ? 'Very High' : fire.intensity === 'high' ? 'High' : 'Moderate',
                    color: intColor,
                    detail: `FRP of ${fire.frp} MW indicates ${fire.intensity} thermal output. ${fire.biome} biomes with dry season conditions significantly impede containment.`,
                  },
                  {
                    risk: 'Carbon Feedback Risk',
                    level: fire.carbonReleased > 200000 ? 'Critical' : fire.carbonReleased > 50000 ? 'High' : 'Moderate',
                    color: fire.carbonReleased > 200000 ? T.red : T.orange,
                    detail: `~${(fire.carbonReleased / 1000).toFixed(0)}K tonnes of carbon released. Carbon sequestration recovery: ~${fire.recoveryYears} years.`,
                  },
                  {
                    risk: 'Secondary Displacement Risk',
                    level: threatened.length >= 3 ? 'High' : threatened.length >= 1 ? 'Moderate' : 'Low',
                    color: threatened.length >= 3 ? T.red : threatened.length >= 1 ? T.orange : T.green,
                    detail: `${threatened.length} threatened species in burn zone. Fire-driven displacement increases human-wildlife conflict probability.`,
                  },
                ].map(({ risk, level, color, detail }) => (
                  <div key={risk} className="dfr-card" style={{
                    padding: '12px 14px',
                    background: T.surface,
                    border: `1px solid ${T.border}`,
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 5, transition: 'background .12s',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontFamily: T.sans, fontWeight: 600, fontSize: 12, color: T.textPrimary }}>{risk}</span>
                      <Badge color={color}>{level}</Badge>
                    </div>
                    <p style={{ fontFamily: T.sans, fontSize: 11, color: T.textSec, lineHeight: 1.65, fontWeight: 300 }}>{detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <HRule />

          {/* §05 · SDG ALIGNMENT */}
          <section style={{ marginBottom: 30 }}>
            <SectionHeader number="05" title="UN Sustainable Development Goals — Fire Impact Alignment" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(208px, 1fr))', gap: 10 }}>
              {[
                { num: 15, name: 'Life on Land',       color: '#22c55e', impact: 'Direct',   detail: `${species.length} species habitats threatened within burn zone.` },
                { num: 13, name: 'Climate Action',     color: '#16a34a', impact: 'Direct',   detail: `${(fire.carbonReleased/1000).toFixed(0)}K tonnes CO₂-eq released into atmosphere.` },
                { num:  3, name: 'Good Health',        color: '#4ade80', impact: 'Indirect', detail: 'Wildfire smoke produces PM2.5; affects air quality in surrounding settlements.' },
                { num: 11, name: 'Sustainable Cities', color: '#f97316', impact: 'Indirect', detail: 'Displacement of wildlife increases urban-fringe risk to nearby communities.' },
              ].map(({ num, name, color, impact, detail }) => (
                <div key={num} style={{
                  background: T.surface, border: `1px solid ${T.border}`,
                  borderRadius: 5, overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '9px 12px', borderBottom: `1px solid ${T.border}`,
                    background: color + '0f',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: 3,
                      background: color + '20', border: `1px solid ${color}38`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: T.mono, fontSize: 11, fontWeight: 800, color,
                    }}>{num}</div>
                    <span style={{ fontFamily: T.sans, fontSize: 11, fontWeight: 600, color: T.textPrimary, flex: 1 }}>{name}</span>
                    <Badge color={color}>{impact}</Badge>
                  </div>
                  <div style={{ padding: '10px 12px', fontFamily: T.sans, fontSize: 11, color: T.textSec, lineHeight: 1.65, fontWeight: 300 }}>{detail}</div>
                </div>
              ))}
            </div>
          </section>

          <HRule />

          {/* §06 · FSI CLASSIFICATION */}
          <section style={{ marginBottom: 30 }}>
            <SectionHeader number="06" title="Fire Proneness Classification (FSI Framework)" />
            <div style={{
              background: T.surface, border: `1px solid ${T.border}`,
              borderLeft: `3px solid ${T.yellow}`,
              borderRadius: 5, padding: '11px 16px', marginBottom: 14,
            }}>
              <p style={{ fontFamily: T.sans, fontSize: 11, color: T.textSec, lineHeight: 1.65, fontWeight: 300 }}>
                Based on the <em>Forest Survey of India Technical Information Series (Vol I, No.1, 2019)</em> framework.
                Classification uses annual fire frequency per 5km × 5km grid cell.
              </p>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    {['Fire Prone Class', 'Avg Annual Freq', '13-Year FFP Count', 'Code', 'This Zone'].map(h => (
                      <th key={h} style={{
                        padding: '9px 12px', textAlign: 'left',
                        fontFamily: T.mono, fontSize: 8, fontWeight: 700,
                        color: T.textMuted, letterSpacing: '0.14em', textTransform: 'uppercase',
                        borderBottom: `2px solid ${T.border}`, background: T.bg,
                        whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Extremely Fire Prone',   '≥ 4 / year',         '≥ 52 detections',  T.red,    fire.frp >= 500],
                      ['Highly Fire Prone',      '≥ 2 and < 4 / year', '26–52 detections', T.orange, fire.frp >= 200 && fire.frp < 500],
                      ['Fire Prone',             '≥ 1 and < 2 / year', '13–26 detections', T.yellow, fire.frp >= 80  && fire.frp < 200],
                      ['Moderately Fire Prone',  '≥ 0.5 and < 1 / yr', '6–13 detections',  T.purple, false],
                      ['Less Fire Prone',        '< 0.5 / year',       '< 6 detections',   T.green,  false],
                    ] as [string, string, string, string, boolean][]
                  ).map(([cls, freq, count, color, active]) => (
                    <tr key={cls} className={`dfr-row${active ? ' dfr-activerow' : ''}`}
                      style={{ borderBottom: `1px solid ${T.borderSub}` }}>
                      <td style={{ padding: '10px 12px', fontFamily: T.sans, fontWeight: active ? 600 : 400, fontSize: 12, color: active ? color : T.textSec }}>{cls}</td>
                      <td style={{ padding: '10px 12px', fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{freq}</td>
                      <td style={{ padding: '10px 12px', fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{count}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {active
                          ? <Badge color={color} dot>▶ THIS ZONE</Badge>
                          : <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <HRule />

          {/* §07 · RECOMMENDATIONS */}
          <section style={{ marginBottom: 28 }}>
            <SectionHeader number="07" title="Immediate Response Recommendations" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(264px, 1fr))', gap: 10 }}>
              {[
                { priority: 'CRITICAL', icon: '🚨', title: 'Ground Response Deployment',     desc: `FRP of ${fire.frp} MW requires immediate firefighting resource deployment. Wind direction ${windDirLabel(weather.windDeg)} — position resources on leeward side.`, color: T.red },
                { priority: 'HIGH',     icon: '🦁', title: 'Wildlife Rescue Operations',     desc: `${threatened.length} threatened species in burn zone. Coordinate with forest department for emergency corridors and rescue camps.`, color: T.orange },
                { priority: 'HIGH',     icon: '🌬', title: 'Air Quality Monitoring',         desc: 'Activate PM2.5 monitoring stations within 100km radius. Issue health advisories for communities in smoke plume path.', color: T.orange },
                { priority: 'MEDIUM',   icon: '📡', title: 'Satellite Watch Escalation',     desc: 'Increase VIIRS SNPP monitoring frequency. Request MODIS thermal anomaly cross-validation for affected grid cells.', color: T.yellow },
                { priority: 'MEDIUM',   icon: '🌱', title: 'Post-Fire Restoration Planning', desc: `Initiate ${fire.biome} restoration plan. Recovery timeline: ~${fire.recoveryYears} years without intervention. Identify native seed species.`, color: T.green },
                { priority: 'LOW',      icon: '📊', title: 'Damage Assessment Survey',       desc: 'Commission aerial/drone survey within 72h of containment. Document species displacement and habitat fragmentation extent.', color: T.blue },
              ].map(({ priority, icon, title, desc, color }) => (
                <div key={title} className="dfr-card" style={{
                  background: T.surface, border: `1px solid ${T.border}`,
                  borderLeft: `3px solid ${color}`, borderRadius: 5,
                  padding: '13px 15px', transition: 'background .12s',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                    <span style={{ fontSize: 14 }}>{icon}</span>
                    <span style={{ fontFamily: T.sans, fontWeight: 600, fontSize: 12, color: T.textPrimary, flex: 1 }}>{title}</span>
                    <Badge color={color}>{priority}</Badge>
                  </div>
                  <p style={{ fontFamily: T.sans, fontSize: 11, color: T.textSec, lineHeight: 1.65, fontWeight: 300 }}>{desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── FOOTER */}
          <div style={{
            borderTop: `1px solid ${T.border}`, paddingTop: 18,
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'flex-end', flexWrap: 'wrap', gap: 12,
          }}>
            <div>
              <div style={{
                fontFamily: T.heading, fontSize: 14, fontWeight: 800,
                color: T.textSec, letterSpacing: '0.1em', marginBottom: 6,
              }}>
                🌿 DODOCO · WILDFIRE INTELLIGENCE PLATFORM
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, lineHeight: 1.9, letterSpacing: '0.06em' }}>
                DATA: NASA FIRMS VIIRS SNPP · GBIF BIODIVERSITY DATABASE · IUCN RED LIST API v3 · OPENWEATHERMAP
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, letterSpacing: '0.06em' }}>
                METHODOLOGY REF: FSI TECHNICAL INFORMATION SERIES VOL. I NO. 1 (2019) · UN SDG FRAMEWORK
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted }}>REPORT ID: {fire.id.toUpperCase()}</div>
              <div style={{ fontFamily: T.mono, fontSize: 8, color: T.textMuted, marginTop: 2 }}>GENERATED: {generatedAt}</div>
              <div style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, color: T.red, marginTop: 6, letterSpacing: '0.1em' }}>
                ▲ OFFICIAL USE ONLY — VERIFY ALL DATA BEFORE FIELD DEPLOYMENT
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};

export default DodocoFireReport;
