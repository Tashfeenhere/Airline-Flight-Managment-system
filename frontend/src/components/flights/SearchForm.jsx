import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Calendar, Users, ArrowRightLeft } from 'lucide-react';
import { AIRPORTS, CABINS, CABIN_DETAILS } from '../../utils/constants';
import { useSearchStore } from '../../stores/searchStore';
import Button from '../ui/Button';

export default function SearchForm({ compact = false, onSearch }) {
  const navigate = useNavigate();
  const { searchParams, setSearchParams } = useSearchStore();

  const [origin, setOrigin] = useState(searchParams.origin || 'ISB');
  const [destination, setDestination] = useState(searchParams.destination || 'LHR');
  const [departureDate, setDepartureDate] = useState(searchParams.departureDate || '2026-11-02');
  const [cabin, setCabin] = useState(searchParams.cabin || 'ECONOMY');
  const [passengers, setPassengers] = useState(searchParams.passengers || 1);

  const handleSwapAirports = () => {
    const temp = origin;
    setOrigin(destination);
    setDestination(temp);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const query = {
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      departureDate,
      cabin,
      passengers: Number(passengers),
    };

    setSearchParams(query);

    if (onSearch) {
      onSearch(query);
    } else {
      navigate(
        `/flights/search?origin=${query.origin}&destination=${query.destination}&departureDate=${query.departureDate}&cabin=${query.cabin}&passengers=${query.passengers}`
      );
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        backgroundColor: compact ? 'var(--bg-surface)' : 'var(--bg-glass-card)',
        backdropFilter: compact ? 'none' : 'blur(16px)',
        WebkitBackdropFilter: compact ? 'none' : 'blur(16px)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)',
        padding: compact ? '1.25rem' : '1.75rem',
        boxShadow: compact ? 'var(--shadow-md)' : 'var(--shadow-lg), var(--shadow-glow)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact
            ? 'repeat(auto-fit, minmax(180px, 1fr))'
            : '2fr auto 2fr 1.5fr 1.5fr 1.2fr auto',
          gap: '1rem',
          alignItems: 'end',
        }}
      >
        {/* Origin Airport */}
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.8rem',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              marginBottom: '0.35rem',
            }}
          >
            Origin
          </label>
          <select
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            required
            style={{
              width: '100%',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: 'var(--text-primary)',
              fontSize: '0.95rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {AIRPORTS.map((a) => (
              <option key={a.code} value={a.code} style={{ backgroundColor: '#0f172a' }}>
                {a.code} — {a.city} ({a.name})
              </option>
            ))}
          </select>
        </div>

        {/* Swap Button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={handleSwapAirports}
            title="Swap Origin and Destination"
            style={{
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-sm)',
              width: '40px',
              height: '42px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
            }}
          >
            <ArrowRightLeft size={16} />
          </button>
        </div>

        {/* Destination Airport */}
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.8rem',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              marginBottom: '0.35rem',
            }}
          >
            Destination
          </label>
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            required
            style={{
              width: '100%',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: 'var(--text-primary)',
              fontSize: '0.95rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {AIRPORTS.map((a) => (
              <option key={a.code} value={a.code} style={{ backgroundColor: '#0f172a' }}>
                {a.code} — {a.city} ({a.name})
              </option>
            ))}
          </select>
        </div>

        {/* Departure Date */}
        <div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              fontSize: '0.8rem',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              marginBottom: '0.35rem',
            }}
          >
            <Calendar size={13} />
            Departure Date
          </label>
          <input
            type="date"
            value={departureDate}
            onChange={(e) => setDepartureDate(e.target.value)}
            required
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
          />
        </div>

        {/* Cabin */}
        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.8rem',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              marginBottom: '0.35rem',
            }}
          >
            Cabin Class
          </label>
          <select
            value={cabin}
            onChange={(e) => setCabin(e.target.value)}
            style={{
              width: '100%',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: 'var(--text-primary)',
              fontSize: '0.95rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {CABINS.map((c) => (
              <option key={c} value={c} style={{ backgroundColor: '#0f172a' }}>
                {CABIN_DETAILS[c]?.label || c}
              </option>
            ))}
          </select>
        </div>

        {/* Passengers */}
        <div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              fontSize: '0.8rem',
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              marginBottom: '0.35rem',
            }}
          >
            <Users size={13} />
            Passengers
          </label>
          <select
            value={passengers}
            onChange={(e) => setPassengers(e.target.value)}
            style={{
              width: '100%',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: 'var(--text-primary)',
              fontSize: '0.95rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n} style={{ backgroundColor: '#0f172a' }}>
                {n} {n === 1 ? 'Traveler' : 'Travelers'}
              </option>
            ))}
          </select>
        </div>

        {/* Submit */}
        <div>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            icon={Search}
            style={{ width: '100%', height: '46px' }}
          >
            Search
          </Button>
        </div>
      </div>
    </form>
  );
}
