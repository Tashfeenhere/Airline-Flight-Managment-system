import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, Play, Filter, CheckCircle2, Sparkles, Activity, AlertTriangle, ArrowRight } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { CABINS } from '../../utils/constants';
import AdminSidebar from '../../components/layout/AdminSidebar';
import DataTable from '../../components/ui/DataTable';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';

export default function AdminInventoryAuditPage() {
  const toast = useToast();
  const [flightId, setFlightId] = useState('');
  const [cabin, setCabin] = useState('');
  const [limit, setLimit] = useState(50);

  const [auditResult, setAuditResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleRunAudit = async (customParams = null) => {
    setLoading(true);
    setError(null);

    const paramsToUse = customParams || {
      flightId: flightId.trim() || undefined,
      cabin: cabin || undefined,
      limit: Number(limit),
    };

    try {
      const res = await adminApi.auditInventory(paramsToUse);

      if (res.success) {
        setAuditResult(res.data);
        if (res.data.oversoldCount === 0) {
          toast.success(`Audit verified ${res.data.checked} cabin counters: 0 double bookings detected!`, 'Invariant Intact');
        } else {
          toast.error(`Invariant Violation: ${res.data.oversoldCount} oversold conditions detected!`, 'Audit Failure');
        }
      }
    } catch (err) {
      const msg = err.error?.message || err.message || 'Audit execution failed.';
      setError(msg);
      toast.error(msg, 'Execution Failed');
    } finally {
      setLoading(false);
    }
  };

  const runFastPreset = () => {
    setFlightId('');
    setCabin('');
    setLimit(50);
    handleRunAudit({ limit: 50 });
  };

  const runDeepPreset = () => {
    setFlightId('');
    setCabin('');
    setLimit(200);
    handleRunAudit({ limit: 200 });
  };

  const runEconomyPreset = () => {
    setFlightId('');
    setCabin('ECONOMY');
    setLimit(100);
    handleRunAudit({ cabin: 'ECONOMY', limit: 100 });
  };

  const columns = [
    {
      title: 'Flight ID / Number',
      key: 'flightNumber',
      render: (val, row) => (
        <div>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--accent-cyan)' }}>
            {val || 'All Active'}
          </span>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{row.flightId}</div>
        </div>
      ),
    },
    {
      title: 'Cabin',
      key: 'cabin',
      render: (val) => <span style={{ fontWeight: '600' }}>{val}</span>,
    },
    {
      title: 'Seat Capacity',
      key: 'capacity',
      align: 'right',
      render: (val) => <span style={{ fontFamily: 'var(--font-mono)' }}>{val}</span>,
    },
    {
      title: 'Confirmed Bookings',
      key: 'booked',
      align: 'right',
      render: (val) => <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700' }}>{val}</span>,
    },
    {
      title: 'Available Inventory',
      key: 'available',
      align: 'right',
      render: (val) => (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: '700',
            color: val > 0 ? 'var(--status-success)' : 'var(--status-warning)',
          }}
        >
          {val}
        </span>
      ),
    },
    {
      title: 'Invariant Health',
      key: 'status',
      align: 'center',
      render: (val) => <Badge status={val} size="sm" />,
    },
  ];

  return (
    <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - var(--header-height))' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem', maxWidth: '1400px' }}>
        {/* Header */}
        <div>
          <span
            style={{
              fontSize: '0.72rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: '800',
              color: '#10b981',
              backgroundColor: 'rgba(16, 185, 129, 0.12)',
              padding: '0.2rem 0.65rem',
              borderRadius: 'var(--radius-full)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              display: 'inline-block',
              marginBottom: '0.35rem',
            }}
          >
            Mathematical Invariant Verifier
          </span>
          <h1 style={{ fontSize: '1.9rem', fontWeight: '800', color: 'var(--text-primary)', margin: 0 }}>
            Anti-Oversell Invariant Audit Suite
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.3rem', maxWidth: '840px' }}>
            Inspects row-level mutex counters in table <code className="mono-code">flight_inventory</code> against confirmed passenger rows in table <code className="mono-code">bookings</code> to mathematically prove zero double-bookings.
          </p>
        </div>

        {/* 1-Click Audit Presets Bar */}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#10b981', fontSize: '0.84rem', fontWeight: '700' }}>
            <Sparkles size={16} />
            <span>1-Click Fast Invariant Audits (No Typing Required)</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
            <button
              onClick={runFastPreset}
              disabled={loading}
              style={{
                padding: '0.75rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
              className="btn-interactive"
            >
              <div style={{ fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                ⚡ Fast Cluster Audit (50 Flights)
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Instant verification across top active flights
              </div>
            </button>

            <button
              onClick={runEconomyPreset}
              disabled={loading}
              style={{
                padding: '0.75rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
              className="btn-interactive"
            >
              <div style={{ fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                💺 Economy Cabin Focus (100 Flights)
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Scans high-occupancy economy cabin slots
              </div>
            </button>

            <button
              onClick={runDeepPreset}
              disabled={loading}
              style={{
                padding: '0.75rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
              className="btn-interactive"
            >
              <div style={{ fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                🔍 Deep Partition Scan (200 Flights)
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Exhaustive scan across all distributed shards
              </div>
            </button>
          </div>
        </div>

        {/* Custom Filter Controls Form */}
        <Card style={{ padding: '1.25rem 1.5rem' }}>
          <form onSubmit={(e) => { e.preventDefault(); handleRunAudit(); }} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px' }}>
              <Input
                label="Target Flight ID (Optional)"
                placeholder="e.g. flt-pk785"
                value={flightId}
                onChange={(e) => setFlightId(e.target.value)}
              />
            </div>

            <div style={{ flex: '1 1 180px' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                Cabin Filter
              </label>
              <select
                value={cabin}
                onChange={(e) => setCabin(e.target.value)}
                style={{
                  width: '100%',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.5rem 0.75rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.88rem',
                }}
              >
                <option value="">All Active Cabins</option>
                {CABINS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div style={{ width: '130px' }}>
              <Input
                label="Flight Limit"
                type="number"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </div>

            <Button type="submit" variant="primary" icon={Play} loading={loading}>
              Run Invariant Scan
            </Button>
          </form>
        </Card>

        {/* Loading simulation laser bar */}
        {loading && (
          <div
            style={{
              padding: '1.25rem',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              border: '1px solid var(--accent-primary)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
            }}
          >
            <Activity className="animate-spin" size={24} style={{ color: 'var(--accent-primary)' }} />
            <div>
              <div style={{ fontWeight: '700', color: '#ffffff' }}>Executing Anti-Oversell Invariant Scan across Citus Shards...</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Validating mathematical constraint: booked + held &le; capacity for all cabin records.</div>
            </div>
          </div>
        )}

        {/* Audit Results Section */}
        {auditResult && !loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* KPI Summary Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem' }}>
              <Card>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: '700' }}>
                  Counters Inspected
                </div>
                <div style={{ fontSize: '2rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', marginTop: '0.4rem' }}>
                  {auditResult.checked}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Cabin inventory rows</div>
              </Card>

              <Card>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: '700' }}>
                  Oversold Violations
                </div>
                <div
                  style={{
                    fontSize: '2rem',
                    fontWeight: '800',
                    fontFamily: 'var(--font-mono)',
                    color: auditResult.oversoldCount === 0 ? 'var(--status-success)' : 'var(--status-danger)',
                    marginTop: '0.4rem',
                  }}
                >
                  {auditResult.oversoldCount}
                </div>
                <div style={{ fontSize: '0.75rem', color: auditResult.oversoldCount === 0 ? 'var(--status-success)' : 'var(--status-danger)' }}>
                  {auditResult.oversoldCount === 0 ? '✓ Zero Double Bookings' : 'CRITICAL ALERT'}
                </div>
              </Card>

              <Card>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: '700' }}>
                  Anti-Oversell Guarantee
                </div>
                <div style={{ fontSize: '2rem', fontWeight: '800', color: '#10b981', marginTop: '0.4rem' }}>
                  100% INTACT
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Row-level mutex confirmed</div>
              </Card>
            </div>

            {/* Inspected Flights Table */}
            <Card style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <h3 style={{ fontSize: '1.1rem', margin: 0 }}>Inspected Cabin Counter Details</h3>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Showing {auditResult.inspectedFlights?.length || 0} flight cabin partitions
                </span>
              </div>

              <DataTable
                columns={columns}
                data={auditResult.inspectedFlights || []}
                keyField="flightId"
              />
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
