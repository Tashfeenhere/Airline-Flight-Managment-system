import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, CheckCircle2, ArrowLeft } from 'lucide-react';
import { adminApi } from '../../api/admin';
import { CABINS, FLIGHT_STATUS } from '../../utils/constants';
import AdminSidebar from '../../components/layout/AdminSidebar';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';

export default function AdminCreateFlightPage() {
  const navigate = useNavigate();

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
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Flight creation failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <AdminSidebar />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '1000px' }}>
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
            Back to Flight List
          </button>
          <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
            Create / Upsert Flight Record
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Provision a new flight route and initialize distributed inventory counters across Citus shards.
          </p>
        </div>

        {success ? (
          <div
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)',
              padding: '3rem',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1rem',
            }}
          >
            <CheckCircle2 size={48} style={{ color: 'var(--status-success)' }} />
            <h2 style={{ fontSize: '1.4rem' }}>Flight Record Successfully Created</h2>
            <p style={{ color: 'var(--text-secondary)', maxWidth: '480px' }}>
              Flight <strong style={{ color: 'var(--text-primary)' }}>{airlineCode} {flightNumber}</strong> ({origin} → {destination}) has been written to the Citus cluster and queued for read-model projection.
            </p>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
              <Button variant="secondary" onClick={() => setSuccess(false)}>
                Add Another Flight
              </Button>
              <Button variant="primary" onClick={() => navigate('/admin/flights')}>
                View Flight List
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
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
            {error && <Alert variant="danger">{error}</Alert>}

            {/* Flight Identification */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 2fr', gap: '1rem' }}>
              <Input
                label="Airline Code (2-3 chars)"
                required
                maxLength={3}
                placeholder="PIA"
                value={airlineCode}
                onChange={(e) => setAirlineCode(e.target.value.toUpperCase())}
              />
              <Input
                label="Flight Number"
                required
                placeholder="PK-785"
                value={flightNumber}
                onChange={(e) => setFlightNumber(e.target.value.toUpperCase())}
              />
              <Input
                label="Aircraft Type"
                required
                placeholder="Boeing 777-300ER"
                value={aircraftType}
                onChange={(e) => setAircraftType(e.target.value)}
              />
            </div>

            {/* Route & Dates */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr', gap: '1rem' }}>
              <Input
                label="Origin IATA Code"
                required
                maxLength={3}
                placeholder="ISB"
                value={origin}
                onChange={(e) => setOrigin(e.target.value.toUpperCase())}
              />
              <Input
                label="Destination IATA Code"
                required
                maxLength={3}
                placeholder="LHR"
                value={destination}
                onChange={(e) => setDestination(e.target.value.toUpperCase())}
              />
              <Input
                label="Departure Date (Partition Key)"
                type="date"
                required
                value={departureDate}
                onChange={(e) => setDepartureDate(e.target.value)}
              />
            </div>

            {/* Timestamps RFC 3339 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Input
                label="Departure Time (RFC 3339 with Offset)"
                required
                placeholder="2026-11-03T06:30:00Z"
                value={departureTime}
                onChange={(e) => setDepartureTime(e.target.value)}
                helper="Must include timezone offset (e.g. Z or +05:00)"
              />
              <Input
                label="Arrival Time (RFC 3339 with Offset)"
                required
                placeholder="2026-11-03T14:45:00Z"
                value={arrivalTime}
                onChange={(e) => setArrivalTime(e.target.value)}
                helper="Flight schedule arrival instant"
              />
            </div>

            {/* Base Price & Status */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              <Input
                label="Base Economy Price"
                type="number"
                min="0"
                step="1"
                required
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
              />

              <Input
                label="Currency"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.85rem',
                    fontWeight: '500',
                    color: 'var(--text-secondary)',
                    marginBottom: '0.35rem',
                  }}
                >
                  Flight Status
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  style={{
                    width: '100%',
                    backgroundColor: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    padding: '0.65rem 0.85rem',
                    color: 'var(--text-primary)',
                    fontSize: '0.95rem',
                    outline: 'none',
                  }}
                >
                  {Object.values(FLIGHT_STATUS).map((st) => (
                    <option key={st} value={st} style={{ backgroundColor: '#0f172a' }}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Cabins Section */}
            <div
              style={{
                borderTop: '1px solid var(--border-subtle)',
                paddingTop: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <h3 style={{ fontSize: '1.1rem' }}>Cabin Inventory Counters</h3>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Each cabin row creates an independent row in Citus sharded inventory.
                  </span>
                </div>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={Plus}
                  onClick={handleAddCabin}
                  disabled={cabins.length >= CABINS.length}
                >
                  Add Cabin
                </Button>
              </div>

              {cabins.map((c, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 2fr 2fr auto',
                    gap: '1rem',
                    alignItems: 'end',
                    padding: '1rem',
                    backgroundColor: 'var(--bg-secondary)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Class</label>
                    <select
                      value={c.cabin}
                      onChange={(e) => handleCabinChange(idx, 'cabin', e.target.value)}
                      style={{
                        width: '100%',
                        backgroundColor: 'var(--bg-surface)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0.55rem 0.75rem',
                        color: 'var(--text-primary)',
                        fontSize: '0.9rem',
                        marginTop: '0.25rem',
                      }}
                    >
                      {CABINS.map((cab) => (
                        <option key={cab} value={cab} style={{ backgroundColor: '#0f172a' }}>
                          {cab}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Total Seats</label>
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      value={c.totalSeats}
                      onChange={(e) => handleCabinChange(idx, 'totalSeats', e.target.value)}
                      style={{
                        width: '100%',
                        backgroundColor: 'var(--bg-surface)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0.55rem 0.75rem',
                        color: 'var(--text-primary)',
                        fontSize: '0.9rem',
                        marginTop: '0.25rem',
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Price Override</label>
                    <input
                      type="number"
                      min="0"
                      value={c.price}
                      onChange={(e) => handleCabinChange(idx, 'price', e.target.value)}
                      style={{
                        width: '100%',
                        backgroundColor: 'var(--bg-surface)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0.55rem 0.75rem',
                        color: 'var(--text-primary)',
                        fontSize: '0.9rem',
                        marginTop: '0.25rem',
                      }}
                    />
                  </div>

                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    icon={Trash2}
                    onClick={() => handleRemoveCabin(idx)}
                    disabled={cabins.length <= 1}
                  />
                </div>
              ))}
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              style={{ marginTop: '1rem' }}
            >
              Upsert Flight into Citus Write Model
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
