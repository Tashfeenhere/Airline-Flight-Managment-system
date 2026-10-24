import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Button from './Button';

export default function Pagination({
  total = 0,
  limit = 20,
  offset = 0,
  onPageChange,
}) {
  const totalPages = Math.ceil(total / limit) || 1;
  const currentPage = Math.floor(offset / limit) + 1;

  if (totalPages <= 1) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '1rem 0',
        borderTop: '1px solid var(--border-color)',
        marginTop: '1.5rem',
      }}
    >
      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
        Showing <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>{offset + 1}</span> to{' '}
        <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>
          {Math.min(offset + limit, total)}
        </span>{' '}
        of <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>{total}</span> entries
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Button
          variant="secondary"
          size="sm"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          icon={ChevronLeft}
        >
          Previous
        </Button>

        <span
          style={{
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            padding: '0 0.5rem',
          }}
        >
          Page {currentPage} of {totalPages}
        </span>

        <Button
          variant="secondary"
          size="sm"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(offset + limit)}
          icon={ChevronRight}
          iconPosition="right"
        >
          Next
        </Button>
      </div>
    </div>
  );
}
