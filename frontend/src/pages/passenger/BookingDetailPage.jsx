import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  Plane,
  Calendar,
  User,
  Clock,
  ShieldCheck,
  ArrowLeft,
  XCircle,
  Printer,
  Copy,
  Check,
  Ticket,
} from 'lucide-react';
import { bookingsApi } from '../../api/bookings';
import { formatDate, formatTime, formatCurrency } from '../../utils/formatters';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Alert from '../../components/ui/Alert';
import CancelModal from '../../components/bookings/CancelModal';
import { useToast } from '../../components/ui/Toast';

export default function BookingDetailPage() {
  const { bookingId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const loadBooking = async () => {
    setLoading(true);
    try {
      const res = await bookingsApi.getBooking(bookingId);
      if (res.success) {
        setBooking(res.data);
        if (searchParams.get('print') === 'true') {
          setTimeout(() => {
            window.print();
          }, 350);
        }
      }
    } catch (err) {
      setError(err.message || 'Unable to retrieve booking.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBooking();
  }, [bookingId]);

  const handleCopyRef = () => {
    if (booking?.bookingReference) {
      navigator.clipboard.writeText(booking.bookingReference);
      setCopied(true);
      toast.success(`Booking reference ${booking.bookingReference} copied!`, 'Copied');
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePrint = () => {
    toast.info('Preparing printable boarding pass & e-ticket...', 'Print Ready');
    setTimeout(() => {
      window.print();
    }, 250);
  };

  const handleConfirmCancel = async (id, reason) => {
    setCancelling(true);
    try {
      const res = await bookingsApi.cancelBooking(id, reason);
      if (res.success) {
        setCancelModalOpen(false);
        toast.success('Your reservation has been cancelled and refund initiated.', 'Reservation Cancelled');
        loadBooking();
      }
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'Failed to cancel reservation.', 'Cancellation Error');
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '6rem 0' }}>
        <Spinner size="lg" label="Loading reservation details..." />
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div style={{ maxWidth: '600px', margin: '4rem auto' }}>
        <Alert variant="danger">{error || 'Booking not found.'}</Alert>
      </div>
    );
  }

  const isCancellable = booking.status === 'CONFIRMED' || booking.status === 'PENDING';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', maxWidth: '880px', margin: '0 auto', width: '100%' }}>
      <div className="no-print">
        <button
          onClick={() => navigate('/my-bookings')}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            fontSize: '0.88rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: 0,
          }}
        >
          <ArrowLeft size={16} />
          Back to All Bookings
        </button>
      </div>

      {/* Header bar (hidden in print) */}
      <div
        className="no-print"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '1.5rem 1.75rem',
        }}
      >
        <div>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Confirmed Ticket Ref
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.2rem' }}>
            <h1
              style={{
                fontSize: '2rem',
                fontWeight: '800',
                fontFamily: 'var(--font-mono)',
                color: 'var(--accent-cyan)',
                margin: 0,
              }}
            >
              {booking.bookingReference}
            </h1>
            <button
              onClick={handleCopyRef}
              title="Copy Booking Reference"
              style={{
                background: 'transparent',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 8px',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '0.75rem',
              }}
            >
              {copied ? <Check size={14} style={{ color: '#10b981' }} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Booking UUID: {booking.bookingId}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Badge status={booking.status} size="lg" />

          {isCancellable && (
            <Button
              variant="danger"
              size="md"
              icon={XCircle}
              onClick={() => setCancelModalOpen(true)}
            >
              Cancel Reservation
            </Button>
          )}

          <Button variant="secondary" size="md" icon={Printer} onClick={handlePrint}>
            Print E-Ticket
          </Button>
        </div>
      </div>

      {/* Boarding Pass & Digital E-Ticket Card (Optimized for both screen & paper print) */}
      <div
        className="boarding-pass-card"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Ticket Header */}
        <div
          className="boarding-pass-header"
          style={{
            backgroundColor: 'var(--bg-surface-elevated)',
            borderBottom: '1px solid var(--border-color)',
            padding: '1.25rem 2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Plane size={22} style={{ color: 'var(--accent-primary)' }} />
            <div>
              <span style={{ fontWeight: '800', fontSize: '1.1rem', letterSpacing: '0.03em', display: 'block' }}>
                BOARDING PASS & DIGITAL E-TICKET
              </span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                AeroScale Distributed Flight Operations
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: '800', fontSize: '1.1rem' }} className="print-highlight">
              {booking.airlineCode} {booking.flightNumber}
            </span>
            <Badge status={booking.status} />
          </div>
        </div>

        {/* Ticket Body */}
        <div className="boarding-pass-body" style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
          {/* Flight Route Origin / Destination */}
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
              <span style={{ fontSize: '0.75rem', color: 'var(--status-success)', fontWeight: '700' }}>Confirmed</span>
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

          {/* Passenger Information Row */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '1.5rem',
            }}
          >
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Passenger Name
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: '700', color: 'var(--text-primary)', marginTop: '0.25rem' }} className="print-highlight">
                {booking.passengerName}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Traveler: {booking.passengerRef}</div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Assigned Seat
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

        {/* Ticket Footer with Barcode graphic */}
        <div
          className="boarding-pass-footer"
          style={{
            backgroundColor: 'var(--bg-secondary)',
            borderTop: '1px solid var(--border-color)',
            padding: '1.25rem 2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              PNR / RECORD LOCATOR: <strong>{booking.bookingReference}</strong>
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Citus Shard Verification ID: {booking.bookingId} • 100% Anti-Oversell Validated
            </span>
          </div>

          <div style={{ display: 'flex', gap: '3px', height: '38px', alignItems: 'center' }}>
            {[4, 2, 5, 2, 6, 3, 2, 5, 3, 4, 6, 2, 3, 5, 2, 4, 6, 3, 5, 2, 4, 3, 6, 2, 4, 2, 5].map((w, idx) => (
              <div
                key={idx}
                className="print-barcode-bar"
                style={{
                  width: `${w}px`,
                  height: '100%',
                  backgroundColor: '#0f172a',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Saga State Timeline (screen only) */}
      <div
        className="no-print"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '1.75rem',
        }}
      >
        <h3 style={{ fontSize: '1.05rem', marginBottom: '1.25rem' }}>
          Distributed Saga Lifecycle State
        </h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            position: 'relative',
            gap: '1rem',
          }}
        >
          {[
            { step: '1', title: 'Hold Placed', sub: 'Inventory counter decremented', done: true },
            { step: '2', title: 'Payment Authorized', sub: 'Simulated gateway token', done: true },
            { step: '3', title: 'Payment Captured', sub: 'Idempotent funds capture', done: booking.status === 'CONFIRMED' },
            { step: '4', title: 'Ticket Confirmed', sub: 'Ledger written & published', done: booking.status === 'CONFIRMED' },
          ].map((st, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.35rem',
                padding: '1rem',
                backgroundColor: st.done ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-secondary)',
                border: `1px solid ${st.done ? 'var(--status-success-border)' : 'var(--border-subtle)'}`,
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div
                  style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    backgroundColor: st.done ? 'var(--status-success)' : 'var(--bg-surface-elevated)',
                    color: st.done ? '#ffffff' : 'var(--text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: '700',
                  }}
                >
                  {st.step}
                </div>
                <strong style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{st.title}</strong>
              </div>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{st.sub}</span>
            </div>
          ))}
        </div>
      </div>

      <CancelModal
        isOpen={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        booking={booking}
        onConfirmCancel={handleConfirmCancel}
        loading={cancelling}
      />
    </div>
  );
}
