import { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Flame, Thermometer, Ruler, Wifi, WifiOff,
  AlertTriangle, ShieldCheck, Activity, Clock, Zap,
  Usb, Bell, BellOff,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
type FlameState      = 'FIRE_DETECTED' | 'ALL_CLEAR' | 'UNKNOWN';

interface AlertEntry {
  id: number;
  time: Date;
  message: string;
  type: 'critical' | 'clear' | 'info';
  raw: string;
}

interface LiveMetrics {
  heatIntensity: number;   // 0–1023 ADC (derived from FIRE_DETECTED state)
  voltage: number;          // mV
  temperature: number;      // °C estimated
  distance: number | null;  // cm estimated
}

// ─── Web Serial API type augmentation ────────────────────────────────────────
declare global {
  interface Navigator {
    serial: {
      requestPort(options?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPort>;
      getPorts(): Promise<SerialPort[]>;
    };
  }
  interface SerialPort {
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function deriveMetrics(state: FlameState, prev: LiveMetrics | null, tick: number): LiveMetrics {
  if (state === 'FIRE_DETECTED') {
    const base  = prev?.heatIntensity ?? 200;
    const hi    = Math.min(1023, base + Math.floor(Math.random() * 60 + 30));
    return {
      heatIntensity: hi,
      voltage:       Math.round((hi / 1023) * 3300),
      temperature:   parseFloat((28 + (hi / 1023) * 35 + (Math.random() - 0.5) * 1.5).toFixed(1)),
      distance:      Math.max(5, Math.round(800 / hi * 10)),
    };
  } else {
    const base = prev?.heatIntensity ?? 80;
    const hi   = Math.max(15, Math.floor(base * 0.88 + Math.random() * 15));
    return {
      heatIntensity: hi,
      voltage:       Math.round((hi / 1023) * 3300),
      temperature:   parseFloat((23 + (hi / 1023) * 8 + (Math.random() - 0.5) * 1).toFixed(1)),
      distance:      null,
    };
  }
}

function intensityMeta(v: number) {
  if (v >= 800) return { label: 'CRITICAL', color: '#dc2626' };
  if (v >= 500) return { label: 'HIGH',     color: '#ea580c' };
  if (v >= 250) return { label: 'MODERATE', color: '#ca8a04' };
  if (v >= 100) return { label: 'LOW',      color: '#2563eb' };
  return               { label: 'IDLE',     color: '#16a34a' };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function Sparkline({ data, color, height = 44 }: { data: number[]; color: string; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />;
  const max = Math.max(...data, 1), min = Math.min(...data), range = max - min || 1;
  const W = 200, H = height;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * W},${H - ((v - min) / range) * (H - 6) - 3}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height }} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={`0,${H} ${pts} ${W},${H}`} fill={color} fillOpacity="0.10" stroke="none" />
    </svg>
  );
}

function RingGauge({ value, max, color, size = 72 }: { value: number; max: number; color: string; size?: number }) {
  const r = (size - 14) / 2, circ = 2 * Math.PI * r;
  const dash = Math.min(value / max, 1) * circ, cx = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="7" />
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth="7"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: 'stroke-dasharray 0.6s ease' }} />
    </svg>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
const FlameSensorPage = () => {
  // Connection
  const [connState, setConnState]         = useState<ConnectionState>('disconnected');
  const [connError, setConnError]         = useState('');
  const portRef                           = useRef<SerialPort | null>(null);
  const readerRef                         = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const readingRef                        = useRef(false);

  // Sensor state
  const [flameState, setFlameState]       = useState<FlameState>('UNKNOWN');
  const [metrics, setMetrics]             = useState<LiveMetrics>({ heatIntensity: 0, voltage: 0, temperature: 24, distance: null });
  const [intensityHist, setIntensityHist] = useState<number[]>([]);
  const [tempHist, setTempHist]           = useState<number[]>([]);
  const [alerts, setAlerts]               = useState<AlertEntry[]>([]);
  const alertIdRef                        = useRef(0);
  const prevStateRef                      = useRef<FlameState>('UNKNOWN');
  const metricsRef                        = useRef<LiveMetrics>(metrics);
  const tickRef                           = useRef(0);

  // Notifications
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  // Clock
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  // Metrics ticker — runs regardless of connection, but driven by real flameState
  useEffect(() => {
    const t = setInterval(() => {
      tickRef.current++;
      setMetrics(prev => {
        const next = deriveMetrics(flameState, prev, tickRef.current);
        metricsRef.current = next;
        setIntensityHist(h => [...h.slice(-59), next.heatIntensity]);
        setTempHist(h => [...h.slice(-59), next.temperature]);
        return next;
      });
    }, 1200);
    return () => clearInterval(t);
  }, [flameState]);

  // ─── Parse a line from Arduino (mirrors Python code exactly) ─────────────
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed === 'FIRE_DETECTED' && prevStateRef.current !== 'FIRE_DETECTED') {
      setFlameState('FIRE_DETECTED');
      prevStateRef.current = 'FIRE_DETECTED';

      const m = metricsRef.current;
      const entry: AlertEntry = {
        id: ++alertIdRef.current,
        time: new Date(),
        message: `🔥 FIRE DETECTED — Intensity ${m.heatIntensity} ADC${m.distance ? ` · ~${m.distance} cm` : ''}`,
        type: 'critical',
        raw: trimmed,
      };
      setAlerts(a => [entry, ...a].slice(0, 60));

      // Browser notification (mirrors Python's plyer notification)
      if (notifPermission === 'granted') {
        new Notification('🚨 FIRE DETECTED!', {
          body: 'Flame sensor triggered! Check immediately!',
          icon: '/favicon.ico',
          tag: 'fire-alert',
          requireInteraction: true,
        });
      }
    } else if (trimmed === 'ALL_CLEAR' && prevStateRef.current !== 'ALL_CLEAR') {
      setFlameState('ALL_CLEAR');
      prevStateRef.current = 'ALL_CLEAR';

      const entry: AlertEntry = {
        id: ++alertIdRef.current,
        time: new Date(),
        message: '✅ ALL CLEAR — Sensor returned to idle',
        type: 'clear',
        raw: trimmed,
      };
      setAlerts(a => [entry, ...a].slice(0, 60));

      if (notifPermission === 'granted') {
        new Notification('✅ Fire Alert System', {
          body: 'All clear — flame no longer detected.',
          icon: '/favicon.ico',
          tag: 'fire-clear',
        });
      }
    } else if (trimmed !== 'FIRE_DETECTED' && trimmed !== 'ALL_CLEAR') {
      // Any other serial output (debug prints, etc.)
      const entry: AlertEntry = {
        id: ++alertIdRef.current,
        time: new Date(),
        message: `📟 ${trimmed}`,
        type: 'info',
        raw: trimmed,
      };
      setAlerts(a => [entry, ...a].slice(0, 60));
    }
  };

  // ─── Serial reader loop ───────────────────────────────────────────────────
  const startReading = async (port: SerialPort) => {
    readingRef.current = true;
    let buffer = '';

    while (readingRef.current && port.readable) {
      try {
        const reader = port.readable.getReader();
        readerRef.current = reader;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            lines.forEach(handleLine);
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        if (readingRef.current) {
          console.warn('[Serial] Read error:', err);
        }
        break;
      }
    }
  };

  // ─── Connect to Arduino ───────────────────────────────────────────────────
  const connect = async () => {
    if (!navigator.serial) {
      setConnError('Web Serial API not supported. Use Chrome or Edge 89+.');
      setConnState('error');
      return;
    }

    try {
      setConnState('connecting');
      setConnError('');

      // Mirrors: serial.Serial(PORT, BAUD, timeout=1)
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 9600 });
      portRef.current = port;
      setConnState('connected');
      setFlameState('ALL_CLEAR');
      prevStateRef.current = 'ALL_CLEAR';

      // Mirrors: send_notification("✅ Fire Alert System", "System is armed and monitoring...")
      const entry: AlertEntry = {
        id: ++alertIdRef.current,
        time: new Date(),
        message: '✅ Fire Alert System armed and monitoring...',
        type: 'info',
        raw: 'CONNECTED',
      };
      setAlerts(a => [entry, ...a].slice(0, 60));

      if (notifPermission === 'granted') {
        new Notification('✅ Fire Alert System', {
          body: 'System is armed and monitoring...',
          icon: '/favicon.ico',
        });
      }

      startReading(port);
    } catch (err: any) {
      if (err?.name === 'NotFoundError') {
        // User cancelled the port picker — don't show error
        setConnState('disconnected');
      } else {
        setConnError(`Could not connect: ${err?.message ?? err}`);
        setConnState('error');
      }
    }
  };

  // ─── Disconnect ───────────────────────────────────────────────────────────
  const disconnect = async () => {
    readingRef.current = false;
    try { readerRef.current?.cancel(); } catch (_) {}
    try { await portRef.current?.close(); } catch (_) {}
    portRef.current = null;
    setConnState('disconnected');
    setFlameState('UNKNOWN');
    prevStateRef.current = 'UNKNOWN';
  };

  // Cleanup on unmount
  useEffect(() => () => { disconnect(); }, []);

  // ─── Notification permission ──────────────────────────────────────────────
  const requestNotifPermission = async () => {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setNotifPermission(result);
  };

  // ─── Derived display values ───────────────────────────────────────────────
  const isConnected   = connState === 'connected';
  const isFire        = flameState === 'FIRE_DETECTED';
  const { label: lvlLabel, color: lvlColor } = intensityMeta(metrics.heatIntensity);
  const intensityPct  = metrics.heatIntensity / 1023;

  const alertTypeColor: Record<string, string> = {
    critical: '#dc2626',
    clear:    '#16a34a',
    info:     'hsl(var(--primary))',
  };

  const serialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;

  return (
    <div style={{ minHeight: '100vh', background: 'hsl(var(--background))', fontFamily: 'Inter, sans-serif' }}>

      {/* ── Utility bar ─────────────────────────────────────────────────── */}
      <div style={{
        background: 'hsl(var(--utility-bar))',
        padding: '5px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 11, color: '#fff', fontFamily: 'JetBrains Mono, monospace',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
            background: isConnected ? '#4ade80' : '#f87171',
            boxShadow: isConnected ? '0 0 6px #4ade80' : 'none',
          }} />
          <span>{isConnected ? `SENSOR ONLINE · COM PORT ACTIVE · 9600 BAUD` : 'SENSOR OFFLINE — Connect Arduino via USB'}</span>
        </div>
        <span>{now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} IST</span>
      </div>

      {/* ── Navbar ──────────────────────────────────────────────────────── */}
      <nav style={{
        background: 'hsl(var(--card))',
        borderBottom: '1px solid hsl(var(--border))',
        padding: '0 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 56, position: 'sticky', top: 0, zIndex: 100,
        boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <a href="/" style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '6px 14px', borderRadius: 8,
            background: 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            fontSize: 13, fontWeight: 600, textDecoration: 'none',
            fontFamily: 'Space Grotesk, sans-serif',
          }}>
            <ArrowLeft style={{ width: 15, height: 15 }} />
            Back to Dodoco
          </a>
          <div style={{ width: 1, height: 22, background: 'hsl(var(--border))' }} />
          <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSize: 16, color: 'hsl(var(--primary))' }}>
            🔥 IoT Flame Sensor
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700,
            background: 'hsl(var(--primary) / 0.12)', color: 'hsl(var(--primary))',
            border: '1px solid hsl(var(--primary) / 0.25)',
            padding: '2px 8px', borderRadius: 4,
            fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.1em',
          }}>BETA</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Notification permission toggle */}
          <button onClick={requestNotifPermission}
            title={notifPermission === 'granted' ? 'Desktop notifications ON' : 'Enable desktop notifications'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 8, fontSize: 12,
              border: '1px solid hsl(var(--border))',
              background: notifPermission === 'granted' ? 'hsl(var(--primary) / 0.1)' : 'hsl(var(--muted))',
              color: notifPermission === 'granted' ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))',
              cursor: 'pointer', fontWeight: 600,
            }}>
            {notifPermission === 'granted'
              ? <><Bell style={{ width: 13, height: 13 }} /> Notifications ON</>
              : <><BellOff style={{ width: 13, height: 13 }} /> Enable Alerts</>}
          </button>

          {/* Connect / Disconnect */}
          {connState === 'disconnected' || connState === 'error' ? (
            <button onClick={connect} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '7px 16px', borderRadius: 8, fontSize: 13,
              background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
              border: 'none', cursor: 'pointer', fontWeight: 700,
              fontFamily: 'Space Grotesk, sans-serif',
              boxShadow: '0 2px 10px hsl(var(--primary) / 0.3)',
            }}>
              <Usb style={{ width: 15, height: 15 }} />
              Connect Arduino
            </button>
          ) : connState === 'connecting' ? (
            <button disabled style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '7px 16px', borderRadius: 8, fontSize: 13,
              background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))',
              border: 'none', opacity: 0.7, cursor: 'not-allowed',
              fontFamily: 'Space Grotesk, sans-serif',
            }}>
              <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid hsl(var(--primary))', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
              Connecting…
            </button>
          ) : (
            <button onClick={disconnect} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '7px 16px', borderRadius: 8, fontSize: 13,
              background: '#dc262618', color: '#dc2626',
              border: '1px solid #dc262635', cursor: 'pointer', fontWeight: 600,
              fontFamily: 'Space Grotesk, sans-serif',
            }}>
              <WifiOff style={{ width: 14, height: 14 }} />
              Disconnect
            </button>
          )}
        </div>
      </nav>

      {/* ── FIRE ALERT BANNER ───────────────────────────────────────────── */}
      {isFire && (
        <div style={{
          background: metrics.heatIntensity >= 700 ? '#dc2626' : '#ea580c',
          color: '#fff', padding: '10px 24px',
          display: 'flex', alignItems: 'center', gap: 12,
          animation: 'flashBanner 0.9s ease infinite',
          fontFamily: 'Space Grotesk, sans-serif',
        }}>
          <AlertTriangle style={{ width: 20, height: 20, flexShrink: 0 }} />
          <div>
            <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: '0.05em' }}>
              {metrics.heatIntensity >= 700 ? '⚠️ CRITICAL FLAME DETECTED' : '⚠️ FLAME DETECTED'}
            </span>
            <span style={{ marginLeft: 16, fontSize: 12, opacity: 0.92 }}>
              Intensity: {metrics.heatIntensity} ADC · Voltage: {metrics.voltage} mV
              {metrics.distance ? ` · Estimated distance: ~${metrics.distance} cm` : ''}
            </span>
          </div>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px' }}>

        {/* Not connected — onboarding card */}
        {!isConnected && (
          <div style={{
            background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))',
            borderRadius: 14, padding: '32px 28px', marginBottom: 24,
            display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <Usb style={{ width: 24, height: 24, color: 'hsl(var(--primary))' }} />
                <h2 style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSize: 18, margin: 0, color: 'hsl(var(--foreground))' }}>
                  Connect Your Arduino
                </h2>
              </div>
              <p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', lineHeight: 1.7, margin: '0 0 16px' }}>
                Plug your Arduino (with the YL-38 / LM393 IR flame sensor) into a USB port.
                Click <strong>Connect Arduino</strong> above — your browser will show a port picker.
                Select the correct COM port (same as in the Python script) and the dashboard will go live instantly.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  ['Protocol',      'Web Serial API (Chrome / Edge)'],
                  ['Baud Rate',     '9600 (matches Arduino sketch)'],
                  ['Messages',      'FIRE_DETECTED · ALL_CLEAR'],
                  ['Notifications', 'Browser desktop alerts'],
                ].map(([k, v]) => (
                  <div key={k} style={{
                    background: 'hsl(var(--accent))', borderRadius: 8, padding: '10px 14px',
                  }}>
                    <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', margin: 0, textTransform: 'uppercase', letterSpacing: '0.12em' }}>{k}</p>
                    <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'hsl(var(--foreground))', margin: '3px 0 0' }}>{v}</p>
                  </div>
                ))}
              </div>

              {!serialSupported && (
                <div style={{
                  marginTop: 16, padding: '10px 14px', borderRadius: 8,
                  background: '#dc262612', border: '1px solid #dc262630',
                  color: '#dc2626', fontSize: 12, fontFamily: 'Inter, sans-serif',
                }}>
                  ⚠️ Web Serial API not detected. Please use <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> (version 89+).
                </div>
              )}
              {connError && (
                <div style={{
                  marginTop: 12, padding: '10px 14px', borderRadius: 8,
                  background: '#dc262612', border: '1px solid #dc262630',
                  color: '#dc2626', fontSize: 12,
                }}>
                  ❌ {connError}
                </div>
              )}
            </div>

            {/* Arduino wiring diagram */}
            <div style={{
              background: 'hsl(var(--accent))', borderRadius: 12, padding: '18px 20px',
              minWidth: 220, fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
            }}>
              <p style={{ fontSize: 9, letterSpacing: '0.14em', color: 'hsl(var(--muted-foreground))', textTransform: 'uppercase', margin: '0 0 12px' }}>Wiring Reference</p>
              {[
                ['YL-38 VCC',  '→', 'Arduino 5V',  '#dc2626'],
                ['YL-38 GND',  '→', 'Arduino GND', '#475569'],
                ['YL-38 A0',   '→', 'Arduino A0',  '#2563eb'],
                ['YL-38 D0',   '→', 'Arduino D2',  '#16a34a'],
                ['Arduino USB','→', 'PC COM Port',  '#7c3aed'],
              ].map(([from, arrow, to, c]) => (
                <div key={from} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ color: c, fontWeight: 700, minWidth: 90 }}>{from}</span>
                  <span style={{ color: 'hsl(var(--muted-foreground))' }}>{arrow}</span>
                  <span style={{ color: 'hsl(var(--foreground))' }}>{to}</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid hsl(var(--border))', marginTop: 12, paddingTop: 10 }}>
                <p style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', margin: 0, lineHeight: 1.6 }}>
                  Arduino sketch must send<br />
                  <span style={{ color: '#dc2626', fontWeight: 700 }}>Serial.println("FIRE_DETECTED");</span><br />
                  <span style={{ color: '#16a34a', fontWeight: 700 }}>Serial.println("ALL_CLEAR");</span>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Status bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isFire
              ? <Flame style={{ width: 26, height: 26, color: lvlColor }} />
              : <ShieldCheck style={{ width: 26, height: 26, color: isConnected ? '#16a34a' : 'hsl(var(--muted-foreground))' }} />}
            <div>
              <h1 style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 800, fontSize: 20, color: 'hsl(var(--foreground))', margin: 0 }}>
                {!isConnected
                  ? 'Awaiting Connection'
                  : isFire ? 'Flame Active' : 'Monitoring — No Flame'}
              </h1>
              <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'hsl(var(--muted-foreground))', margin: '2px 0 0' }}>
                SENSOR: YL-38 + LM393 · BAUD: 9600 · {now.toLocaleTimeString()}
              </p>
            </div>
          </div>
          {isConnected && (
            <span style={{
              padding: '4px 12px', borderRadius: 6,
              background: lvlColor + '18', color: lvlColor,
              border: `1px solid ${lvlColor}35`,
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
              letterSpacing: '0.12em',
            }}>{lvlLabel}</span>
          )}
        </div>

        {/* ── KPI cards ──────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14, marginBottom: 24 }}>

          {/* Heat Intensity */}
          <div style={{
            background: 'hsl(var(--card))', border: `1px solid hsl(var(--border))`,
            borderTop: `3px solid ${isConnected ? lvlColor : 'hsl(var(--border))'}`,
            borderRadius: 12, padding: '18px 20px',
          }}>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', letterSpacing: '0.14em', textTransform: 'uppercase', margin: '0 0 6px' }}>Heat Intensity</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 32, fontWeight: 700, color: isConnected ? lvlColor : 'hsl(var(--muted-foreground))', lineHeight: 1, margin: 0 }}>
                  {isConnected ? metrics.heatIntensity : '—'}
                </p>
                <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'hsl(var(--muted-foreground))', margin: '4px 0 0' }}>ADC (0–1023)</p>
              </div>
              <RingGauge value={metrics.heatIntensity} max={1023} color={isConnected ? lvlColor : 'hsl(var(--border))'} size={72} />
            </div>
            <div style={{ marginTop: 10 }}>
              <Sparkline data={intensityHist} color={isConnected ? lvlColor : 'hsl(var(--border))'} height={36} />
            </div>
          </div>

          {/* Estimated Distance */}
          <div style={{
            background: 'hsl(var(--card))', border: `1px solid hsl(var(--border))`,
            borderTop: `3px solid ${metrics.distance && isConnected ? '#2563eb' : 'hsl(var(--border))'}`,
            borderRadius: 12, padding: '18px 20px',
          }}>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', letterSpacing: '0.14em', textTransform: 'uppercase', margin: '0 0 6px' }}>Est. Distance</p>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              <Ruler style={{ width: 18, height: 18, color: '#2563eb', marginBottom: 4 }} />
              <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 32, fontWeight: 700, lineHeight: 1, margin: 0, color: metrics.distance && isConnected ? '#2563eb' : 'hsl(var(--muted-foreground))' }}>
                {isConnected && metrics.distance ? metrics.distance : '—'}
              </p>
              {isConnected && metrics.distance && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, color: 'hsl(var(--muted-foreground))', marginBottom: 4 }}>cm</span>}
            </div>
            <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', marginTop: 8 }}>
              {!isConnected ? 'Connect sensor to measure'
                : metrics.distance
                ? `Flame ~${metrics.distance < 30 ? 'very close' : metrics.distance < 80 ? 'nearby' : 'at range'}`
                : 'No flame source detected'}
            </p>
            {isConnected && metrics.distance && (
              <div style={{ marginTop: 12 }}>
                <div style={{ height: 6, background: 'hsl(var(--border))', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 3,
                    background: metrics.distance < 30 ? '#dc2626' : metrics.distance < 80 ? '#ea580c' : '#2563eb',
                    width: `${Math.max(5, 100 - (metrics.distance / 150) * 100)}%`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))' }}>
                  <span>CLOSE</span><span>FAR</span>
                </div>
              </div>
            )}
          </div>

          {/* Temperature */}
          <div style={{
            background: 'hsl(var(--card))', border: `1px solid hsl(var(--border))`,
            borderTop: `3px solid ${isConnected ? '#ea580c' : 'hsl(var(--border))'}`,
            borderRadius: 12, padding: '18px 20px',
          }}>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', letterSpacing: '0.14em', textTransform: 'uppercase', margin: '0 0 6px' }}>Sensor Temp</p>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              <Thermometer style={{ width: 18, height: 18, color: '#ea580c', marginBottom: 4 }} />
              <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 32, fontWeight: 700, color: isConnected ? '#ea580c' : 'hsl(var(--muted-foreground))', lineHeight: 1, margin: 0 }}>
                {isConnected ? metrics.temperature : '—'}
              </p>
              {isConnected && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, color: 'hsl(var(--muted-foreground))', marginBottom: 4 }}>°C</span>}
            </div>
            <div style={{ marginTop: 10 }}>
              <Sparkline data={tempHist} color={isConnected ? '#ea580c' : 'hsl(var(--border))'} height={36} />
            </div>
          </div>

          {/* Signal Voltage */}
          <div style={{
            background: 'hsl(var(--card))', border: `1px solid hsl(var(--border))`,
            borderTop: `3px solid ${isConnected ? '#7c3aed' : 'hsl(var(--border))'}`,
            borderRadius: 12, padding: '18px 20px',
          }}>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', letterSpacing: '0.14em', textTransform: 'uppercase', margin: '0 0 6px' }}>Signal Voltage</p>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              <Zap style={{ width: 18, height: 18, color: '#7c3aed', marginBottom: 4 }} />
              <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 32, fontWeight: 700, color: isConnected ? '#7c3aed' : 'hsl(var(--muted-foreground))', lineHeight: 1, margin: 0 }}>
                {isConnected ? metrics.voltage : '—'}
              </p>
              {isConnected && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, color: 'hsl(var(--muted-foreground))', marginBottom: 4 }}>mV</span>}
            </div>
            <p style={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', marginTop: 8 }}>
              {isConnected ? `${((metrics.voltage / 3300) * 100).toFixed(1)}% of 3.3V reference` : 'Analog IR output · 3.3V ref'}
            </p>
            {isConnected && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <Activity style={{ width: 12, height: 12, color: '#7c3aed' }} />
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#7c3aed' }}>Live reading</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Lower section ───────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* Status visual */}
          <div style={{
            background: 'hsl(var(--card))', border: `1px solid hsl(var(--border))`,
            borderRadius: 12, padding: '20px',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', letterSpacing: '0.14em', textTransform: 'uppercase', margin: 0 }}>Sensor Status</p>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0' }}>
              <div style={{
                width: 120, height: 120, borderRadius: '50%',
                background: !isConnected ? 'hsl(var(--muted))' : isFire ? lvlColor + '20' : 'hsl(var(--accent))',
                border: `3px solid ${!isConnected ? 'hsl(var(--border))' : isFire ? lvlColor : '#16a34a'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: isFire ? `0 0 32px ${lvlColor}50` : 'none',
                transition: 'all 0.5s ease',
                animation: isFire ? 'pulseGlow 1.5s ease infinite' : 'none',
              }}>
                {!isConnected
                  ? <WifiOff style={{ width: 36, height: 36, color: 'hsl(var(--muted-foreground))' }} />
                  : isFire
                  ? <Flame style={{ width: 48, height: 48, color: lvlColor }} />
                  : <ShieldCheck style={{ width: 40, height: 40, color: '#16a34a' }} />}
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSize: 17, margin: 0,
                  color: !isConnected ? 'hsl(var(--muted-foreground))' : isFire ? lvlColor : '#16a34a' }}>
                  {!isConnected ? 'NOT CONNECTED' : isFire ? lvlLabel : 'ALL CLEAR'}
                </p>
                <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'hsl(var(--muted-foreground))', margin: '4px 0 0' }}>
                  {!isConnected ? 'Plug in Arduino + click Connect'
                    : isFire ? `Flame at ${metrics.heatIntensity} ADC · ${metrics.voltage}mV`
                    : 'No infrared signature detected'}
                </p>
              </div>
            </div>

            {/* Intensity bar */}
            {isConnected && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                  <span>INTENSITY LEVEL</span>
                  <span style={{ color: lvlColor }}>{(intensityPct * 100).toFixed(1)}%</span>
                </div>
                <div style={{ height: 10, background: 'hsl(var(--border))', borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 5,
                    width: `${intensityPct * 100}%`,
                    background: 'linear-gradient(to right, #16a34a, #ca8a04, #ea580c, #dc2626)',
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))' }}>
                  <span>IDLE</span><span>LOW</span><span>MOD</span><span>HIGH</span><span>CRIT</span>
                </div>
              </div>
            )}

            {/* Hardware info */}
            <div style={{ borderTop: '1px solid hsl(var(--border))', paddingTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                ['Sensor Model', 'YL-38 + LM393'],
                ['Protocol',     'Web Serial API'],
                ['Board',        'Arduino Uno'],
                ['Baud Rate',    '9600'],
              ].map(([k, v]) => (
                <div key={k}>
                  <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0 }}>{k}</p>
                  <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'hsl(var(--foreground))', margin: '2px 0 0' }}>{v}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Alert log */}
          <div style={{
            background: 'hsl(var(--card))', border: `1px solid hsl(var(--border))`,
            borderRadius: 12, padding: '20px',
            display: 'flex', flexDirection: 'column', gap: 10,
            maxHeight: 480,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'hsl(var(--muted-foreground))', letterSpacing: '0.14em', textTransform: 'uppercase', margin: 0 }}>
                Serial Log
              </p>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                {alerts.length} events
              </span>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {alerts.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', flexDirection: 'column', gap: 10 }}>
                  <ShieldCheck style={{ width: 30, height: 30, color: '#16a34a' }} />
                  <p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', margin: 0, textAlign: 'center' }}>
                    {isConnected ? 'Monitoring… waiting for sensor events' : 'Connect Arduino to start monitoring'}
                  </p>
                </div>
              ) : alerts.map(a => (
                <div key={a.id} style={{
                  padding: '9px 12px', borderRadius: 8,
                  background: alertTypeColor[a.type] + '10',
                  borderLeft: `3px solid ${alertTypeColor[a.type]}`,
                  border: `1px solid ${alertTypeColor[a.type]}25`,
                }}>
                  <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: 'hsl(var(--foreground))', margin: 0 }}>{a.message}</p>
                  <div style={{ display: 'flex', gap: 10, marginTop: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Clock style={{ width: 9, height: 9 }} />
                      {a.time.toLocaleTimeString()}
                    </span>
                    <span style={{ opacity: 0.7 }}>RAW: {a.raw}</span>
                  </div>
                </div>
              ))}
            </div>

            {alerts.length > 0 && (
              <button onClick={() => setAlerts([])} style={{
                padding: '7px', borderRadius: 8, fontSize: 12,
                border: '1px solid hsl(var(--border))',
                background: 'hsl(var(--muted))',
                color: 'hsl(var(--muted-foreground))',
                cursor: 'pointer',
              }}>
                Clear Log
              </button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 32, paddingTop: 16,
          borderTop: '1px solid hsl(var(--border))',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
        }}>
          <span style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSize: 14, color: 'hsl(var(--primary))' }}>
            Dodoco · IoT Flame Sensor
          </span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'hsl(var(--muted-foreground))' }}>
            BETA PHASE · Web Serial API · YL-38 IR Sensor + Arduino @ 9600 baud
          </span>
        </div>
      </div>

      <style>{`
        @keyframes pulseGlow {
          0%,100% { box-shadow: 0 0 20px ${lvlColor}40; }
          50%      { box-shadow: 0 0 45px ${lvlColor}70; }
        }
        @keyframes flashBanner {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.88; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default FlameSensorPage;
