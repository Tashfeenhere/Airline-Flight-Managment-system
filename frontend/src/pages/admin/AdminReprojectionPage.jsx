import React, { useState } from 'react';
import { RotateCcw, Play, CheckCircle2, AlertCircle, Sparkles, Activity, Clock, ArrowRight } from 'lucide-react';
import { adminApi } from '../../api/admin';
import AdminSidebar from '../../components/layout/AdminSidebar';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';
import { useToast } from '../../components/ui/Toast';

export default function AdminReprojectionPage() {
  const toast = useToast();
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [flightIdsRaw, setFlightIdsRaw] = useState('');
  const [force, setForce] = useState(false);

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleReproject = async (customPayload = null) => {
    setLoading(true);
    setError(null);

    const flightIds = flightIdsRaw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const payload = customPayload || {
      from: fromTime || undefined,
      to: toTime || undefined,
      flightIds: flightIds.length > 0 ? flightIds : undefined,
      force,
    };

    try {
      const res = await adminApi.reproject(payload);
      if (res.success) {
        setResult(res.data);
        toast.success(`Reprojected ${res.data.projected} flights into read-model cache in ${res.data.elapsedMs}ms!`, 'Projection Complete');
      }
    } catch (err) {
      const msg = err.error?.message || err.message || 'Reprojection failed.';
      setError(msg);
      toast.error(msg, 'Reprojection Error');
    } finally {
      setLoading(false);
    }
  };

  const applyPreset = (preset) => {
    setFromTime(preset.fromTime || '');
    setToTime(preset.toTime || '');
    setFlightIdsRaw(preset.flightIdsRaw || '');
    setForce(preset.force || false);
    handleReproject(preset);
  };

  return (
    <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - var(--header-height))' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem', maxWidth: '1000px' }}>
        <div>
          <span
            style={{
              fontSize: '0.72rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: '800',
              color: 'var(--accent-primary)',
              backgroundColor: 'rgba(99, 102, 241, 0.12)',
              padding: '0.2rem 0.65rem',
              borderRadius: 'var(--radius-full)',
              border: '1px solid rgba(99, 102, 241, 0.3)',
              display: 'inline-block',
              marginBottom: '0.35rem',
            }}
          >
            CQRS Event Replay Engine
          </span>
          <h1 style={{ fontSize: '1.9rem', fontWeight: '800', color: 'var(--text-primary)', margin: 0 }}>
            Read-Model Projection Replay
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.3rem', maxWidth: '820px' }}>
            Replays write-model transactional events into the denormalized flight search read-model for sub-5ms passenger queries.
          </p>
        </div>

        {/* 1-Click Reprojection Presets */}
        <div
          style={{
            backgroundColor: 'var(--bg-glass-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            backdropFilter: 'blur(16px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-primary)', fontSize: '0.84rem', fontWeight: '700' }}>
            <Sparkles size={16} />
            <span>1-Click Reprojection Presets</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
            <button
              onClick={() => applyPreset({ force: true })}
              disabled={loading}
              style={{
                padding: '0.75rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'left',
                cursor: 'pointer',
              }}
              className="btn-interactive"
            >
              <div style={{ fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                ⚡ Full Active Schedule Replay
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Recomputes denormalized search caches for all flights
              </div>
            </button>

            <button
              onClick={() => applyPreset({ fromTime: new Date(Date.now() - 86400000).toISOString(), force: false })}
              disabled={loading}
              style={{
                padding: '0.75rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'left',
                cursor: 'pointer',
              }}
              className="btn-interactive"
            >
              <div style={{ fontWeight: '700', fontSize: '0.88rem', color: 'var(--accent-cyan)' }}>
                🕒 Last 24 Hours Delta Sync
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Quick catch-up replay of recent booking updates
              </div>
            </button>
          </div>
        </div>

        {error && <Alert variant="danger">{error}</Alert>}

        {/* Custom Form */}
        <Card style={{ padding: '1.75rem' }}>
          <form onSubmit={(e) => { e.preventDefault(); handleReproject(); }} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <h3 style={{ fontSize: '1.15rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem', margin: 0 }}>
              Selective Projection Parameters
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
              <Input
                label="Replay Window Start (ISO UTC)"
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
                placeholder="2026-10-24T00:00:00Z"
              />
              <Input
                label="Replay Window End (ISO UTC)"
                value={toTime}
                onChange={(e) => setToTime(e.target.value)}
                placeholder="2026-10-24T23:59:59Z"
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              Force Overwrite Existing Projection Documents
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <Button type="submit" variant="primary" icon={Play} loading={loading}>
                Run Reprojection Job
              </Button>
            </div>
          </form>
        </Card>

        {/* Result summary */}
        {result && (
          <Card style={{ padding: '1.75rem', border: '1px solid var(--accent-primary)', backgroundColor: 'var(--bg-glass-card)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <CheckCircle2 size={24} style={{ color: 'var(--status-success)' }} />
              <div>
                <h3 style={{ fontSize: '1.15rem', margin: 0 }}>Projection Synchronized Successfully</h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Read-model tables fully aligned with Citus write-model transactions.
                </span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
              <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Records Projected</span>
                <div style={{ fontSize: '1.8rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: 'var(--status-success)' }}>
                  {result.projected}
                </div>
              </div>

              <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Written to Cache</span>
                <div style={{ fontSize: '1.8rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                  {result.written}
                </div>
              </div>

              <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Elapsed Time</span>
                <div style={{ fontSize: '1.8rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>
                  {result.elapsedMs}ms
                </div>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
