import React from 'react';
import { Link } from 'react-router-dom';
import { Plane, Calendar, User, ArrowRight, XCircle } from 'lucide-react';
import { formatDate, formatTime, formatCurrency } from '../../utils/formatters';
import Badge from '../ui/Badge';
import Button from '../ui/Button';

export default function BookingCard({ booking, onCancelRequest }) {
  const isCancellable = booking.status === 'CONFIRMED' || booking.status === 'PENDING';

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)',
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {/* Top Header: Reference & Status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border-subtle)',
          paddingBottom: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Booking Ref:
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: '700',
              fontSize: '1.05rem',
              color: 'var(--accent-cyan)',
              letterSpacing: '0.05em',
            }}
          >
            {booking.bookingReference}
          </span>
        </div>

        <Badge status={booking.status} />
      </div>

      {/* Flight Details Row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.5fr 1fr 1fr auto',
          gap: '1.5rem',
          alignItems: 'center',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: '700',
                fontSize: '1rem',
                color: 'var(--text-primary)',
              }}
            >
              {booking.airlineCode} {booking.flightNumber}
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              ({booking.origin} → {booking.destination})
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <Calendar size={14} />
            <span>{formatDate(booking.departureDate)}</span>
            <span>•</span>
            <span>{formatTime(booking.departureTime)}</span>
          </div>
        </div>

        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Passenger & Seat
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.2rem' }}>
            <User size={14} style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontSize: '0.9rem', fontWeight: '500', color: 'var(--text-primary)' }}>
              {booking.passengerName}
            </span>
          </div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>
            Seat: <strong style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)' }}>{booking.seatNumber || 'Unassigned'}</strong> ({booking.cabin})
          </div>
        </div>

        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Fare Amount
          </div>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: '800',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              marginTop: '0.2rem',
            }}
          >
            {formatCurrency(booking.price, booking.currency)}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Link to={`/bookings/${booking.bookingId}`} style={{ textDecoration: 'none' }}>
            <Button variant="secondary" size="sm" icon={ArrowRight} iconPosition="right">
              View Ticket
            </Button>
          </Link>

          {isCancellable && (
            <Button
              variant="danger"
              size="sm"
              icon={XCircle}
              onClick={() => onCancelRequest && onCancelRequest(booking)}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
