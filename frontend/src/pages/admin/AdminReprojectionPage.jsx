import React, { useState } from 'react';
import { RotateCcw, Play, CheckCircle2, AlertCircle } from 'lucide-react';
import { adminApi } from '../../api/admin';
import AdminSidebar from '../../components/layout/AdminSidebar';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';

export default function AdminReprojectionPage() {
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [flightIdsRaw, setFlightIdsRaw] = useState('');
  const [force, setForce] = useState(false);

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleReproject = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const flightIds = flightIdsRaw
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const payload = {
        from: fromTime || undefined,
        to: toTime || undefined,
        flightIds: flightIds.length > 0 ? flightIds : undefined,
        force,
      };

      const res = await adminApi.reproject(payload);
      if (res.success) {
        setResult(res.data);
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Reprojection failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '850px' }}>
        <div>
          <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
            CQRS Read-Model Reprojection Engine
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Replay write-model events from transactional tables into the denormalized flight search projection.
          </p>
        </div>

        <form
          onSubmit={handleReproject}
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '2rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {error && <Alert variant="danger">{error}</Alert>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Input
              label="From Instant (RFC 3339, Optional)"
              placeholder="2026-11-01T00:00:00Z"
              value={fromTime}
              onChange={(e) => setFromTime(e.target.value)}
              helper="Start timestamp of events to replay"
            />

            <Input
              label="To Instant (RFC 3339, Optional)"
              placeholder="2026-11-04T00:00:00Z"
              value={toTime}
              onChange={(e) => setToTime(e.target.value)}
              helper="End timestamp bound"
            />
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: '500',
                color: 'var(--text-secondary)',
                marginBottom: '0.35rem',
              }}
            >
              Target Specific Flight UUIDs (One per line, optional)
            </label>
            <textarea
              rows={4}
              placeholder="8f7d9a10-4c32-4b35-86b1-098765432101&#10;9a8b7c6d-5e4f-4a3b-9c8d-123456789002"
              value={flightIdsRaw}
              onChange={(e) => setFlightIdsRaw(e.target.value)}
              style={{
                width: '100%',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                padding: '0.65rem 0.85rem',
                color: 'var(--text-primary)',
                fontSize: '0.88rem',
                fontFamily: 'var(--font-mono)',
                outline: 'none',
              }}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' }}>
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              style={{ accentColor: 'var(--accent-primary)' }}
            />
            Force (Re-project even if source version timestamp has not incremented)
          </label>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={loading}
            icon={Play}
            style={{ marginTop: '0.5rem' }}
          >
            Start Background Reprojection
          </Button>
        </form>

        {result && (
          <Card style={{ padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--status-success)' }}>
              <CheckCircle2 size={20} />
              <h3 style={{ fontSize: '1.1rem' }}>Reprojection Batch Complete</h3>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Projected Flights</span>
                <div style={{ fontSize: '1.5rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>
                  {result.projected}
                </div>
              </div>

              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Rows Written</span>
                <div style={{ fontSize: '1.5rem', fontWeight: '800', fontFamily: 'var(--font-mono)' }}>
                  {result.written}
                </div>
              </div>

              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Batches Processed</span>
                <div style={{ fontSize: '1.5rem', fontWeight: '800', fontFamily: 'var(--font-mono)' }}>
                  {result.batches}
                </div>
              </div>

              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Read-Model Lag</span>
                <div style={{ fontSize: '1.5rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: 'var(--status-success)' }}>
                  0ms
                </div>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
