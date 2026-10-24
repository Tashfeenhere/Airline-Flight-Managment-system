import React, { useState } from 'react';
import { Layers, Play, CheckCircle2, AlertTriangle } from 'lucide-react';
import { adminApi } from '../../api/admin';
import AdminSidebar from '../../components/layout/AdminSidebar';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';

export default function AdminPartitionsPage() {
  const [monthsAhead, setMonthsAhead] = useState(12);
  const [monthsBehind, setMonthsBehind] = useState(3);
  const [retentionMonths, setRetentionMonths] = useState(24);
  const [dryRun, setDryRun] = useState(false);
  const [mode, setMode] = useState('detach');
  const [force, setForce] = useState(false);

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleMaintain = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await adminApi.maintainPartitions({
        monthsAhead: Number(monthsAhead),
        monthsBehind: Number(monthsBehind),
        retentionMonths: Number(retentionMonths),
        dryRun,
        mode,
        force,
      });

      if (res.success) {
        setResult(res.data);
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Partition maintenance failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '900px' }}>
        <div>
          <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
            Monthly Table Partition Maintenance
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Pre-provision future flight and booking monthly partition tables and safely prune or detach historical records.
          </p>
        </div>

        <form
          onSubmit={handleMaintain}
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
            <Input
              label="Months Ahead (Horizon)"
              type="number"
              min="0"
              max="36"
              value={monthsAhead}
              onChange={(e) => setMonthsAhead(e.target.value)}
              helper="Pre-creates monthly child tables"
            />

            <Input
              label="Months Behind (Lookback)"
              type="number"
              min="0"
              max="12"
              value={monthsBehind}
              onChange={(e) => setMonthsBehind(e.target.value)}
              helper="Retains recent past partitions"
            />

            <Input
              label="Retention Ceiling (Months)"
              type="number"
              min="1"
              max="120"
              value={retentionMonths}
              onChange={(e) => setRetentionMonths(e.target.value)}
              helper="Cutoff before tables are detached"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
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
                Prune Action Mode
              </label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                style={{
                  width: '100%',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.65rem 0.85rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  outline: 'none',
                }}
              >
                <option value="detach" style={{ backgroundColor: '#0f172a' }}>
                  Detach Partition (Preserves table data safely)
                </option>
                <option value="drop" style={{ backgroundColor: '#0f172a' }}>
                  Drop Table (Irreversible DDL deletion)
                </option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(e) => setDryRun(e.target.checked)}
                  style={{ accentColor: 'var(--accent-primary)' }}
                />
                Dry Run (Simulate DDL without mutating database)
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--status-warning)' }}>
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  style={{ accentColor: 'var(--status-warning)' }}
                />
                Force (Override non-empty partition safety check)
              </label>
            </div>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={loading}
            icon={Play}
            style={{ marginTop: '0.5rem' }}
          >
            Execute Partition Maintenance DDL
          </Button>
        </form>

        {/* Output Result Card */}
        {result && (
          <Card style={{ padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--status-success)' }}>
              <CheckCircle2 size={20} />
              <h3 style={{ fontSize: '1.1rem' }}>Maintenance Routine Complete</h3>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Created Partitions</span>
                <div style={{ fontSize: '1.4rem', fontWeight: '800', fontFamily: 'var(--font-mono)' }}>
                  +{result.partitionsCreated}
                </div>
              </div>

              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Pruned / Detached</span>
                <div style={{ fontSize: '1.4rem', fontWeight: '800', fontFamily: 'var(--font-mono)' }}>
                  {result.partitionsDropped}
                </div>
              </div>

              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Horizon Date</span>
                <div style={{ fontSize: '1rem', fontWeight: '700', fontFamily: 'var(--font-mono)', marginTop: '0.2rem' }}>
                  {result.horizon}
                </div>
              </div>

              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Execution Mode</span>
                <div style={{ fontSize: '1rem', fontWeight: '700', color: result.dryRun ? 'var(--status-warning)' : 'var(--status-success)', marginTop: '0.2rem' }}>
                  {result.dryRun ? 'DRY RUN' : 'COMMITTED'}
                </div>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
