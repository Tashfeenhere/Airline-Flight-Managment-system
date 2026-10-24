import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { bookingsApi } from '../../api/bookings';
import BookingDetailPage from './BookingDetailPage';
import Spinner from '../../components/ui/Spinner';
import Alert from '../../components/ui/Alert';

export default function BookingByReferencePage() {
  const { ref } = useParams();
  const navigate = useNavigate();
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadByRef() {
      try {
        const res = await bookingsApi.getByReference(ref);
        if (res.success && res.data) {
          navigate(`/bookings/${res.data.bookingId}`, { replace: true });
        } else {
          setError(`No booking found matching reference code "${ref}".`);
        }
      } catch (err) {
        setError(err.message || 'Error looking up reference.');
      } finally {
        setLoading(false);
      }
    }
    loadByRef();
  }, [ref, navigate]);

  if (loading) {
    return (
      <div style={{ padding: '6rem 0' }}>
        <Spinner size="lg" label={`Resolving booking reference ${ref}...`} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '600px', margin: '4rem auto' }}>
      <Alert variant="danger" title="Booking Not Found">
        {error}
      </Alert>
    </div>
  );
}
