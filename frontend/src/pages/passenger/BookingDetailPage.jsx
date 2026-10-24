import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Plane, Calendar, User, Clock, ShieldCheck, ArrowLeft, XCircle, Printer } from 'lucide-react';
import { bookingsApi } from '../../api/bookings';
import { formatDate, formatTime, formatCurrency } from '../../utils/formatters';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Alert from '../../components/ui/Alert';
import CancelModal from '../../components/bookings/CancelModal';

export default function BookingDetailPage() {
  const { bookingId } = useParams();
  const navigate = useNavigate();

  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const loadBooking = async () => {
    setLoading(true);
    try {
      const res = await bookingsApi.getBooking(bookingId);
      if (res.success) setBooking(res.data);
    } catch (err) {
      setError(err.message || 'Unable to retrieve booking.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBooking();
  }, [bookingId]);

  const handleConfirmCancel = async (id, reason) => {
    setCancelling(true);
    try {
      const res = await bookingsApi.cancelBooking(id, reason);
      if (res.success) {
        setCancelModalOpen(false);
        loadBooking();
      }
    } catch (err) {
      console.error(err);
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      <div>
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

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '1.75rem',
        }}
      >
        <div>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Confirmed Ticket Ref
          </span>
          <h1
            style={{
              fontSize: '2rem',
              fontWeight: '800',
              fontFamily: 'var(--font-mono)',
              color: 'var(--accent-cyan)',
              margin: '0.2rem 0',
            }}
          >
            {booking.bookingReference}
          </h1>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
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

          <Button variant="secondary" size="md" icon={Printer} onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>

      {/* Saga State Timeline */}
      <div
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '1.75rem',
        }}
      >
        <h3 style={{ fontSize: '1.05rem', marginBottom: '1.25rem' }}>
          Booking Saga Lifecycle State
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
            { step: '1', title: 'Hold Placed', sub: 'Inventory decremented', done: true },
            { step: '2', title: 'Payment Authorized', sub: 'Gateway verified', done: true },
            { step: '3', title: 'Payment Captured', sub: 'Funds settled', done: booking.status === 'CONFIRMED' },
            { step: '4', title: 'Ticket Confirmed', sub: 'Seat recorded in Citus', done: booking.status === 'CONFIRMED' },
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

      {/* Flight Detail Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.5fr 1fr',
          gap: '1.5rem',
        }}
      >
        <div
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
          }}
        >
          <h3 style={{ fontSize: '1.1rem' }}>Flight Information</h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '1.5rem', fontWeight: '800' }}>{booking.origin}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{formatTime(booking.departureTime)}</div>
            </div>
            <Plane size={20} style={{ color: 'var(--accent-primary)' }} />
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1.5rem', fontWeight: '800' }}>{booking.destination}</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{formatTime(booking.arrivalTime)}</div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
            <div>Flight Number: <strong style={{ color: 'var(--text-primary)' }}>{booking.airlineCode} {booking.flightNumber}</strong></div>
            <div>Aircraft: <strong style={{ color: 'var(--text-primary)' }}>{booking.aircraftType}</strong></div>
            <div>Date of Travel: <strong style={{ color: 'var(--text-primary)' }}>{formatDate(booking.departureDate)}</strong></div>
          </div>
        </div>

        <div
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
          }}
        >
          <h3 style={{ fontSize: '1.1rem' }}>Passenger & Fare</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
            <div>Name: <strong style={{ color: 'var(--text-primary)' }}>{booking.passengerName}</strong></div>
            <div>Traveler ID: <strong style={{ color: 'var(--text-primary)' }}>{booking.passengerRef}</strong></div>
            <div>Assigned Seat: <strong style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', fontSize: '1.1rem' }}>{booking.seatNumber}</strong></div>
            <div>Cabin: <strong style={{ color: 'var(--text-primary)' }}>{booking.cabin}</strong></div>
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '0.75rem', marginTop: '0.5rem', fontSize: '1.1rem', fontWeight: '800', color: 'var(--text-primary)' }}>
              Total Paid: <span style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>{formatCurrency(booking.price, booking.currency)}</span>
            </div>
          </div>
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
