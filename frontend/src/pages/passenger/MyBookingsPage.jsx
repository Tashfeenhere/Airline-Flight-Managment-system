import React, { useEffect, useState } from 'react';
import {
  Ticket,
  Search,
  Filter,
  Plus,
  Plane,
  Printer,
  CheckCircle2,
  ShieldCheck,
  ArrowRight,
  Compass,
  Star,
  Layers,
  Database
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { bookingsApi } from '../../api/bookings';
import BookingCard from '../../components/bookings/BookingCard';
import CancelModal from '../../components/bookings/CancelModal';
import PassengerSidebar from '../../components/layout/PassengerSidebar';
import Spinner from '../../components/ui/Spinner';
import Button from '../../components/ui/Button';
import Pagination from '../../components/ui/Pagination';
import { useToast } from '../../components/ui/Toast';

export default function MyBookingsPage() {
  const toast = useToast();
  const [bookings, setBookings] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [searchRef, setSearchRef] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 10;

  // Cancellation modal state
  const [selectedBookingForCancel, setSelectedBookingForCancel] = useState(null);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const loadBookings = async () => {
    setLoading(true);
    try {
      const res = await bookingsApi.listMyBookings({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        offset,
        limit,
      });
      if (res.success) {
        setBookings(res.data.bookings || []);
        setTotal(res.data.total || 0);
      }
    } catch (err) {
      console.error('Failed to load user bookings', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBookings();
  }, [statusFilter, offset]);

  const handleOpenCancelModal = (booking) => {
    setSelectedBookingForCancel(booking);
    setCancelModalOpen(true);
  };

  const handleConfirmCancel = async (bookingId, reason) => {
    setCancelling(true);
    try {
      const res = await bookingsApi.cancelBooking(bookingId, reason);
      if (res.success) {
        setCancelModalOpen(false);
        toast.success('Your reservation has been cancelled and seat returned to inventory.', 'Reservation Cancelled');
        loadBookings();
      }
    } catch (err) {
      console.error('Failed to cancel booking', err);
      toast.error(err.message || 'Failed to cancel reservation.', 'Cancellation Failed');
    } finally {
      setCancelling(false);
    }
  };

  const filteredBookings = bookings.filter((b) => {
    if (!searchRef) return true;
    const q = searchRef.toLowerCase();
    return (
      b.bookingReference?.toLowerCase().includes(q) ||
      b.flightNumber?.toLowerCase().includes(q) ||
      b.origin?.toLowerCase().includes(q) ||
      b.destination?.toLowerCase().includes(q) ||
      b.passengerName?.toLowerCase().includes(q)
    );
  });

  const confirmedCount = bookings.filter((b) => b.status === 'CONFIRMED').length;
  const pendingCount = bookings.filter((b) => b.status === 'PENDING').length;
  const cancelledCount = bookings.filter((b) => b.status === 'CANCELLED').length;

  return (
    <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - var(--header-height))', backgroundColor: '#f8fafc' }}>
      <PassengerSidebar activeTab="bookings" />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem', maxWidth: '1440px', boxSizing: 'border-box' }}>
        {/* Executive Header Banner */}
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '16px',
            padding: '1.75rem 2rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '1.25rem',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <span
                style={{
                  fontSize: '0.72rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontWeight: 800,
                  color: '#1d4ed8',
                  backgroundColor: '#eff6ff',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  border: '1px solid #bfdbfe',
                }}
              >
                Traveler Itinerary & Boarding Hub
              </span>
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  color: '#059669',
                  background: '#ecfdf5',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  border: '1px solid #a7f3d0',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <CheckCircle2 size={11} /> 100% Invariant Safe
              </span>
            </div>
            <h1 style={{ fontSize: '1.85rem', fontWeight: 800, color: '#0f172a', margin: '0 0 0.35rem 0', letterSpacing: '-0.02em' }}>
              My Flight Reservations & E-Tickets
            </h1>
            <p style={{ fontSize: '0.88rem', color: '#64748b', margin: 0, maxWidth: '680px', lineHeight: 1.5 }}>
              Review confirmed flights, print high-resolution boarding passes, or manage distributed seat reservations in real-time.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              to="/flights/search"
              style={{
                background: '#1d4ed8',
                border: 'none',
                color: '#ffffff',
                padding: '0.6rem 1.25rem',
                borderRadius: '8px',
                fontSize: '0.86rem',
                fontWeight: 700,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 2px 6px rgba(29, 78, 216, 0.25)',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#1e40af'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#1d4ed8'; }}
            >
              <Plus size={16} />
              <span>Book New Flight</span>
            </Link>
          </div>
        </div>

        {/* Quick Metrics Strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1d4ed8' }}>
              <Ticket size={20} />
            </div>
            <div>
              <div style={{ fontSize: '0.74rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>Total Bookings</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#0f172a', fontFamily: 'var(--font-mono)' }}>{total || bookings.length}</div>
            </div>
          </div>

          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#059669' }}>
              <CheckCircle2 size={20} />
            </div>
            <div>
              <div style={{ fontSize: '0.74rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>Confirmed Trips</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#059669', fontFamily: 'var(--font-mono)' }}>{confirmedCount}</div>
            </div>
          </div>

          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#fffbeb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d97706' }}>
              <Star size={20} fill="#f59e0b" color="#f59e0b" />
            </div>
            <div>
              <div style={{ fontSize: '0.74rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>SkyClub Mileage</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#b45309', fontFamily: 'var(--font-mono)' }}>14,250 Miles</div>
            </div>
          </div>

          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#16a34a' }}>
              <ShieldCheck size={20} />
            </div>
            <div>
              <div style={{ fontSize: '0.74rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>Inventory Guarantee</div>
              <div style={{ fontSize: '0.88rem', fontWeight: 800, color: '#15803d', marginTop: '2px' }}>0-Oversell Safe</div>
            </div>
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '1rem',
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '0.85rem 1.25rem',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.02)',
          }}
        >
          {/* Status Filter Tabs */}
          <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
            {[
              { id: 'ALL', label: 'All Trips', count: bookings.length },
              { id: 'CONFIRMED', label: 'Confirmed', count: confirmedCount },
              { id: 'PENDING', label: 'Pending', count: pendingCount },
              { id: 'CANCELLED', label: 'Cancelled', count: cancelledCount },
            ].map((tab) => {
              const active = statusFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setStatusFilter(tab.id);
                    setOffset(0);
                  }}
                  style={{
                    padding: '0.45rem 0.95rem',
                    borderRadius: '8px',
                    fontSize: '0.82rem',
                    fontWeight: active ? 800 : 600,
                    border: active ? '1px solid #bfdbfe' : '1px solid transparent',
                    backgroundColor: active ? '#eff6ff' : 'transparent',
                    color: active ? '#1d4ed8' : '#64748b',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) {
                      e.currentTarget.style.backgroundColor = '#f8fafc';
                      e.currentTarget.style.color = '#0f172a';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!active) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                      e.currentTarget.style.color = '#64748b';
                    }
                  }}
                >
                  <span>{tab.label}</span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontFamily: 'var(--font-mono)',
                      background: active ? '#dbeafe' : '#f1f5f9',
                      color: active ? '#1e40af' : '#64748b',
                      padding: '1px 6px',
                      borderRadius: '10px',
                    }}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search Input */}
          <div style={{ position: 'relative', width: '320px', maxWidth: '100%' }}>
            <div
              style={{
                position: 'absolute',
                left: '0.85rem',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#94a3b8',
                pointerEvents: 'none',
                display: 'flex',
              }}
            >
              <Search size={15} />
            </div>
            <input
              type="text"
              placeholder="Search reference, flight, route..."
              value={searchRef}
              onChange={(e) => setSearchRef(e.target.value)}
              style={{
                width: '100%',
                backgroundColor: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '0.55rem 0.85rem 0.55rem 2.4rem',
                color: '#0f172a',
                fontSize: '0.86rem',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'all 0.15s ease',
              }}
              onFocus={(e) => {
                e.currentTarget.style.backgroundColor = '#ffffff';
                e.currentTarget.style.borderColor = '#93c5fd';
                e.currentTarget.style.boxShadow = '0 0 0 3px rgba(29, 78, 216, 0.1)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.backgroundColor = '#f8fafc';
                e.currentTarget.style.borderColor = '#e2e8f0';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>
        </div>

        {/* Bookings List Stream */}
        {loading ? (
          <div style={{ padding: '6rem 0', background: '#ffffff', borderRadius: '16px', border: '1px solid #e2e8f0' }}>
            <Spinner size="lg" label="Querying user partition index across Citus coordinator..." />
          </div>
        ) : filteredBookings.length === 0 ? (
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: '16px',
              padding: '4.5rem 2rem',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1.25rem',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.02)',
            }}
          >
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '16px',
                backgroundColor: '#eff6ff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#1d4ed8',
              }}
            >
              <Ticket size={32} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#0f172a', marginBottom: '0.35rem' }}>
                No Flight Reservations Found
              </h3>
              <p style={{ fontSize: '0.88rem', color: '#64748b', maxWidth: '460px', margin: '0 auto', lineHeight: 1.5 }}>
                {statusFilter !== 'ALL'
                  ? `You have no ${statusFilter.toLowerCase()} reservations matching the current criteria.`
                  : 'You have not booked any flights yet. Search scheduled routes to reserve your flight.'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
              <Link
                to="/flights/search"
                style={{
                  background: '#1d4ed8',
                  border: 'none',
                  color: '#ffffff',
                  padding: '0.65rem 1.35rem',
                  borderRadius: '8px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  textDecoration: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 2px 6px rgba(29, 78, 216, 0.25)',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#1e40af'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#1d4ed8'; }}
              >
                <Compass size={15} />
                <span>Browse Scheduled Flights</span>
              </Link>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {filteredBookings.map((b) => (
              <BookingCard
                key={b.bookingId}
                booking={b}
                onCancelRequest={handleOpenCancelModal}
              />
            ))}

            <Pagination
              total={total}
              limit={limit}
              offset={offset}
              onPageChange={(newOffset) => setOffset(newOffset)}
            />
          </div>
        )}

        {/* Cancel Confirmation Modal */}
        <CancelModal
          isOpen={cancelModalOpen}
          onClose={() => setCancelModalOpen(false)}
          booking={selectedBookingForCancel}
          onConfirmCancel={handleConfirmCancel}
          loading={cancelling}
        />
      </div>
    </div>
  );
}
