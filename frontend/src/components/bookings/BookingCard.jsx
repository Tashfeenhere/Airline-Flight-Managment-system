import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plane, Calendar, Clock, User, ArrowRight, XCircle, Printer, Ticket, Check, Copy, ExternalLink, ShieldCheck } from 'lucide-react';
import { formatDate, formatTime, formatCurrency } from '../../utils/formatters';
import Badge from '../ui/Badge';
import Button from '../ui/Button';

export default function BookingCard({ booking, onCancelRequest }) {
  const [copied, setCopied] = useState(false);
  const isCancellable = booking.status === 'CONFIRMED' || booking.status === 'PENDING';

  const handleCopyRef = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (booking?.bookingReference) {
      navigator.clipboard.writeText(booking.bookingReference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      style={{
        backgroundColor: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '16px',
        overflow: 'hidden',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#93c5fd';
        e.currentTarget.style.boxShadow = '0 6px 20px rgba(29, 78, 216, 0.08)';
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#e2e8f0';
        e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.04)';
        e.currentTarget.style.transform = 'none';
      }}
    >
      {/* Top Strip: Airline Header & Status */}
      <div
        style={{
          background: 'linear-gradient(90deg, #f8fafc 0%, #f1f5f9 100%)',
          borderBottom: '1px solid #e2e8f0',
          padding: '0.85rem 1.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '7px',
              backgroundColor: '#1d4ed8',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Plane size={15} />
          </div>
          <div>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '0.92rem', color: '#0f172a' }}>
              {booking.airlineCode || 'AERO'} {booking.flightNumber}
            </span>
            <span style={{ fontSize: '0.74rem', color: '#64748b', marginLeft: '0.5rem' }}>
              • Distributed Citus Flight
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <span
            style={{
              fontSize: '0.74rem',
              fontWeight: 700,
              color: '#475569',
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              padding: '2px 8px',
              borderRadius: '6px',
            }}
          >
            {booking.cabin || 'ECONOMY'}
          </span>
          <Badge status={booking.status} />
        </div>
      </div>

      {/* Main Ticket Body: Two-Section Boarding Pass Design */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 260px',
          alignItems: 'stretch',
        }}
        className="ticket-grid-responsive"
      >
        {/* Left Section: Flight Details & Passenger */}
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '1.25rem' }}>
          {/* Origin -> Destination Route Banner */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#0f172a', fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
                {booking.origin || 'ISB'}
              </div>
              <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '3px' }}>Departure</div>
            </div>

            <div style={{ flex: 1, minWidth: '120px', maxWidth: '200px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontSize: '0.7rem', color: '#1d4ed8', fontWeight: 700, letterSpacing: '0.04em' }}>
                DIRECT FLIGHT
              </span>
              <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#1d4ed8' }} />
                <div style={{ flex: 1, height: '2px', background: 'linear-gradient(90deg, #1d4ed8, #0284c7)', borderStyle: 'dashed' }} />
                <Plane size={14} color="#0284c7" />
                <div style={{ flex: 1, height: '2px', background: 'linear-gradient(90deg, #0284c7, #1d4ed8)' }} />
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#1d4ed8' }} />
              </div>
              <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>Real-Time Ledger</span>
            </div>

            <div>
              <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#0f172a', fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
                {booking.destination || 'DXB'}
              </div>
              <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '3px' }}>Arrival</div>
            </div>
          </div>

          {/* Passenger, Date, Seat Meta Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '0.85rem',
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              padding: '0.85rem 1rem',
            }}
          >
            <div>
              <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>
                Passenger
              </span>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#0f172a', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <User size={13} color="#1d4ed8" />
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {booking.passengerName || 'Verified Traveler'}
                </span>
              </div>
            </div>

            <div>
              <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>
                Departure Date
              </span>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#0f172a', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Calendar size={13} color="#1d4ed8" />
                <span>{formatDate(booking.departureDate)}</span>
              </div>
            </div>

            <div>
              <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>
                Departure Time
              </span>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#0f172a', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Clock size={13} color="#1d4ed8" />
                <span>{formatTime(booking.departureTime)}</span>
              </div>
            </div>

            <div>
              <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>
                Assigned Seat
              </span>
              <div style={{ marginTop: '2px' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 800,
                    fontSize: '0.88rem',
                    color: '#1d4ed8',
                    backgroundColor: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    padding: '1px 8px',
                    borderRadius: '5px',
                    display: 'inline-block',
                  }}
                >
                  {booking.seatNumber || 'Allocated'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Section: Boarding Pass Stub & Quick Actions */}
        <div
          style={{
            borderLeft: '1px dashed #cbd5e1',
            backgroundColor: '#fafafa',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: '1rem',
            position: 'relative',
          }}
        >
          {/* Half-circle cutouts on top and bottom of dashed line for realistic boarding pass ticket look */}
          <div
            style={{
              position: 'absolute',
              top: '-10px',
              left: '-10px',
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              zIndex: 1,
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: '-10px',
              left: '-10px',
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              zIndex: 1,
            }}
          />

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.68rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>
                Booking Reference
              </span>
              <button
                onClick={handleCopyRef}
                title="Copy reference code"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  color: copied ? '#059669' : '#64748b',
                  fontSize: '0.7rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3px',
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '1.25rem',
                fontWeight: 800,
                color: '#1d4ed8',
                letterSpacing: '0.04em',
              }}
            >
              {booking.bookingReference}
            </div>

            {booking.totalAmount && (
              <div style={{ marginTop: '0.45rem', fontSize: '0.85rem', color: '#0f172a', fontWeight: 700 }}>
                Paid: <span style={{ color: '#059669', fontFamily: 'var(--font-mono)' }}>{formatCurrency(booking.totalAmount, booking.currency)}</span>
              </div>
            )}

            {/* Stylized Simulated Barcode Stripes */}
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '2px', height: '26px', opacity: 0.65 }}>
              {[3, 1, 4, 1, 2, 5, 1, 3, 2, 4, 1, 2, 3, 1, 4, 2, 1, 3, 1, 2, 4, 1].map((w, idx) => (
                <div key={idx} style={{ width: `${w}px`, height: '100%', backgroundColor: '#334155' }} />
              ))}
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <Link
              to={`/bookings/${booking.bookingId}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                backgroundColor: '#1d4ed8',
                color: '#ffffff',
                padding: '0.55rem 0.85rem',
                borderRadius: '8px',
                fontSize: '0.82rem',
                fontWeight: 700,
                textDecoration: 'none',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#1e40af'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#1d4ed8'; }}
            >
              <Ticket size={14} />
              <span>View E-Ticket & Pass</span>
            </Link>

            <div style={{ display: 'flex', gap: '0.45rem' }}>
              <Link
                to={`/bookings/${booking.bookingId}?print=true`}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px',
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  color: '#334155',
                  padding: '0.45rem 0.6rem',
                  borderRadius: '7px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textDecoration: 'none',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
              >
                <Printer size={13} />
                <span>Print</span>
              </Link>

              {isCancellable && onCancelRequest && (
                <button
                  onClick={() => onCancelRequest(booking)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #fecaca',
                    color: '#dc2626',
                    padding: '0.45rem 0.6rem',
                    borderRadius: '7px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fef2f2'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
                >
                  <XCircle size={13} />
                  <span>Cancel</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
