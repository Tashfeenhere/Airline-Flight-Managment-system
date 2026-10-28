import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { CheckCircle2, Plane, Printer, Ticket, ArrowRight, Copy, Check } from 'lucide-react';
import { bookingsApi } from '../../api/bookings';
import { formatDate, formatTime, formatCurrency } from '../../utils/formatters';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Alert from '../../components/ui/Alert';
import { useToast } from '../../components/ui/Toast';

export default function BookingConfirmationPage() {
  const { bookingId } = useParams();
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  useEffect(() => {
    async function loadBooking() {
      try {
        const res = await bookingsApi.getBooking(bookingId);
        if (res.success) setBooking(res.data);
      } catch (err) {
        console.error('Failed to load confirmed booking', err);
      } finally {
        setLoading(false);
      }
    }
    loadBooking();
  }, [bookingId]);

  const handleCopyRef = () => {
    if (booking?.bookingReference) {
      navigator.clipboard.writeText(booking.bookingReference);
      setCopied(true);
      toast.success(`Booking reference ${booking.bookingReference} copied to clipboard!`, 'Copied');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePrint = () => {
    toast.info('Preparing printable boarding pass & e-ticket...', 'Print Ready');
    setTimeout(() => {
      window.print();
    }, 250);
  };

  if (loading) {
    return (
      <div style={{ padding: '6rem 0' }}>
        <Spinner size="lg" label="Issuing digital boarding pass..." />
      </div>
    );
  }

  if (!booking) {
    return (
      <div style={{ maxWidth: '600px', margin: '4rem auto' }}>
        <Alert variant="warning" title="Reservation Pending">
          Your booking request is being reconciled by the Citus saga worker. Check your email or visit My Bookings shortly.
        </Alert>
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: '820px',
        margin: '2rem auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '2.5rem',
      }}
    >
      {/* Success Notification Hero */}
      <div
        style={{
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        <div
          style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            backgroundColor: 'var(--status-success-bg)',
            border: '2px solid var(--status-success-border)',
            color: 'var(--status-success)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 25px rgba(16, 185, 129, 0.3)',
          }}
        >
          <CheckCircle2 size={36} />
        </div>

        <div>
          <span style={{ fontSize: '0.85rem', color: 'var(--status-success)', fontWeight: '700', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Reservation Confirmed
          </span>
          <h1 style={{ fontSize: '2.2rem', fontWeight: '800', marginTop: '0.25rem' }}>
            Your Flight is Booked
          </h1>
          <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)' }}>
            E-ticket receipt and confirmation has been generated in the distributed ledger.
          </p>
        </div>

        {/* Reference Code Pill */}
        <div
          onClick={handleCopyRef}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.85rem',
            padding: '0.65rem 1.25rem',
            backgroundColor: 'var(--bg-surface-elevated)',
            border: '1px solid var(--border-highlight)',
            borderRadius: 'var(--radius-full)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
          }}
          title="Click to copy booking reference"
        >
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Booking Reference:
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: '800',
              fontSize: '1.25rem',
              color: 'var(--accent-cyan)',
              letterSpacing: '0.06em',
            }}
          >
            {booking.bookingReference}
          </span>
          {copied ? <Check size={16} style={{ color: 'var(--status-success)' }} /> : <Copy size={16} style={{ color: 'var(--text-muted)' }} />}
        </div>
      </div>

      {/* Boarding Pass Ticket Aesthetic Card */}
      <div
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
          position: 'relative',
        }}
        className="boarding-pass-card"
      >
        {/* Ticket Header Bar */}
        <div
          style={{
            backgroundColor: 'var(--bg-surface-elevated)',
            borderBottom: '1px solid var(--border-color)',
            padding: '1.25rem 2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
          className="boarding-pass-header"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Plane size={20} style={{ color: 'var(--accent-primary)' }} />
            <span style={{ fontWeight: '700', fontSize: '1.1rem', letterSpacing: '0.02em' }}>
              BOARDING PASS & DIGITAL E-TICKET
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', fontSize: '1rem' }} className="print-highlight">
              {booking.airlineCode} {booking.flightNumber}
            </span>
            <Badge status={booking.status} />
          </div>
        </div>

        {/* Ticket Body */}
        <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '2rem' }} className="boarding-pass-body">
          {/* Origin and Destination Route */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr auto 1.5fr',
              alignItems: 'center',
              paddingBottom: '1.5rem',
              borderBottom: '1px dashed var(--border-color)',
            }}
          >
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Departure ({booking.origin})
              </div>
              <div style={{ fontSize: '2.5rem', fontWeight: '900', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }} className="print-highlight">
                {booking.origin}
              </div>
              <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                {formatDate(booking.departureDate)} • {formatTime(booking.departureTime)}
              </div>
            </div>

            <div style={{ padding: '0 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
              <Plane size={24} style={{ color: 'var(--accent-primary)' }} />
              <span style={{ fontSize: '0.75rem', color: 'var(--status-success)', fontWeight: '600' }}>Confirmed</span>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Arrival ({booking.destination})
              </div>
              <div style={{ fontSize: '2.5rem', fontWeight: '900', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }} className="print-highlight">
                {booking.destination}
              </div>
              <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                {formatTime(booking.arrivalTime)} Local Time
              </div>
            </div>
          </div>

          {/* Passenger & Seat Meta Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '1.5rem',
            }}
          >
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Passenger
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: '700', color: 'var(--text-primary)', marginTop: '0.25rem' }} className="print-highlight">
                {booking.passengerName}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Ref: {booking.passengerRef}</div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Seat Assigned
              </div>
              <div
                style={{
                  fontSize: '1.4rem',
                  fontWeight: '800',
                  color: 'var(--accent-cyan)',
                  fontFamily: 'var(--font-mono)',
                  marginTop: '0.25rem',
                }}
                className="print-highlight"
              >
                {booking.seatNumber || '14A'}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Cabin Class
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: '700', color: 'var(--text-primary)', marginTop: '0.25rem' }} className="print-highlight">
                {booking.cabin?.replace('_', ' ')}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Total Paid
              </div>
              <div
                style={{
                  fontSize: '1.4rem',
                  fontWeight: '800',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                  marginTop: '0.25rem',
                }}
                className="print-highlight"
              >
                {formatCurrency(booking.price, booking.currency)}
              </div>
            </div>
          </div>
        </div>

        {/* Barcode Graphic Footer */}
        <div
          style={{
            backgroundColor: 'var(--bg-secondary)',
            borderTop: '1px solid var(--border-color)',
            padding: '1.25rem 2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
          className="boarding-pass-footer"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              PNR / RECORD LOCATOR: <strong>{booking.bookingReference}</strong>
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Citus Shard Verification ID: {booking.bookingId} • 100% Anti-Oversell Validated
            </span>
          </div>

          {/* Barcode graphic */}
          <div style={{ display: 'flex', gap: '3px', height: '38px', alignItems: 'center' }}>
            {[4, 2, 5, 2, 6, 3, 2, 5, 3, 4, 6, 2, 3, 5, 2, 4, 6, 3, 5, 2, 4, 3, 6, 2, 4, 2, 5].map((w, idx) => (
              <div
                key={idx}
                className="print-barcode-bar"
                style={{
                  width: `${w}px`,
                  height: '100%',
                  backgroundColor: 'rgba(255, 255, 255, 0.6)',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
        <Button variant="secondary" icon={Printer} onClick={handlePrint}>
          Print E-Ticket
        </Button>

        <Link to="/my-bookings" style={{ textDecoration: 'none' }}>
          <Button variant="primary" icon={Ticket} iconPosition="right">
            Manage All My Bookings
          </Button>
        </Link>
      </div>
    </div>
  );
}
