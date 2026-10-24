import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Plane, ShieldCheck, Lock, CreditCard, AlertCircle, ArrowRight } from 'lucide-react';
import { flightsApi } from '../../api/flights';
import { bookingsApi } from '../../api/bookings';
import { useAuthStore } from '../../stores/authStore';
import { formatCurrency, formatTime, formatDate } from '../../utils/formatters';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Alert from '../../components/ui/Alert';

export default function BookingCheckoutPage() {
  const { flightId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const cabin = searchParams.get('cabin') || 'ECONOMY';
  const preSelectedSeat = searchParams.get('seat') || '';

  const [flight, setFlight] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Form Fields
  const [passengerName, setPassengerName] = useState(user?.fullName || '');
  const [passengerRef, setPassengerRef] = useState('PASS-' + Math.floor(1000 + Math.random() * 9000));
  const [seatNumber, setSeatNumber] = useState(preSelectedSeat || '14A');
  const [contactEmail, setContactEmail] = useState(user?.email || '');
  const [contactPhone, setContactPhone] = useState(user?.phone || '');

  // Stable Idempotency Key per checkout session
  const [idempotencyKey] = useState(() => {
    return 'idem-' + Math.random().toString(36).substring(2, 12) + '-' + Date.now();
  });

  useEffect(() => {
    async function loadFlight() {
      try {
        const res = await flightsApi.getFlight(flightId);
        if (res.success) setFlight(res.data);
      } catch (err) {
        setError(err.message || 'Unable to load flight for checkout.');
      } finally {
        setLoading(false);
      }
    }
    loadFlight();
  }, [flightId]);

  const cabinInfo = flight?.cabins?.find((c) => c.cabin === cabin) || flight?.cabins?.[0] || {};
  const fare = cabinInfo.price || flight?.basePrice || 650;
  const taxes = Math.round(fare * 0.12);
  const total = fare + taxes;

  const handleConfirmBooking = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload = {
        flightId,
        cabin,
        seatNumber: seatNumber.trim().toUpperCase(),
        passengerName,
        passengerRef,
        contactEmail,
        contactPhone,
        expectedVersion: cabinInfo.version ?? undefined,
      };

      const res = await bookingsApi.createBooking(payload, idempotencyKey);
      if (res.success && res.data) {
        navigate(`/bookings/${res.data.bookingId}/confirmation`);
      }
    } catch (err) {
      setError(
        err.error?.message ||
          err.message ||
          'Failed to reserve seat. The seat may have been booked by a concurrent transaction. Please select another seat.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '6rem 0' }}>
        <Spinner size="lg" label="Preparing booking ledger..." />
      </div>
    );
  }

  if (error && !flight) {
    return (
      <div style={{ maxWidth: '600px', margin: '4rem auto' }}>
        <Alert variant="danger">{error}</Alert>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', maxWidth: '1080px', margin: '0 auto' }}>
      <div>
        <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
          Flight Reservation & Passenger Details
        </h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Review itinerary and confirm passenger credentials. An idempotent booking reservation will be placed.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.6fr 1.1fr',
          gap: '2rem',
          alignItems: 'start',
        }}
      >
        {/* Passenger Information Form */}
        <form
          onSubmit={handleConfirmBooking}
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '2rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1.15rem', fontWeight: '700' }}>Traveler Information</h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Must match government-issued identification
            </span>
          </div>

          {error && <Alert variant="danger">{error}</Alert>}

          <Input
            label="Passenger Full Legal Name"
            required
            placeholder="e.g. Ada Lovelace"
            value={passengerName}
            onChange={(e) => setPassengerName(e.target.value)}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Input
              label="Passenger Travel ID / Ref"
              placeholder="e.g. PASS-9001"
              value={passengerRef}
              onChange={(e) => setPassengerRef(e.target.value)}
              helper="Frequent flyer or identity code"
            />

            <Input
              label="Seat Number"
              required
              placeholder="e.g. 14A"
              value={seatNumber}
              onChange={(e) => setSeatNumber(e.target.value.toUpperCase())}
              helper="From cabin seat configuration"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Input
              label="Contact Email"
              type="email"
              required
              placeholder="passenger@example.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />

            <Input
              label="Contact Phone"
              type="tel"
              placeholder="+1-555-0199"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
            />
          </div>

          {/* Idempotency assurance box */}
          <div
            style={{
              padding: '1rem',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.75rem',
              fontSize: '0.82rem',
              color: 'var(--text-secondary)',
            }}
          >
            <ShieldCheck size={18} style={{ color: 'var(--status-success)', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>Idempotency Protection Active:</strong>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                Key: {idempotencyKey}
              </div>
              Retries will replay the original reservation safely without duplicate seat charges.
            </div>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            icon={Lock}
            style={{ width: '100%', marginTop: '0.5rem' }}
          >
            Authorize Payment & Confirm Reservation ({formatCurrency(total, flight?.currency)})
          </Button>
        </form>

        {/* Sidebar Summary */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Flight Recap Card */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}
          >
            <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Flight Itinerary
              </div>
              <div style={{ fontSize: '1.15rem', fontWeight: '700', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                {flight?.airlineCode} {flight?.flightNumber}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '1.25rem', fontWeight: '800' }}>{flight?.origin}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{formatTime(flight?.departureTime)}</div>
              </div>
              <Plane size={16} style={{ color: 'var(--accent-primary)' }} />
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '1.25rem', fontWeight: '800' }}>{flight?.destination}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{formatTime(flight?.arrivalTime)}</div>
              </div>
            </div>

            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Date: <strong style={{ color: 'var(--text-primary)' }}>{formatDate(flight?.departureDate)}</strong>
            </div>

            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Cabin: <strong style={{ color: 'var(--accent-cyan)' }}>{cabin.replace('_', ' ')}</strong>
            </div>

            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Aircraft: <strong style={{ color: 'var(--text-primary)' }}>{flight?.aircraftType}</strong>
            </div>
          </div>

          {/* Pricing Breakdown Card */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.5rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ fontSize: '0.95rem', fontWeight: '700', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem' }}>
              Price Breakdown
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
              <span>Base Airfare (1 Passenger)</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(fare, flight?.currency)}</span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
              <span>Aviation Security & Airport Taxes</span>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{formatCurrency(taxes, flight?.currency)}</span>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '1.15rem',
                fontWeight: '800',
                color: 'var(--text-primary)',
                borderTop: '1px solid var(--border-color)',
                paddingTop: '0.75rem',
                marginTop: '0.25rem',
              }}
            >
              <span>Total Amount</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>
                {formatCurrency(total, flight?.currency)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
