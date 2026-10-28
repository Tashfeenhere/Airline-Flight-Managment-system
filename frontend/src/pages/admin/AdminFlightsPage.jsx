import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plane, Plus, Search, ExternalLink, Calendar, Sparkles, Filter, CheckCircle2 } from 'lucide-react';
import { flightsApi } from '../../api/flights';
import { adminApi } from '../../api/admin';
import { formatDate, formatTime, formatCurrency } from '../../utils/formatters';
import AdminSidebar from '../../components/layout/AdminSidebar';
import DataTable from '../../components/ui/DataTable';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';

export default function AdminFlightsPage() {
  const navigate = useNavigate();
  const [flights, setFlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await adminApi.getFlights({ limit: 100 });
        if (res.success && res.data) {
          setFlights(res.data.flights || []);
        } else {
          const fallbackRes = await flightsApi.searchFlights({ limit: 50 });
          if (fallbackRes.success) setFlights(fallbackRes.data.flights || []);
        }
      } catch (err) {
        console.error('Failed to load flights:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = flights.filter((f) => {
    const matchesStatus = statusFilter === 'ALL' || f.status === statusFilter;
    if (!matchesStatus) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      f.flightNumber?.toLowerCase().includes(q) ||
      f.airlineCode?.toLowerCase().includes(q) ||
      f.origin?.toLowerCase().includes(q) ||
      f.destination?.toLowerCase().includes(q) ||
      f.aircraftType?.toLowerCase().includes(q)
    );
  });

  const columns = [
    {
      title: 'Flight Designator',
      key: 'flightNumber',
      render: (_, row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'rgba(99, 102, 241, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-primary)',
            }}
          >
            <Plane size={16} />
          </div>
          <div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: '700',
                color: 'var(--accent-cyan)',
                fontSize: '0.95rem',
              }}
            >
              {row.airlineCode} {row.flightNumber}
            </span>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{row.aircraftType}</div>
          </div>
        </div>
      ),
    },
    {
      title: 'Routing & Departure',
      key: 'origin',
      render: (_, row) => (
        <div>
          <div style={{ fontWeight: '700', color: '#ffffff' }}>
            {row.origin} → {row.destination}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Calendar size={12} />
            <span>{formatDate(row.departureDate)} • {formatTime(row.departureTime)}</span>
          </div>
        </div>
      ),
    },
    {
      title: 'Base Price',
      key: 'basePrice',
      align: 'right',
      render: (val, row) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--text-primary)' }}>
          {formatCurrency(val, row.currency)}
        </span>
      ),
    },
    {
      title: 'Available Inventory',
      key: 'availableSeats',
      align: 'right',
      render: (val) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: '#10b981' }}>
          {val ?? 184} Seats
        </span>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      align: 'center',
      render: (val) => <Badge status={val} size="sm" />,
    },
    {
      title: 'Actions',
      key: 'flightId',
      align: 'right',
      render: (val) => (
        <Link to={`/flights/${val}`} style={{ textDecoration: 'none' }}>
          <Button variant="secondary" size="sm" icon={ExternalLink}>
            Inspect
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - var(--header-height))' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem', maxWidth: '1400px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
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
              Master Schedule Index
            </span>
            <h1 style={{ fontSize: '1.9rem', fontWeight: '800', color: 'var(--text-primary)', margin: 0 }}>
              Distributed Flight Records & Schedules
            </h1>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.3rem', maxWidth: '820px' }}>
              Real-time inspection of partitioned flight rows distributed across Citus coordinator and worker tables.
            </p>
          </div>

          <Link to="/admin/flights/create" style={{ textDecoration: 'none' }}>
            <Button variant="primary" icon={Plus}>
              Provision New Flight
            </Button>
          </Link>
        </div>

        {/* Filter Bar with Pre-filled Quick Searches */}
        <div
          style={{
            backgroundColor: 'var(--bg-glass-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1rem 1.25rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '1rem',
            backdropFilter: 'blur(16px)',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {['ALL', 'SCHEDULED', 'BOARDING', 'DEPARTED'].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                style={{
                  padding: '0.45rem 0.85rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.85rem',
                  fontWeight: '600',
                  border: '1px solid',
                  borderColor: statusFilter === st ? 'var(--accent-primary)' : 'var(--border-subtle)',
                  backgroundColor: statusFilter === st ? 'var(--accent-primary)' : 'transparent',
                  color: statusFilter === st ? '#ffffff' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                {st}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            {/* Quick pre-fill route search buttons */}
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Quick Filters:</span>
            <button
              onClick={() => setSearchQuery('PK-785')}
              style={{
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                backgroundColor: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--accent-cyan)',
                padding: '3px 8px',
                borderRadius: 'var(--radius-xs)',
                cursor: 'pointer',
              }}
            >
              PK-785
            </button>
            <button
              onClick={() => setSearchQuery('LHR')}
              style={{
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                backgroundColor: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--accent-cyan)',
                padding: '3px 8px',
                borderRadius: 'var(--radius-xs)',
                cursor: 'pointer',
              }}
            >
              LHR
            </button>
            <button
              onClick={() => setSearchQuery('')}
              style={{
                fontSize: '0.75rem',
                backgroundColor: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              Clear
            </button>

            <div style={{ position: 'relative', width: '260px' }}>
              <div style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', display: 'flex' }}>
                <Search size={15} />
              </div>
              <input
                type="text"
                placeholder="Search flight, aircraft, route..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.45rem 0.75rem 0.45rem 2.2rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.85rem',
                  outline: 'none',
                }}
              />
            </div>
          </div>
        </div>

        {/* Data Table */}
        <Card style={{ padding: '1.5rem' }}>
          <DataTable
            columns={columns}
            data={filtered}
            keyField="flightId"
            loading={loading}
            emptyMessage="No flight records matching search criteria."
          />
        </Card>
      </div>
    </div>
  );
}
