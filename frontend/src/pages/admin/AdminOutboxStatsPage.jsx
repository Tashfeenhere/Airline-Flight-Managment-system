import React, { useEffect, useState } from 'react';
import { Inbox, RefreshCw, Activity, CheckCircle2, Clock } from 'lucide-react';
import { adminApi } from '../../api/admin';
import AdminSidebar from '../../components/layout/AdminSidebar';
import Card from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import DataTable from '../../components/ui/DataTable';
import Spinner from '../../components/ui/Spinner';

export default function AdminOutboxStatsPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadStats = async () => {
    try {
      const res = await adminApi.getOutboxStats();
      if (res.success) setStats(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        loadStats();
      }, 5000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh]);

  const breakdownColumns = [
    {
      title: 'Event Type',
      key: 'eventType',
      render: (val) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--accent-cyan)' }}>
          {val}
        </span>
      ),
    },
    {
      title: 'Dispatched Volume',
      key: 'count',
      align: 'right',
      render: (val) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '600' }}>
          {val.toLocaleString()}
        </span>
      ),
    },
    {
      title: 'Delivery Mode',
      key: 'delivery',
      align: 'right',
      render: () => <span style={{ color: 'var(--status-success)', fontSize: '0.85rem' }}>At-Least-Once Delivery</span>,
    },
  ];

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
              Transactional Outbox Pipeline Monitor
            </h1>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Monitor atomic event publication from Postgres shards into message queues and CQRS projections.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                style={{ accentColor: 'var(--accent-primary)' }}
              />
              Auto-poll (5s)
            </label>

            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={loadStats}>
              Refresh
            </Button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: '5rem 0' }}>
            <Spinner size="lg" label="Polling outbox worker queue stats..." />
          </div>
        ) : (
          <>
            {/* Stats Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.25rem' }}>
              <Card>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Pending Events
                </div>
                <div
                  style={{
                    fontSize: '2rem',
                    fontWeight: '800',
                    color: stats?.pending > 50 ? 'var(--status-warning)' : 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: '0.4rem',
                  }}
                >
                  {stats?.pending ?? 0}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  Awaiting worker dispatch
                </div>
              </Card>

              <Card>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Published Total
                </div>
                <div
                  style={{
                    fontSize: '2rem',
                    fontWeight: '800',
                    color: 'var(--status-success)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: '0.4rem',
                  }}
                >
                  {stats?.published?.toLocaleString() ?? '0'}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--status-success)', marginTop: '0.2rem' }}>
                  Successfully projected
                </div>
              </Card>

              <Card>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Failed / Poison Pill
                </div>
                <div
                  style={{
                    fontSize: '2rem',
                    fontWeight: '800',
                    color: stats?.failed > 0 ? 'var(--status-danger)' : 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: '0.4rem',
                  }}
                >
                  {stats?.failed ?? 0}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  Zero dead-letter events
                </div>
              </Card>

              <Card>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Oldest Event Age
                </div>
                <div
                  style={{
                    fontSize: '2rem',
                    fontWeight: '800',
                    color: 'var(--accent-cyan)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: '0.4rem',
                  }}
                >
                  {stats?.oldestEventAgeMs ?? 0}ms
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  Sub-second event lag
                </div>
              </Card>
            </div>

            {/* Event Type Breakdown Table */}
            <div>
              <h3 style={{ fontSize: '1.15rem', marginBottom: '0.85rem' }}>
                Dispatched Event Breakdown
              </h3>
              <DataTable
                columns={breakdownColumns}
                data={stats?.eventBreakdown || []}
                keyField="eventType"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
