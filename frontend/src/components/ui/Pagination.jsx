import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsRight, FastForward, ArrowRight } from 'lucide-react';
import Button from './Button';

export default function Pagination({
  total = 0,
  limit = 20,
  offset = 0,
  onPageChange,
}) {
  const totalPages = Math.ceil(total / limit) || 1;
  const currentPage = Math.floor(offset / limit) + 1;
  const [jumpPage, setJumpPage] = useState('');

  if (totalPages <= 1) return null;

  const handleJumpSubmit = (e) => {
    e.preventDefault();
    const pageNum = parseInt(jumpPage, 10);
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
      onPageChange((pageNum - 1) * limit);
      setJumpPage('');
    }
  };

  const jumpAhead = (numPages) => {
    const targetPage = Math.min(totalPages, currentPage + numPages);
    onPageChange((targetPage - 1) * limit);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
        padding: '1.25rem 0',
        borderTop: '1px solid var(--border-color)',
        marginTop: '1.5rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
          Showing{' '}
          <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {(offset + 1).toLocaleString()}
          </strong>{' '}
          to{' '}
          <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {Math.min(offset + limit, total).toLocaleString()}
          </strong>{' '}
          of{' '}
          <strong style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', fontSize: '0.96rem' }}>
            {total.toLocaleString()}
          </strong>{' '}
          scheduled flights
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {currentPage > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(0)}
              style={{ fontSize: '0.78rem' }}
            >
              Page 1
            </Button>
          )}

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
              color: 'var(--text-primary)',
              fontWeight: '700',
              padding: '0 0.5rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Page {currentPage.toLocaleString()} of {totalPages.toLocaleString()}
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

          {/* Quick Deep Jumps for 60M Dataset */}
          {totalPages > 10 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginLeft: '0.25rem' }}>
              <button
                type="button"
                onClick={() => jumpAhead(10)}
                title="Jump 10 pages ahead"
                style={{
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  color: '#1e293b',
                  fontSize: '0.75rem',
                  fontWeight: '700',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                +10
              </button>
              <button
                type="button"
                onClick={() => jumpAhead(100)}
                title="Jump 100 pages ahead"
                style={{
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  color: '#1e293b',
                  fontSize: '0.75rem',
                  fontWeight: '700',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                +100
              </button>
              <button
                type="button"
                onClick={() => jumpAhead(1000)}
                title="Jump 1,000 pages ahead"
                style={{
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  color: '#1d4ed8',
                  fontSize: '0.75rem',
                  fontWeight: '700',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                +1,000
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Jump Directly to Page Input */}
      {totalPages > 5 && (
        <form
          onSubmit={handleJumpSubmit}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '0.5rem',
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
          }}
        >
          <span>Jump to Page:</span>
          <input
            type="number"
            min="1"
            max={totalPages}
            value={jumpPage}
            onChange={(e) => setJumpPage(e.target.value)}
            placeholder={`1 - ${totalPages.toLocaleString()}`}
            style={{
              width: '120px',
              padding: '0.3rem 0.5rem',
              backgroundColor: '#ffffff',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              color: '#0f172a',
              fontSize: '0.82rem',
              outline: 'none',
              fontFamily: 'var(--font-mono)',
            }}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            style={{ padding: '0.3rem 0.65rem', fontSize: '0.78rem' }}
          >
            Go
          </Button>
        </form>
      )}
    </div>
  );
}
