import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plane, Plus, Search, ExternalLink, Calendar } from 'lucide-react';
import { flightsApi } from '../../api/flights';
import { formatDate, formatTime } from '../../utils/formatters';
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
        const res = await flightsApi.searchFlights({ limit: 50 });
        if (res.success) setFlights(res.data.flights || []);
      } catch (err) {
        console.error(err);
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
      title: 'Flight',
      key: 'flightNumber',
      render: (_, row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: '700',
              color: 'var(--accent-cyan)',
            }}
          >
            {row.airlineCode} {row.flightNumber}
          </span>
        </div>
      ),
    },
    {
      title: 'Route',
      key: 'route',
      render: (_, row) => (
        <div style={{ fontWeight: '600' }}>
          {row.origin} → {row.destination}
        </div>
      ),
    },
    {
      title: 'Departure',
      key: 'departureTime',
      render: (_, row) => (
        <div>
          <div>{formatDate(row.departureDate)}</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {formatTime(row.departureTime)}
          </div>
        </div>
      ),
    },
    {
      title: 'Aircraft',
      key: 'aircraftType',
      render: (val) => (
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {val}
        </span>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      render: (val) => <Badge status={val} size="sm" />,
    },
    {
      title: 'Actions',
      key: 'actions',
      align: 'right',
      render: (_, row) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <Button
            variant="secondary"
            size="sm"
            icon={ExternalLink}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/flights/${row.flightId}`);
            }}
          >
            Seat Map
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
              Flight Schedule & Inventory Management
            </h1>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Browse scheduled flight records across Citus table partitions.
            </p>
          </div>

          <Link to="/admin/flights/create" style={{ textDecoration: 'none' }}>
            <Button variant="primary" icon={Plus}>
              Create Flight
            </Button>
          </Link>
        </div>

        {/* Filter Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1rem 1.25rem',
          }}
        >
          {/* Status Tabs */}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {['ALL', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                style={{
                  padding: '0.4rem 0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.82rem',
                  fontWeight: '600',
                  border: '1px solid',
                  borderColor: statusFilter === st ? 'var(--accent-primary)' : 'var(--border-subtle)',
                  backgroundColor: statusFilter === st ? 'var(--accent-light)' : 'transparent',
                  color: statusFilter === st ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {st}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div style={{ position: 'relative', width: '280px' }}>
            <Search
              size={15}
              style={{
                position: 'absolute',
                left: '0.75rem',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)',
                pointerEvents: 'none',
              }}
            />
            <input
              type="text"
              placeholder="Search flight number, route..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                padding: '0.5rem 0.75rem 0.5rem 2.2rem',
                color: 'var(--text-primary)',
                fontSize: '0.88rem',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Flights Table */}
        <DataTable
          columns={columns}
          data={filtered}
          loading={loading}
          keyField="flightId"
          emptyMessage="No flight records match the filter criteria."
          onRowClick={(row) => navigate(`/flights/${row.flightId}`)}
        />
      </div>
    </div>
  );
}
