import React from 'react';
import { Link } from 'react-router-dom';
import { Plane, Clock, ArrowRight, ShieldCheck, AlertCircle } from 'lucide-react';
import { formatCurrency, formatTime, calculateDuration } from '../../utils/formatters';
import Badge from '../ui/Badge';
import Button from '../ui/Button';

export default function FlightCard({ flight, requestedCabin = 'ECONOMY', passengers = 1 }) {
  const effectiveCabin = requestedCabin || 'ECONOMY';
  const currentCabin =
    flight.cabins?.find((c) => c.cabin === effectiveCabin) || flight.cabins?.[0] || {};

  const availableSeats = currentCabin.available ?? 0;
  const isSoldOut = availableSeats < passengers;
  const isLowInventory = availableSeats > 0 && availableSeats <= 5;
  const price = currentCabin.price || flight.basePrice || flight.lowestPrice;
  const totalPrice = price * passengers;

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)',
        padding: '1.5rem',
        boxShadow: 'var(--shadow-md)',
        transition: 'border-color var(--transition-fast), transform var(--transition-fast)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
      }}
      className="flight-card-interactive"
    >
      {/* Header bar: Airline & Status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border-subtle)',
          paddingBottom: '0.85rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              padding: '0.35rem 0.65rem',
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)',
              fontWeight: '700',
              fontSize: '0.9rem',
              color: 'var(--text-primary)',
              letterSpacing: '0.04em',
            }}
          >
            {flight.airlineCode} {flight.flightNumber}
          </div>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            {flight.aircraftType}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Badge status={flight.status || 'SCHEDULED'} size="sm" />
          {isLowInventory && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                fontSize: '0.75rem',
                color: 'var(--status-warning)',
                fontWeight: '600',
              }}
            >
              <AlertCircle size={13} /> Only {availableSeats} left
            </span>
          )}
        </div>
      </div>

      {/* Main Body: Times, Origin, Destination, Duration */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1.6fr 1.2fr 1.4fr',
          gap: '1.5rem',
          alignItems: 'center',
        }}
      >
        {/* Origin */}
        <div>
          <div
            style={{
              fontSize: '1.6rem',
              fontWeight: '800',
              color: 'var(--text-primary)',
              lineHeight: 1.1,
            }}
          >
            {formatTime(flight.departureTime)}
          </div>
          <div
            style={{
              fontSize: '1rem',
              fontWeight: '600',
              color: 'var(--accent-cyan)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {flight.origin}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            {flight.departureDate}
          </div>
        </div>

        {/* Flight Path Graphic */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <Clock size={13} />
            {calculateDuration(flight.departureTime, flight.arrivalTime)}
          </div>

          <div
            style={{
              position: 'relative',
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '2px',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                position: 'relative',
              }}
            />
            <div
              style={{
                position: 'absolute',
                color: 'var(--accent-primary)',
                backgroundColor: 'var(--bg-surface)',
                padding: '0 0.4rem',
              }}
            >
              <Plane size={15} />
            </div>
          </div>

          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--status-success)',
              fontWeight: '500',
              letterSpacing: '0.04em',
            }}
          >
            Direct / Non-stop
          </div>
        </div>

        {/* Destination */}
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: '1.6rem',
              fontWeight: '800',
              color: 'var(--text-primary)',
              lineHeight: 1.1,
            }}
          >
            {formatTime(flight.arrivalTime)}
          </div>
          <div
            style={{
              fontSize: '1rem',
              fontWeight: '600',
              color: 'var(--accent-cyan)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {flight.destination}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Arrival Local
          </div>
        </div>

        {/* Price & CTA */}
        <div
          style={{
            borderLeft: '1px solid var(--border-subtle)',
            paddingLeft: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: '0.5rem',
          }}
        >
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              {(currentCabin.cabin || effectiveCabin).replace('_', ' ')}
            </span>
            <div
              style={{
                fontSize: '1.5rem',
                fontWeight: '800',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {formatCurrency(price, flight.currency)}
            </div>
            {passengers > 1 && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Total: {formatCurrency(totalPrice, flight.currency)} ({passengers} pax)
              </div>
            )}
          </div>

          <Link
            to={`/flights/${flight.flightId}?cabin=${currentCabin.cabin || effectiveCabin}`}
            style={{ width: '100%', textDecoration: 'none' }}
          >
            <Button
              variant={isSoldOut ? 'outline' : 'primary'}
              disabled={isSoldOut}
              size="sm"
              icon={ArrowRight}
              iconPosition="right"
              style={{ width: '100%' }}
            >
              {isSoldOut ? 'Sold Out' : 'Select Flight'}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
