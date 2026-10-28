import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, CheckCircle2, ArrowLeft, Plane, Sparkles, Layers, DollarSign, Info } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { CABINS, FLIGHT_STATUS } from '../../utils/constants';
import AdminSidebar from '../../components/layout/AdminSidebar';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';
import { useToast } from '../../components/ui/Toast';

export default function AdminCreateFlightPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [flightNumber, setFlightNumber] = useState('PK-785');
  const [airlineCode, setAirlineCode] = useState('PIA');
  const [origin, setOrigin] = useState('ISB');
  const [destination, setDestination] = useState('LHR');
  const [departureDate, setDepartureDate] = useState('2026-11-03');
  const [departureTime, setDepartureTime] = useState('2026-11-03T06:30:00Z');
  const [arrivalTime, setArrivalTime] = useState('2026-11-03T14:45:00Z');
  const [aircraftType, setAircraftType] = useState('Boeing 777-300ER');
  const [basePrice, setBasePrice] = useState(650);
  const [currency, setCurrency] = useState('USD');
  const [status, setStatus] = useState('SCHEDULED');

  const [cabins, setCabins] = useState([
    { cabin: 'ECONOMY', totalSeats: 280, price: 650 },
    { cabin: 'BUSINESS', totalSeats: 28, price: 1850 },
  ]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  // 1-Click Route Presets for Easy Provisioning
  const applyPreset = (preset) => {
    setFlightNumber(preset.flightNumber);
    setAirlineCode(preset.airlineCode);
    setOrigin(preset.origin);
    setDestination(preset.destination);
    setAircraftType(preset.aircraftType);
    setBasePrice(preset.basePrice);
    setCurrency(preset.currency);
    setCabins(preset.cabins);
    toast.info(`Loaded pre-filled flight template for ${preset.airlineCode} ${preset.flightNumber} (${preset.origin} → ${preset.destination})`, 'Preset Loaded');
  };

  const presets = [
    {
      name: 'Transatlantic PK-785',
      aircraft: 'Boeing 777-300ER',
      flightNumber: 'PK-785',
      airlineCode: 'PIA',
      origin: 'ISB',
      destination: 'LHR',
      aircraftType: 'Boeing 777-300ER',
      basePrice: 650,
      currency: 'USD',
      cabins: [
        { cabin: 'ECONOMY', totalSeats: 280, price: 650 },
        { cabin: 'BUSINESS', totalSeats: 28, price: 1850 },
        { cabin: 'FIRST', totalSeats: 8, price: 3200 },
      ],
    },
    {
      name: 'Gulf Express PK-211',
      aircraft: 'Airbus A350-900',
      flightNumber: 'PK-211',
      airlineCode: 'PIA',
      origin: 'KHI',
      destination: 'DXB',
      aircraftType: 'Airbus A350-900',
      basePrice: 380,
      currency: 'USD',
      cabins: [
        { cabin: 'ECONOMY', totalSeats: 260, price: 380 },
        { cabin: 'BUSINESS', totalSeats: 32, price: 1100 },
      ],
    },
    {
      name: 'Asia Shuttle PK-892',
      aircraft: 'Boeing 787-9 Dreamliner',
      flightNumber: 'PK-892',
      airlineCode: 'PIA',
      origin: 'LHE',
      destination: 'SIN',
      aircraftType: 'Boeing 787-9 Dreamliner',
      basePrice: 520,
      currency: 'USD',
      cabins: [
        { cabin: 'ECONOMY', totalSeats: 240, price: 520 },
        { cabin: 'PREMIUM_ECONOMY', totalSeats: 24, price: 890 },
        { cabin: 'BUSINESS', totalSeats: 30, price: 1650 },
      ],
    },
  ];

  const handleAddCabin = () => {
    const unusedCabin = CABINS.find((c) => !cabins.some((entry) => entry.cabin === c)) || 'FIRST';
    setCabins([...cabins, { cabin: unusedCabin, totalSeats: 8, price: basePrice * 2 }]);
  };

  const handleRemoveCabin = (index) => {
    if (cabins.length <= 1) return;
    setCabins(cabins.filter((_, idx) => idx !== index));
  };

  const handleCabinChange = (index, field, value) => {
    const updated = [...cabins];
    updated[index][field] = field === 'cabin' ? value : Number(value);
    setCabins(updated);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const payload = {
        flightNumber: flightNumber.trim().toUpperCase(),
        airlineCode: airlineCode.trim().toUpperCase(),
        origin: origin.trim().toUpperCase(),
        destination: destination.trim().toUpperCase(),
        departureDate,
        departureTime,
        arrivalTime,
        aircraftType: aircraftType.trim(),
        basePrice: Number(basePrice),
        currency: currency.trim().toUpperCase(),
        status,
        cabins,
      };

      const res = await adminApi.upsertFlight(payload);
      if (res.success) {
        setSuccess(true);
        toast.success(`Flight ${payload.airlineCode} ${payload.flightNumber} provisioned across Citus worker shards!`, 'Flight Created');
      }
    } catch (err) {
      const msg = err.error?.message || err.message || 'Flight creation failed.';
      setError(msg);
      toast.error(msg, 'Creation Error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - var(--header-height))' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem', maxWidth: '1050px' }}>
        <div>
          <button
            onClick={() => navigate('/admin/flights')}
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
              marginBottom: '0.75rem',
            }}
          >
            <ArrowLeft size={16} />
            Back to Flight Schedule Index
          </button>

          <span
            style={{
              fontSize: '0.72rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: '800',
              color: 'var(--accent-cyan)',
              backgroundColor: 'rgba(6, 182, 212, 0.12)',
              padding: '0.2rem 0.65rem',
              borderRadius: 'var(--radius-full)',
              border: '1px solid rgba(6, 182, 212, 0.3)',
              display: 'inline-block',
              marginBottom: '0.35rem',
            }}
          >
            Inventory Provisioning Desk
          </span>
          <h1 style={{ fontSize: '1.9rem', fontWeight: '800', color: 'var(--text-primary)', margin: 0 }}>
            Provision Flight Route & Initialize Cabin Shards
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.3rem', maxWidth: '820px' }}>
            Allocates a new partitioned flight record. Row-level inventory counters will be distributed to a target Citus worker node.
          </p>
        </div>

        {/* 1-Click Pre-filled Templates Bar */}
        <div
          style={{
            backgroundColor: 'var(--bg-glass-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            backdropFilter: 'blur(16px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-primary)', fontSize: '0.84rem', fontWeight: '700' }}>
            <Sparkles size={16} />
            <span>1-Click Pre-filled Flight Presets (Instant Testing)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
            {presets.map((p, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => applyPreset(p)}
                style={{
                  padding: '0.75rem 1rem',
                  backgroundColor: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
                className="btn-interactive"
              >
                <div style={{ fontWeight: '700', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                  {p.name}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                  {p.origin} → {p.destination} • {p.aircraft}
                </div>
              </button>
            ))}
          </div>
        </div>

        {error && <Alert variant="danger">{error}</Alert>}
        {success && (
          <Alert variant="success" title="Inventory Provisioned Successfully">
            Flight {airlineCode} {flightNumber} has been hash-partitioned into the Citus cluster with {cabins.length} active cabin counters.
          </Alert>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
          {/* General Information Card */}
          <div
            style={{
              backgroundColor: 'var(--bg-glass-card)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-xl)',
              padding: '1.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1.25rem',
              backdropFilter: 'blur(16px)',
            }}
          >
            <h3 style={{ fontSize: '1.15rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem', margin: 0 }}>
              Flight Routing & Timing
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
              <Input
                label="Airline Designator (ICAO/IATA)"
                value={airlineCode}
                onChange={(e) => setAirlineCode(e.target.value)}
                placeholder="PIA"
                required
              />
              <Input
                label="Flight Number Code"
                value={flightNumber}
                onChange={(e) => setFlightNumber(e.target.value)}
                placeholder="PK-785"
                required
              />
              <Input
                label="Origin Airport IATA"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="ISB"
                required
              />
              <Input
                label="Destination Airport IATA"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="LHR"
                required
              />
              <Input
                label="Departure Calendar Date (UTC)"
                type="date"
                value={departureDate}
                onChange={(e) => setDepartureDate(e.target.value)}
                required
              />
              <Input
                label="Aircraft Type Equipment"
                value={aircraftType}
                onChange={(e) => setAircraftType(e.target.value)}
                placeholder="Boeing 777-300ER"
                required
              />
              <Input
                label="Departure Timestamp (ISO UTC)"
                value={departureTime}
                onChange={(e) => setDepartureTime(e.target.value)}
                required
              />
              <Input
                label="Arrival Timestamp (ISO UTC)"
                value={arrivalTime}
                onChange={(e) => setArrivalTime(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Cabin Inventory & Seat Quotas */}
          <div
            style={{
              backgroundColor: 'var(--bg-glass-card)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-xl)',
              padding: '1.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1.25rem',
              backdropFilter: 'blur(16px)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ fontSize: '1.15rem', margin: 0 }}>Cabin Inventory Slots & Pricing</h3>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                  Each cabin establishes a row-level mutex counter in table <code className="mono-code">flight_inventory</code>.
                </p>
              </div>
              <Button type="button" variant="secondary" size="sm" icon={Plus} onClick={handleAddCabin}>
                Add Cabin Class
              </Button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {cabins.map((entry, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.5fr 1fr 1fr auto',
                    gap: '1rem',
                    alignItems: 'flex-end',
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    padding: '1rem',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <div>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                      Cabin Tier
                    </label>
                    <select
                      value={entry.cabin}
                      onChange={(e) => handleCabinChange(idx, 'cabin', e.target.value)}
                      style={{
                        width: '100%',
                        backgroundColor: 'var(--bg-surface-elevated)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '0.45rem',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {CABINS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>

                  <Input
                    label="Seat Capacity"
                    type="number"
                    value={entry.totalSeats}
                    onChange={(e) => handleCabinChange(idx, 'totalSeats', e.target.value)}
                    required
                  />

                  <Input
                    label="Base Fare (USD)"
                    type="number"
                    value={entry.price}
                    onChange={(e) => handleCabinChange(idx, 'price', e.target.value)}
                    required
                  />

                  <button
                    type="button"
                    onClick={() => handleRemoveCabin(idx)}
                    disabled={cabins.length <= 1}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: cabins.length <= 1 ? 'var(--text-muted)' : 'var(--status-danger)',
                      cursor: cabins.length <= 1 ? 'not-allowed' : 'pointer',
                      padding: '0.5rem',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
            <Button type="button" variant="secondary" onClick={() => navigate('/admin/flights')}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon={CheckCircle2} loading={loading}>
              Provision Flight Across Shards
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
