import React from 'react';

export default function Badge({
  children,
  variant = 'neutral',
  status,
  size = 'md',
  dot = true,
  className = '',
}) {
  let resolvedVariant = variant;

  if (status) {
    const s = String(status).toUpperCase();
    if (['CONFIRMED', 'ACTIVE', 'HEALTHY', 'COMPLETED', 'PUBLISHED'].includes(s)) {
      resolvedVariant = 'success';
    } else if (['PENDING', 'SCHEDULED', 'IN_FLIGHT', 'RETRYING'].includes(s)) {
      resolvedVariant = 'warning';
    } else if (['CANCELLED', 'EXPIRED', 'FAILED', 'OVERSOLD', 'ERROR'].includes(s)) {
      resolvedVariant = 'danger';
    } else if (['DEPARTED', 'PASSENGER', 'AGENT'].includes(s)) {
      resolvedVariant = 'info';
    } else if (['ADMIN'].includes(s)) {
      resolvedVariant = 'purple';
    }
  }

  const styles = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    borderRadius: 'var(--radius-full)',
    fontWeight: '600',
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    fontSize: size === 'sm' ? '0.7rem' : '0.75rem',
    padding: size === 'sm' ? '0.15rem 0.5rem' : '0.25rem 0.65rem',
  };

  const variantMap = {
    success: {
      bg: 'var(--status-success-bg)',
      color: 'var(--status-success)',
      border: '1px solid var(--status-success-border)',
      dotColor: 'var(--status-success)',
    },
    warning: {
      bg: 'var(--status-warning-bg)',
      color: 'var(--status-warning)',
      border: '1px solid var(--status-warning-border)',
      dotColor: 'var(--status-warning)',
    },
    danger: {
      bg: 'var(--status-danger-bg)',
      color: 'var(--status-danger)',
      border: '1px solid var(--status-danger-border)',
      dotColor: 'var(--status-danger)',
    },
    info: {
      bg: 'var(--status-info-bg)',
      color: 'var(--status-info)',
      border: '1px solid var(--status-info-border)',
      dotColor: 'var(--status-info)',
    },
    purple: {
      bg: 'rgba(168, 85, 247, 0.12)',
      color: '#c084fc',
      border: '1px solid rgba(168, 85, 247, 0.3)',
      dotColor: '#c084fc',
    },
    neutral: {
      bg: 'rgba(255, 255, 255, 0.05)',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border-color)',
      dotColor: 'var(--text-muted)',
    },
  };

  const current = variantMap[resolvedVariant] || variantMap.neutral;

  return (
    <span
      style={{
        ...styles,
        backgroundColor: current.bg,
        color: current.color,
        border: current.border,
      }}
      className={`status-badge ${className}`}
    >
      {dot && (
        <span
          style={{
            width: size === 'sm' ? '5px' : '6px',
            height: size === 'sm' ? '5px' : '6px',
            borderRadius: '50%',
            backgroundColor: current.dotColor,
            boxShadow: `0 0 6px ${current.dotColor}`,
          }}
        />
      )}
      {children || status}
    </span>
  );
}
