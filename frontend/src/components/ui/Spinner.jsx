import React from 'react';

export default function Spinner({ size = 'md', label, className = '' }) {
  const pixelSize = size === 'sm' ? 18 : size === 'lg' ? 42 : 28;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        padding: '1.5rem',
      }}
      className={className}
    >
      <svg
        className="animate-spin"
        style={{
          width: `${pixelSize}px`,
          height: `${pixelSize}px`,
          color: 'var(--accent-primary)',
        }}
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="rgba(255, 255, 255, 0.1)"
          strokeWidth="3"
        />
        <path
          d="M12 2A10 10 0 0 1 22 12"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {label && (
        <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {label}
        </span>
      )}
    </div>
  );
}
