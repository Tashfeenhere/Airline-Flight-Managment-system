import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Plane, Calendar, Clock, ArrowRight, ShieldCheck, ChevronLeft } from 'lucide-react';
import { flightsApi } from '../../api/flights';
import { useSearchStore } from '../../stores/searchStore';
import { formatTime, formatDate, calculateDuration, formatCurrency } from '../../utils/formatters';
import CabinSelector from '../../components/flights/CabinSelector';
import SeatMap from '../../components/flights/SeatMap';
import Spinner from '../../components/ui/Spinner';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';

export default function FlightDetailPage() {
  const { flightId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const initialCabin = searchParams.get('cabin') || 'ECONOMY';
  const [selectedCabin, setSelectedCabin] = useState(initialCabin);
  const [selectedSeat, setSelectedSeat] = useState(null);

  const [flight, setFlight] = useState(null);
  const [seatMapData, setSeatMapData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [seatMapLoading, setSeatMapLoading] = useState(false);
  const [error, setError] = useState(null);

  const { setSelectedSeat: saveSelectedSeat, setSelectedCabin: saveSelectedCabin } = useSearchStore();

  useEffect(() => {
    let isMounted = true;
    async function loadFlightData() {
      setLoading(true);
      setError(null);
      try {
        const [flightRes, seatMapRes] = await Promise.all([
          flightsApi.getFlight(flightId),
          flightsApi.getSeatMap(flightId, selectedCabin),
        ]);

        if (isMounted) {
          if (flightRes.success) setFlight(flightRes.data);
          if (seatMapRes.success) setSeatMapData(seatMapRes.data);
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message || 'Unable to retrieve flight details.');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadFlightData();
    return () => {
      isMounted = false;
    };
  }, [flightId]);

  // When cabin changes, reload the seat map for that cabin
  const handleCabinChange = async (newCabin) => {
    setSelectedCabin(newCabin);
    setSelectedSeat(null);
    setSeatMapLoading(true);
    try {
      const res = await flightsApi.getSeatMap(flightId, newCabin);
      if (res.success) {
        setSeatMapData(res.data);
      }
    } catch (err) {
      console.error('Failed to update seat map for cabin', err);
    } finally {
      setSeatMapLoading(false);
    }
  };

  const handleSeatSelect = (seatNum) => {
    setSelectedSeat(seatNum === selectedSeat ? null : seatNum);
  };

  const handleProceedToBooking = () => {
    saveSelectedCabin(selectedCabin);
    if (selectedSeat) {
      saveSelectedSeat(selectedSeat);
    }
    navigate(`/flights/${flightId}/book?cabin=${selectedCabin}&seat=${selectedSeat || ''}`);
  };

  if (loading) {
    return (
      <div style={{ padding: '6rem 0' }}>
        <Spinner size="lg" label="Loading aircraft inventory and seat configuration..." />
      </div>
    );
  }

  if (error || !flight) {
    return (
      <div style={{ maxWidth: '600px', margin: '4rem auto' }}>
        <Alert variant="danger" title="Flight Not Found">
          {error || 'The requested flight ID does not exist or has been cancelled.'}
          <div style={{ marginTop: '1rem' }}>
            <Button variant="secondary" onClick={() => navigate('/flights/search')}>
              Back to Flight Search
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  const currentCabinInfo =
    flight.cabins?.find((c) => c.cabin === selectedCabin) || flight.cabins?.[0] || {};
  const cabinPrice = currentCabinInfo.price || flight.basePrice;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Back link */}
      <div>
        <button
          onClick={() => navigate(-1)}
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
          <ChevronLeft size={16} />
          Back to Results
        </button>
      </div>

      {/* Flight Header Card */}
      <div
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '2rem',
          boxShadow: 'var(--shadow-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: 'var(--bg-surface-elevated)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                fontFamily: 'var(--font-mono)',
                fontWeight: '700',
                fontSize: '1.25rem',
                color: 'var(--text-primary)',
              }}
            >
              {flight.airlineCode} {flight.flightNumber}
            </div>
            <div>
              <div style={{ fontSize: '1.15rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                {flight.origin} → {flight.destination}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {flight.aircraftType} • Non-stop Service
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
            <Badge status={flight.status || 'SCHEDULED'} />
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.25rem 0.65rem',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                color: 'var(--status-success)',
                fontSize: '0.75rem',
                fontWeight: '600',
              }}
            >
              <ShieldCheck size={13} />
              Authoritative Write Model
            </div>
          </div>
        </div>

        {/* Schedule Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.5fr 1fr 1.5fr',
            alignItems: 'center',
            padding: '1.5rem',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Departure
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: '800', color: 'var(--text-primary)' }}>
              {formatTime(flight.departureTime)}
            </div>
            <div style={{ fontSize: '0.9rem', color: 'var(--accent-cyan)', fontWeight: '600' }}>
              {flight.origin} • {formatDate(flight.departureDate)}
            </div>
          </div>

          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {calculateDuration(flight.departureTime, flight.arrivalTime)}
            </span>
            <div style={{ width: '80px', height: '2px', backgroundColor: 'var(--border-color)', position: 'relative' }}>
              <Plane size={14} style={{ position: 'absolute', top: '-6px', left: '33px', color: 'var(--accent-primary)' }} />
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--status-success)' }}>Direct Flight</span>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Arrival
            </div>
            <div style={{ fontSize: '1.75rem', fontWeight: '800', color: 'var(--text-primary)' }}>
              {formatTime(flight.arrivalTime)}
            </div>
            <div style={{ fontSize: '0.9rem', color: 'var(--accent-cyan)', fontWeight: '600' }}>
              {flight.destination}
            </div>
          </div>
        </div>
      </div>

      {/* Cabin Selection Tabs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h3 style={{ fontSize: '1.2rem' }}>Select Cabin Class</h3>
        <CabinSelector
          cabins={flight.cabins || []}
          selectedCabin={selectedCabin}
          onSelectCabin={handleCabinChange}
          currency={flight.currency}
        />
      </div>

      {/* Interactive Seat Selection Section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ fontSize: '1.2rem', marginBottom: '0.2rem' }}>
              Aircraft Seat Map — {selectedCabin.replace('_', ' ')}
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Select a preferred seat. Aisle gaps and exit rows are mapped to this aircraft type.
            </p>
          </div>
        </div>

        {seatMapLoading ? (
          <div style={{ padding: '3rem', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)' }}>
            <Spinner label="Rendering cabin layout..." />
          </div>
        ) : (
          <SeatMap
            seatMapData={seatMapData}
            selectedSeat={selectedSeat}
            onSelectSeat={handleSeatSelect}
            cabin={selectedCabin}
          />
        )}
      </div>

      {/* Sticky Booking CTA Bar */}
      <div
        style={{
          position: 'sticky',
          bottom: '1.5rem',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-highlight)',
          borderRadius: 'var(--radius-lg)',
          padding: '1.25rem 2rem',
          boxShadow: 'var(--shadow-lg), 0 0 25px rgba(37, 99, 235, 0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 100,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Selected Fare ({selectedCabin.replace('_', ' ')})
            </div>
            <div
              style={{
                fontSize: '1.6rem',
                fontWeight: '800',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {formatCurrency(cabinPrice, flight.currency)}
            </div>
          </div>

          <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: '1.5rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Assigned Seat
            </div>
            <div style={{ fontSize: '1.1rem', fontWeight: '700', color: selectedSeat ? 'var(--accent-cyan)' : 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              {selectedSeat || 'Auto-assign on confirm'}
            </div>
          </div>
        </div>

        <Button
          variant="primary"
          size="lg"
          onClick={handleProceedToBooking}
          icon={ArrowRight}
          iconPosition="right"
        >
          Continue to Passenger Details
        </Button>
      </div>
    </div>
  );
}
