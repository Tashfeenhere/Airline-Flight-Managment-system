import React from 'react';
import { AlertCircle, CheckCircle2, Info, AlertTriangle } from 'lucide-react';

export default function Alert({
  variant = 'info',
  title,
  children,
  className = '',
  style = {},
}) {
  const configs = {
    info: {
      icon: Info,
      color: 'var(--status-info)',
      bg: 'var(--status-info-bg)',
      border: 'var(--status-info-border)',
    },
    success: {
      icon: CheckCircle2,
      color: 'var(--status-success)',
      bg: 'var(--status-success-bg)',
      border: 'var(--status-success-border)',
    },
    warning: {
      icon: AlertTriangle,
      color: 'var(--status-warning)',
      bg: 'var(--status-warning-bg)',
      border: 'var(--status-warning-border)',
    },
    danger: {
      icon: AlertCircle,
      color: 'var(--status-danger)',
      bg: 'var(--status-danger-bg)',
      border: 'var(--status-danger-border)',
    },
  };

  const current = configs[variant] || configs.info;
  const Icon = current.icon;

  return (
    <div
      style={{
        display: 'flex',
        gap: '0.85rem',
        padding: '1rem 1.25rem',
        borderRadius: 'var(--radius-md)',
        backgroundColor: current.bg,
        border: `1px solid ${current.border}`,
        color: 'var(--text-primary)',
        ...style,
      }}
      className={`alert-banner ${className}`}
    >
      <div style={{ color: current.color, flexShrink: 0, marginTop: '0.1rem' }}>
        <Icon size={20} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1 }}>
        {title && <span style={{ fontWeight: '600', fontSize: '0.95rem' }}>{title}</span>}
        <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
