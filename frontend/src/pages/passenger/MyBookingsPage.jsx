import React, { useEffect, useState } from 'react';
import { Ticket, Search, Filter, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { bookingsApi } from '../../api/bookings';
import BookingCard from '../../components/bookings/BookingCard';
import CancelModal from '../../components/bookings/CancelModal';
import Spinner from '../../components/ui/Spinner';
import Button from '../../components/ui/Button';
import Pagination from '../../components/ui/Pagination';

export default function MyBookingsPage() {
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
        loadBookings();
      }
    } catch (err) {
      console.error('Failed to cancel booking', err);
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
      b.destination?.toLowerCase().includes(q)
    );
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
            My Flight Reservations
          </h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Real-time status of held, confirmed, and historical travel bookings.
          </p>
        </div>

        <Link to="/flights/search" style={{ textDecoration: 'none' }}>
          <Button variant="primary" icon={Plus}>
            Book New Flight
          </Button>
        </Link>
      </div>

      {/* Filter and Search Bar */}
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
          padding: '1rem 1.25rem',
        }}
      >
        {/* Status Filter Tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {['ALL', 'CONFIRMED', 'PENDING', 'CANCELLED'].map((st) => (
            <button
              key={st}
              onClick={() => {
                setStatusFilter(st);
                setOffset(0);
              }}
              style={{
                padding: '0.45rem 0.85rem',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.85rem',
                fontWeight: '600',
                border: '1px solid',
                borderColor: statusFilter === st ? 'var(--accent-primary)' : 'var(--border-subtle)',
                backgroundColor: statusFilter === st ? 'var(--accent-light)' : 'transparent',
                color: statusFilter === st ? 'var(--accent-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
            >
              {st}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div style={{ position: 'relative', width: '280px' }}>
          <div
            style={{
              position: 'absolute',
              left: '0.75rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
              pointerEvents: 'none',
              display: 'flex',
            }}
          >
            <Search size={15} />
          </div>
          <input
            type="text"
            placeholder="Search reference, route..."
            value={searchRef}
            onChange={(e) => setSearchRef(e.target.value)}
            style={{
              width: '100%',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '0.5rem 0.75rem 0.5rem 2.2rem',
              color: 'var(--text-primary)',
              fontSize: '0.88rem',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Bookings List Stream */}
      {loading ? (
        <div style={{ padding: '5rem 0' }}>
          <Spinner size="lg" label="Loading reservations from user index..." />
        </div>
      ) : filteredBookings.length === 0 ? (
        <div
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '4rem 2rem',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
          }}
        >
          <Ticket size={40} style={{ color: 'var(--text-muted)' }} />
          <div>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>No Bookings Found</h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', maxWidth: '420px' }}>
              {statusFilter !== 'ALL'
                ? `You have no ${statusFilter.toLowerCase()} reservations.`
                : 'You have not booked any flights yet. Start searching for available routes.'}
            </p>
          </div>
          <Link to="/flights/search" style={{ textDecoration: 'none', marginTop: '0.5rem' }}>
            <Button variant="primary">Search Available Flights</Button>
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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
  );
}
