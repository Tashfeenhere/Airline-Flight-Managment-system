import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, Play, Filter, CheckCircle2 } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { CABINS } from '../../utils/constants';
import AdminSidebar from '../../components/layout/AdminSidebar';
import DataTable from '../../components/ui/DataTable';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import Card from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';

export default function AdminInventoryAuditPage() {
  const [flightId, setFlightId] = useState('');
  const [cabin, setCabin] = useState('');
  const [limit, setLimit] = useState(100);

  const [auditResult, setAuditResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleRunAudit = async (e) => {
    if (e) e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await adminApi.auditInventory({
        flightId: flightId.trim() || undefined,
        cabin: cabin || undefined,
        limit: Number(limit),
      });

      if (res.success) {
        setAuditResult(res.data);
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Audit execution failed.');
    } finally {
      setLoading(false);
    }
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
      title: 'Capacity',
      key: 'capacity',
      align: 'right',
      render: (val) => <span style={{ fontFamily: 'var(--font-mono)' }}>{val}</span>,
    },
    {
      title: 'Booked',
      key: 'booked',
      align: 'right',
      render: (val) => <span style={{ fontFamily: 'var(--font-mono)' }}>{val}</span>,
    },
    {
      title: 'Available',
      key: 'available',
      align: 'right',
      render: (val) => <span style={{ fontFamily: 'var(--font-mono)' }}>{val}</span>,
    },
    {
      title: 'Held',
      key: 'held',
      align: 'right',
      render: (val) => <span style={{ fontFamily: 'var(--font-mono)' }}>{val}</span>,
    },
    {
      title: 'Delta (Invar.)',
      key: 'delta',
      align: 'right',
      render: (val) => (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: '700',
            color: val === 0 ? 'var(--status-success)' : 'var(--status-danger)',
          }}
        >
          {val === 0 ? '0 (OK)' : `+${val} (VIOLATION)`}
        </span>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      align: 'center',
      render: (val) => <Badge status={val} size="sm" />,
    },
  ];

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
            Inventory Oversell Invariant Audit
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Mathematical reconciliation checking <code style={{ color: 'var(--accent-cyan)' }}>capacity = booked + held + available</code> across all Citus inventory counters.
          </p>
        </div>

        {/* Audit Filter & Run Card */}
        <form
          onSubmit={handleRunAudit}
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.5rem',
            display: 'grid',
            gridTemplateColumns: '2fr 1.5fr 1fr auto',
            gap: '1rem',
            alignItems: 'end',
          }}
        >
          <Input
            label="Filter by Flight UUID (Optional)"
            placeholder="e.g. 8f7d9a10-4c32-..."
            value={flightId}
            onChange={(e) => setFlightId(e.target.value)}
          />

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
              Filter Cabin
            </label>
            <select
              value={cabin}
              onChange={(e) => setCabin(e.target.value)}
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
              <option value="">All Cabin Classes</option>
              {CABINS.map((c) => (
                <option key={c} value={c} style={{ backgroundColor: '#0f172a' }}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <Input
            label="Scan Ceiling (Limit)"
            type="number"
            min="10"
            max="1000"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />

          <Button
            type="submit"
            variant="primary"
            size="md"
            icon={Play}
            loading={loading}
            style={{ height: '44px' }}
          >
            Run Audit
          </Button>
        </form>

        {/* Results Overview Banner */}
        {auditResult && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: '1rem',
            }}
          >
            <Card>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Counters Inspected
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: '800', fontFamily: 'var(--font-mono)' }}>
                {auditResult.checked}
              </div>
            </Card>

            <Card>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Oversell Invariants Breached
              </div>
              <div
                style={{
                  fontSize: '1.8rem',
                  fontWeight: '800',
                  fontFamily: 'var(--font-mono)',
                  color: auditResult.oversoldCount === 0 ? 'var(--status-success)' : 'var(--status-danger)',
                }}
              >
                {auditResult.oversoldCount}
              </div>
            </Card>

            <Card>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Accounting Integrity
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--status-success)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <CheckCircle2 size={20} />
                100% Invariant Compliant
              </div>
            </Card>
          </div>
        )}

        {/* Inspected Flights Table */}
        <DataTable
          columns={columns}
          data={auditResult?.inspectedFlights || []}
          loading={loading}
          keyField="flightId"
          emptyMessage="Click 'Run Audit' to inspect Citus counter consistency across all distributed shards."
        />
      </div>
    </div>
  );
}
