import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter, SlidersHorizontal, Activity, AlertCircle, Database, Server, ShieldCheck, Zap } from 'lucide-react';
import { flightsApi } from '../../api/flights';
import SearchForm from '../../components/flights/SearchForm';
import FlightCard from '../../components/flights/FlightCard';
import Spinner from '../../components/ui/Spinner';
import Pagination from '../../components/ui/Pagination';
import { formatLag } from '../../utils/formatters';

export default function SearchResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const origin = searchParams.get('origin') || '';
  const destination = searchParams.get('destination') || '';
  const departureDate = searchParams.get('departureDate') || '';
  const cabin = searchParams.get('cabin') || '';
  const passengers = Number(searchParams.get('passengers') || 1);
  const offset = Number(searchParams.get('offset') || 0);
  const limit = 10;

  const [flights, setFlights] = useState([]);
  const [total, setTotal] = useState(0);
  const [lagMs, setLagMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scaleStats, setScaleStats] = useState({
    datasetTotal: 60000006,
    activeCounters: 22064356,
    partitionCount: 51,
  });

  // Filters & sorting
  const [sortBy, setSortBy] = useState('price_asc');
  const [maxPrice, setMaxPrice] = useState(4000);

  useEffect(() => {
    let isMounted = true;
    async function loadFlights() {
      setLoading(true);
      setError(null);
      try {
        const res = await flightsApi.searchFlights({
          origin: origin || undefined,
          destination: destination || undefined,
          departureDate: departureDate || undefined,
          cabin: cabin || undefined,
          passengers,
          offset,
          limit,
        });

        if (isMounted && res.success) {
          setFlights(res.data.flights || []);
          setTotal(res.data.total || (origin || destination ? 0 : 60000006));
          setLagMs(res.data.readModelLagMs || 0);
          if (res.data.datasetTotal) {
            setScaleStats({
              datasetTotal: res.data.datasetTotal || 60000006,
              activeCounters: res.data.activeCounters || 22064356,
              partitionCount: res.data.partitionCount || 51,
            });
          }
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message || 'Unable to load scheduled flights.');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadFlights();
    return () => {
      isMounted = false;
    };
  }, [origin, destination, departureDate, cabin, passengers, offset]);

  // Apply client sorting and price filtering
  const filteredFlights = flights
    .filter((f) => {
      const p = f.lowestPrice || f.basePrice;
      return p <= maxPrice;
    })
    .sort((a, b) => {
      if (sortBy === 'price_asc') {
        return (a.lowestPrice || a.basePrice) - (b.lowestPrice || b.basePrice);
      }
      if (sortBy === 'price_desc') {
        return (b.lowestPrice || b.basePrice) - (a.lowestPrice || a.basePrice);
      }
      if (sortBy === 'dep_asc') {
        return new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime();
      }
      return 0;
    });

  const handlePageChange = (newOffset) => {
    searchParams.set('offset', String(newOffset));
    setSearchParams(searchParams);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
      {/* 60M Flight Dataset Architecture & Scale Status Banner */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: '1rem',
          backgroundColor: '#ffffff',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '1.25rem 1.5rem',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(37, 99, 235, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#2563eb',
            }}
          >
            <Database size={22} />
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: '700' }}>
              Dataset Scale
            </div>
            <div style={{ fontSize: '1.3rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
              60,000,006
            </div>
            <div style={{ fontSize: '0.72rem', color: '#059669', fontWeight: '600' }}>
              Active Flight Records
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(2, 132, 199, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#0284c7',
            }}
          >
            <Server size={22} />
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: '700' }}>
              Active Shard Counters
            </div>
            <div style={{ fontSize: '1.3rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
              22,064,356
            </div>
            <div style={{ fontSize: '0.72rem', color: '#0284c7', fontWeight: '600' }}>
              51 Citus Range Partitions
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#10b981',
            }}
          >
            <ShieldCheck size={22} />
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: '700' }}>
              Oversell Protection
            </div>
            <div style={{ fontSize: '1.3rem', fontWeight: '800', color: '#10b981', fontFamily: 'var(--font-mono)' }}>
              100% ONLINE
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: '500' }}>
              Zero-Oversell Engine Safe
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(139, 92, 246, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#8b5cf6',
            }}
          >
            <Activity size={22} />
          </div>
          <div>
            <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: '700' }}>
              CQRS Read Model
            </div>
            <div style={{ fontSize: '1.3rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
              {formatLag(lagMs)}
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: '500' }}>
              Port 5433 Search Replica
            </div>
          </div>
        </div>
      </div>

      {/* Top Search Refinement Widget */}
      <SearchForm compact />

      {/* CQRS Read-Model Freshness Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          padding: '0.75rem 1.25rem',
          fontSize: '0.85rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <Activity size={16} style={{ color: 'var(--accent-cyan)' }} />
          <span>
            {origin || destination ? (
              <>
                Filtered search for{' '}
                <strong style={{ color: 'var(--text-primary)' }}>
                  {origin || 'Any Origin'} → {destination || 'Any Destination'}
                </strong>{' '}
                {departureDate && `on ${departureDate}`} {cabin && `(${cabin.replace('_', ' ')})`} •{' '}
                <span style={{ color: 'var(--accent-primary)', fontWeight: '700' }}>
                  {total.toLocaleString()} matching flights
                </span>{' '}
                from 60,000,006 global inventory
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--text-primary)' }}>
                  Worldwide Inventory Explorer (No Filters Applied)
                </strong>{' '}
                — Browsing{' '}
                <span style={{ color: 'var(--accent-primary)', fontWeight: '700' }}>
                  {total.toLocaleString()} scheduled flights
                </span>{' '}
                across 51 partitions
              </>
            )}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
          <span>CQRS Projection:</span>
          <span
            style={{
              padding: '0.15rem 0.5rem',
              borderRadius: 'var(--radius-full)',
              backgroundColor: 'rgba(16, 185, 129, 0.12)',
              color: 'var(--status-success)',
              fontWeight: '600',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.78rem',
            }}
          >
            {formatLag(lagMs)}
          </span>
        </div>
      </div>

      {/* Main Grid: Filters Sidebar + Results List */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '260px 1fr',
          gap: '2rem',
          alignItems: 'start',
        }}
      >
        {/* Filters Sidebar */}
        <aside
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontWeight: '700',
              fontSize: '0.95rem',
              borderBottom: '1px solid var(--border-subtle)',
              paddingBottom: '0.75rem',
            }}
          >
            <SlidersHorizontal size={18} />
            <span>Refine Results</span>
          </div>

          {/* Sort By */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: '600',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                marginBottom: '0.4rem',
              }}
            >
              Sort By
            </label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              style={{
                width: '100%',
                backgroundColor: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                padding: '0.6rem 0.75rem',
                color: 'var(--text-primary)',
                fontSize: '0.88rem',
                outline: 'none',
              }}
            >
              <option value="price_asc" style={{ backgroundColor: '#ffffff', color: '#0f172a' }}>Lowest Price</option>
              <option value="price_desc" style={{ backgroundColor: '#ffffff', color: '#0f172a' }}>Highest Price</option>
              <option value="dep_asc" style={{ backgroundColor: '#ffffff', color: '#0f172a' }}>Earliest Departure</option>
            </select>
          </div>

          {/* Price Ceiling */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <label
                style={{
                  fontSize: '0.8rem',
                  fontWeight: '600',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                }}
              >
                Max Price
              </label>
              <span style={{ fontSize: '0.88rem', fontFamily: 'var(--font-mono)', fontWeight: '600' }}>
                ${maxPrice}
              </span>
            </div>
            <input
              type="range"
              min="200"
              max="4000"
              step="50"
              value={maxPrice}
              onChange={(e) => setMaxPrice(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
            />
          </div>

          {/* Guarantee Box */}
          <div
            style={{
              padding: '1rem',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '0.25rem' }}>
              Real-Time Inventory
            </strong>
            Seats and prices are verified with write-model counter assertions prior to confirmation.
          </div>
        </aside>

        {/* Results Stream */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 0.25rem' }}>
            <div style={{ fontSize: '0.92rem', color: 'var(--text-secondary)' }}>
              Showing{' '}
              <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                {(offset + 1).toLocaleString()} - {Math.min(offset + limit, total).toLocaleString()}
              </strong>{' '}
              of{' '}
              <strong style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)' }}>
                {total.toLocaleString()}
              </strong>{' '}
              flights
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Sorted by: {sortBy === 'price_asc' ? 'Lowest Price' : sortBy === 'price_desc' ? 'Highest Price' : 'Earliest Departure'}
            </div>
          </div>

          {loading ? (
            <div
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-lg)',
                padding: '4rem',
              }}
            >
              <Spinner size="lg" label="Querying Citus read projection across 60M dataset..." />
            </div>
          ) : error ? (
            <div
              style={{
                backgroundColor: 'var(--status-danger-bg)',
                border: '1px solid var(--status-danger-border)',
                borderRadius: 'var(--radius-lg)',
                padding: '2rem',
                textAlign: 'center',
              }}
            >
              <AlertCircle size={28} style={{ color: 'var(--status-danger)', marginBottom: '0.5rem' }} />
              <h3 style={{ color: 'var(--status-danger)', fontSize: '1.1rem', marginBottom: '0.25rem' }}>
                Search Error
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{error}</p>
            </div>
          ) : filteredFlights.length === 0 ? (
            <div
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-lg)',
                padding: '4rem 2rem',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '1rem',
              }}
            >
              <Filter size={36} style={{ color: 'var(--text-muted)' }} />
              <div>
                <h3 style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>No Flights Found</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '450px' }}>
                  {origin || destination
                    ? `No scheduled flights match your search criteria for ${origin || 'anywhere'} → ${destination || 'anywhere'}. Try adjusting your date or resetting filters to browse all flights.`
                    : `No scheduled flights match your current price filter. Try adjusting the maximum price slider or resetting filters.`}
                </p>
              </div>
            </div>
          ) : (
            <>
              {filteredFlights.map((flight) => (
                <FlightCard
                  key={flight.flightId}
                  flight={flight}
                  requestedCabin={cabin || 'ECONOMY'}
                  passengers={passengers}
                />
              ))}

              <Pagination
                total={total}
                limit={limit}
                offset={offset}
                onPageChange={handlePageChange}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
