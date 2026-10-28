import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Calendar, Users, ArrowRightLeft, Globe, RotateCcw } from 'lucide-react';
import { AIRPORTS, CABINS, CABIN_DETAILS } from '../../utils/constants';
import { useSearchStore } from '../../stores/searchStore';
import Button from '../ui/Button';

export default function SearchForm({ compact = false, onSearch }) {
  const navigate = useNavigate();
  const { searchParams, setSearchParams } = useSearchStore();

  const [origin, setOrigin] = useState(searchParams.origin || '');
  const [destination, setDestination] = useState(searchParams.destination || '');
  const [departureDate, setDepartureDate] = useState(searchParams.departureDate || '');
  const [cabin, setCabin] = useState(searchParams.cabin || '');
  const [passengers, setPassengers] = useState(searchParams.passengers || 1);

  const handleSwapAirports = () => {
    const temp = origin;
    setOrigin(destination);
    setDestination(temp);
  };

  const handleClearFilters = () => {
    setOrigin('');
    setDestination('');
    setDepartureDate('');
    setCabin('');
    setPassengers(1);
    setSearchParams({});
    if (onSearch) {
      onSearch({});
    } else {
      navigate('/flights/search');
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const query = {};
    if (origin) query.origin = origin.toUpperCase();
    if (destination) query.destination = destination.toUpperCase();
    if (departureDate) query.departureDate = departureDate;
    if (cabin) query.cabin = cabin;
    if (passengers > 1) query.passengers = Number(passengers);

    setSearchParams(query);

    const queryParams = new URLSearchParams();
    if (query.origin) queryParams.set('origin', query.origin);
    if (query.destination) queryParams.set('destination', query.destination);
    if (query.departureDate) queryParams.set('departureDate', query.departureDate);
    if (query.cabin) queryParams.set('cabin', query.cabin);
    if (query.passengers) queryParams.set('passengers', String(query.passengers));

    const targetUrl = `/flights/search${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

    if (onSearch) {
      onSearch(query);
    } else {
      navigate(targetUrl);
    }
  };

  const hasActiveFilters = Boolean(origin || destination || departureDate || cabin || passengers > 1);

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        backgroundColor: compact ? 'var(--bg-surface)' : 'var(--bg-glass-card)',
        backdropFilter: compact ? 'none' : 'blur(20px)',
        WebkitBackdropFilter: compact ? 'none' : 'blur(20px)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-xl)',
        padding: compact ? '1.25rem' : '1.75rem',
        boxShadow: compact ? 'var(--shadow-md)' : 'var(--shadow-lg)',
      }}
    >
      {/* Popular Route Preset Pills & All Flights Quick Select */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: '700' }}>
            Quick Routes:
          </span>
          {[
            { orig: '', dest: '', label: '🌐 All Flights (No Filter)' },
            { orig: 'ISB', dest: 'LHR', label: 'Islamabad → London' },
            { orig: 'JFK', dest: 'LHR', label: 'New York → London' },
            { orig: 'DXB', dest: 'SIN', label: 'Dubai → Singapore' },
            { orig: 'KHI', dest: 'DXB', label: 'Karachi → Dubai' },
          ].map((p, idx) => {
            const isSelected = origin === p.orig && destination === p.dest;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  setOrigin(p.orig);
                  setDestination(p.dest);
                  if (p.orig === '' && p.dest === '') {
                    setDepartureDate('');
                    setCabin('');
                  }
                }}
                style={{
                  padding: '4px 12px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: isSelected ? 'var(--accent-primary)' : '#f1f5f9',
                  border: '1px solid',
                  borderColor: isSelected ? 'var(--accent-primary)' : '#cbd5e1',
                  color: isSelected ? '#ffffff' : '#334155',
                  fontSize: '0.8rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleClearFilters}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '3px 10px',
              borderRadius: 'var(--radius-full)',
              backgroundColor: '#f1f5f9',
              border: '1px solid #cbd5e1',
              color: '#475569',
              fontSize: '0.76rem',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
            }}
          >
            <RotateCcw size={12} />
            Reset All Filters
          </button>
        )}
      </div>

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
            style={{
              width: '100%',
              backgroundColor: '#ffffff',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: '#0f172a',
              fontSize: '0.92rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="" style={{ backgroundColor: '#ffffff', color: '#0f172a', fontWeight: '700' }}>
              🌐 All Origins (Any Departure)
            </option>
            {AIRPORTS.map((a) => (
              <option key={a.code} value={a.code} style={{ backgroundColor: '#ffffff', color: '#0f172a' }}>
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
            style={{
              width: '100%',
              backgroundColor: '#ffffff',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: '#0f172a',
              fontSize: '0.92rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="" style={{ backgroundColor: '#ffffff', color: '#0f172a', fontWeight: '700' }}>
              🌐 All Destinations (Any Arrival)
            </option>
            {AIRPORTS.map((a) => (
              <option key={a.code} value={a.code} style={{ backgroundColor: '#ffffff', color: '#0f172a' }}>
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
            Departure Date <span style={{ fontSize: '0.72rem', textTransform: 'none', color: 'var(--text-muted)' }}>(Optional)</span>
          </label>
          <input
            type="date"
            value={departureDate}
            onChange={(e) => setDepartureDate(e.target.value)}
            style={{
              width: '100%',
              backgroundColor: '#ffffff',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.65rem 0.85rem',
              color: '#0f172a',
              fontSize: '0.92rem',
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
              backgroundColor: '#ffffff',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: '#0f172a',
              fontSize: '0.92rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="" style={{ backgroundColor: '#ffffff', color: '#0f172a', fontWeight: '700' }}>
              All Cabin Classes
            </option>
            {CABINS.map((c) => (
              <option key={c} value={c} style={{ backgroundColor: '#ffffff', color: '#0f172a' }}>
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
              backgroundColor: '#ffffff',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.7rem 0.85rem',
              color: '#0f172a',
              fontSize: '0.92rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <option key={n} value={n} style={{ backgroundColor: '#ffffff', color: '#0f172a' }}>
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
