import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Filter, SlidersHorizontal, Activity, AlertCircle } from 'lucide-react';
import { flightsApi } from '../../api/flights';
import SearchForm from '../../components/flights/SearchForm';
import FlightCard from '../../components/flights/FlightCard';
import Spinner from '../../components/ui/Spinner';
import Pagination from '../../components/ui/Pagination';
import { formatLag } from '../../utils/formatters';

export default function SearchResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const origin = searchParams.get('origin') || 'ISB';
  const destination = searchParams.get('destination') || 'LHR';
  const departureDate = searchParams.get('departureDate') || '2026-11-02';
  const cabin = searchParams.get('cabin') || 'ECONOMY';
  const passengers = Number(searchParams.get('passengers') || 1);
  const offset = Number(searchParams.get('offset') || 0);
  const limit = 10;

  const [flights, setFlights] = useState([]);
  const [total, setTotal] = useState(0);
  const [lagMs, setLagMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
          origin,
          destination,
          departureDate,
          cabin,
          passengers,
          offset,
          limit,
        });

        if (isMounted && res.success) {
          setFlights(res.data.flights || []);
          setTotal(res.data.total || 0);
          setLagMs(res.data.readModelLagMs || 0);
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
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
            Search results for{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {origin} → {destination}
            </strong>{' '}
            on {departureDate} ({cabin.replace('_', ' ')}, {passengers} pax)
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
              <option value="price_asc" style={{ backgroundColor: '#0f172a' }}>Lowest Price</option>
              <option value="price_desc" style={{ backgroundColor: '#0f172a' }}>Highest Price</option>
              <option value="dep_asc" style={{ backgroundColor: '#0f172a' }}>Earliest Departure</option>
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
          {loading ? (
            <div
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-lg)',
                padding: '4rem',
              }}
            >
              <Spinner size="lg" label="Querying Citus read projection..." />
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
                  No scheduled flights match your search criteria for {origin} → {destination}. Try adjusting your date or cabin class.
                </p>
              </div>
            </div>
          ) : (
            <>
              {filteredFlights.map((flight) => (
                <FlightCard
                  key={flight.flightId}
                  flight={flight}
                  requestedCabin={cabin}
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
