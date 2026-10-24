import React from 'react';
import { CABIN_DETAILS } from '../../utils/constants';
import { formatCurrency } from '../../utils/formatters';

export default function CabinSelector({
  cabins = [],
  selectedCabin,
  onSelectCabin,
  currency = 'USD',
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '0.85rem',
        width: '100%',
      }}
    >
      {cabins.map((c) => {
        const isSelected = selectedCabin === c.cabin;
        const details = CABIN_DETAILS[c.cabin] || { label: c.cabin };
        const isAvailable = (c.available ?? 0) > 0;

        return (
          <button
            key={c.cabin}
            type="button"
            disabled={!isAvailable}
            onClick={() => onSelectCabin(c.cabin)}
            style={{
              padding: '1.25rem 1rem',
              borderRadius: 'var(--radius-lg)',
              backgroundColor: isSelected ? 'var(--bg-surface-elevated)' : 'var(--bg-surface)',
              border: `2px solid ${
                isSelected
                  ? 'var(--accent-primary)'
                  : isAvailable
                  ? 'var(--border-color)'
                  : 'var(--border-subtle)'
              }`,
              boxShadow: isSelected ? '0 0 15px rgba(37, 99, 235, 0.25)' : 'none',
              cursor: isAvailable ? 'pointer' : 'not-allowed',
              opacity: isAvailable ? 1 : 0.45,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: '0.5rem',
              textAlign: 'left',
              transition: 'all var(--transition-fast)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
              }}
            >
              <span
                style={{
                  fontSize: '0.95rem',
                  fontWeight: '700',
                  color: isSelected ? '#ffffff' : 'var(--text-primary)',
                }}
              >
                {details.label}
              </span>
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: '600',
                  color: isAvailable ? 'var(--status-success)' : 'var(--status-danger)',
                  backgroundColor: isAvailable ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
                  padding: '0.15rem 0.45rem',
                  borderRadius: 'var(--radius-full)',
                }}
              >
                {isAvailable ? `${c.available} seats left` : 'Sold out'}
              </span>
            </div>

            <div
              style={{
                fontSize: '1.4rem',
                fontWeight: '800',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {formatCurrency(c.price, currency)}
            </div>

            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {details.description || 'Standard baggage and seating'}
            </div>
          </button>
        );
      })}
    </div>
  );
}
