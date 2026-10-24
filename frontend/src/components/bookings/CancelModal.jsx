import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

export default function CancelModal({
  isOpen,
  onClose,
  booking,
  onConfirmCancel,
  loading = false,
}) {
  const [reason, setReason] = useState('Change of travel schedule');

  if (!booking) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirmCancel(booking.bookingId, reason);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Confirm Booking Cancellation"
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Keep Booking
          </Button>
          <Button variant="danger" onClick={handleSubmit} loading={loading}>
            Release Seat & Cancel
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            padding: '1rem',
            backgroundColor: 'var(--status-danger-bg)',
            border: '1px solid var(--status-danger-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <AlertTriangle size={20} style={{ color: 'var(--status-danger)', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '0.88rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>
            Cancelling reference <strong style={{ fontFamily: 'var(--font-mono)' }}>{booking.bookingReference}</strong> will immediately forfeit seat <strong style={{ color: 'var(--accent-cyan)' }}>{booking.seatNumber}</strong>. The inventory counter will be atomically refunded back into the Citus cluster.
          </div>
        </div>

        <div>
          <label
            style={{
              display: 'block',
              fontSize: '0.85rem',
              fontWeight: '500',
              color: 'var(--text-secondary)',
              marginBottom: '0.4rem',
            }}
          >
            Reason for Cancellation
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            maxLength={200}
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
          />
        </div>
      </form>
    </Modal>
  );
}
