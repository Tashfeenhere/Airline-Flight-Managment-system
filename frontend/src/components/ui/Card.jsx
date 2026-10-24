import React from 'react';

export default function Card({
  children,
  className = '',
  style = {},
  variant = 'surface',
  hover = false,
  onClick,
  ...props
}) {
  const isInteractive = hover || !!onClick;

  const bgStyle =
    variant === 'glass'
      ? {
          background: 'var(--bg-glass-card)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }
      : variant === 'elevated'
      ? { background: 'var(--bg-surface-elevated)' }
      : { background: 'var(--bg-surface)' };

  return (
    <div
      onClick={onClick}
      style={{
        ...bgStyle,
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)',
        padding: '1.25rem',
        boxShadow: 'var(--shadow-md)',
        transition: 'all var(--transition-normal)',
        cursor: isInteractive ? 'pointer' : 'default',
        ...style,
      }}
      className={`aeroscale-card ${isInteractive ? 'card-hoverable' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
