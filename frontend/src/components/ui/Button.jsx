import React from 'react';
import { Link } from 'react-router-dom';

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  loading = false,
  icon: Icon,
  iconPosition = 'left',
  className = '',
  onClick,
  to,
  style: customStyle = {},
  ...props
}) {
  const baseStyles = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    fontWeight: '500',
    borderRadius: 'var(--radius-md)',
    transition: 'all var(--transition-fast)',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.6 : 1,
    border: '1px solid transparent',
    outline: 'none',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
  };

  const sizeStyles = {
    sm: { padding: '0.4rem 0.75rem', fontSize: '0.85rem' },
    md: { padding: '0.6rem 1.25rem', fontSize: '0.95rem' },
    lg: { padding: '0.8rem 1.75rem', fontSize: '1.05rem', fontWeight: '600' },
  };

  const variantStyles = {
    primary: {
      backgroundColor: 'var(--accent-primary)',
      color: '#ffffff',
      boxShadow: '0 4px 14px rgba(99, 102, 241, 0.35)',
      border: '1px solid rgba(255, 255, 255, 0.15)',
      fontWeight: '600',
    },
    secondary: {
      backgroundColor: 'var(--bg-surface-elevated)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-color)',
      fontWeight: '500',
    },
    outline: {
      backgroundColor: 'transparent',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-color)',
      fontWeight: '500',
    },
    ghost: {
      backgroundColor: 'transparent',
      color: 'var(--text-secondary)',
      fontWeight: '500',
    },
    danger: {
      backgroundColor: 'var(--status-danger-bg)',
      color: 'var(--status-danger)',
      border: '1px solid var(--status-danger-border)',
      fontWeight: '600',
    },
    success: {
      backgroundColor: 'var(--status-success-bg)',
      color: 'var(--status-success)',
      border: '1px solid var(--status-success-border)',
      fontWeight: '600',
    },
    cyan: {
      backgroundColor: 'rgba(0, 240, 255, 0.14)',
      color: 'var(--accent-cyan)',
      border: '1px solid rgba(0, 240, 255, 0.4)',
      fontWeight: '600',
      boxShadow: '0 0 16px rgba(0, 240, 255, 0.25)',
    },
  };

  const style = {
    ...baseStyles,
    ...(sizeStyles[size] || sizeStyles.md),
    ...(variantStyles[variant] || variantStyles.primary),
    ...customStyle,
  };

  const content = (
    <>
      {loading ? (
        <svg
          className="animate-spin"
          style={{ width: '1rem', height: '1rem' }}
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
            strokeDasharray="60"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <>
          {Icon && iconPosition === 'left' && <Icon size={size === 'sm' ? 14 : 18} />}
          {children}
          {Icon && iconPosition === 'right' && <Icon size={size === 'sm' ? 14 : 18} />}
        </>
      )}
    </>
  );

  if (to && !disabled) {
    return (
      <Link to={to} style={style} className={`btn-interactive ${className}`} {...props}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      style={style}
      className={`btn-interactive ${className}`}
      {...props}
    >
      {content}
    </button>
  );
}

