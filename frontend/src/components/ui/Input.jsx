import React from 'react';

export default function Input({
  label,
  error,
  helper,
  icon: Icon,
  type = 'text',
  placeholder,
  value,
  onChange,
  required = false,
  className = '',
  disabled = false,
  id,
  name,
  ...props
}) {
  const inputId = id || name || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', width: '100%' }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontSize: '0.85rem',
            fontWeight: '500',
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          {label}
          {required && <span style={{ color: 'var(--status-danger)' }}>*</span>}
        </label>
      )}

      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          width: '100%',
        }}
      >
        {Icon && (
          <div
            style={{
              position: 'absolute',
              left: '0.85rem',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <Icon size={16} />
          </div>
        )}

        <input
          id={inputId}
          name={name}
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          style={{
            width: '100%',
            backgroundColor: 'var(--bg-secondary)',
            border: `1px solid ${error ? 'var(--status-danger)' : 'var(--border-color)'}`,
            borderRadius: 'var(--radius-md)',
            padding: '0.65rem 0.85rem',
            paddingLeft: Icon ? '2.5rem' : '0.85rem',
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
            boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.2)',
          }}
          className={`input-interactive ${className}`}
          {...props}
        />
      </div>

      {error ? (
        <span style={{ fontSize: '0.8rem', color: 'var(--status-danger)' }}>{error}</span>
      ) : helper ? (
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{helper}</span>
      ) : null}
    </div>
  );
}
