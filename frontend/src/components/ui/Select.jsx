import React from 'react';
import { ChevronDown } from 'lucide-react';

export default function Select({
  label,
  error,
  options = [],
  value,
  onChange,
  required = false,
  placeholder,
  className = '',
  disabled = false,
  id,
  name,
  ...props
}) {
  const selectId = id || name || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', width: '100%' }}>
      {label && (
        <label
          htmlFor={selectId}
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

      <div style={{ position: 'relative', width: '100%' }}>
        <select
          id={selectId}
          name={name}
          value={value}
          onChange={onChange}
          disabled={disabled}
          required={required}
          style={{
            width: '100%',
            appearance: 'none',
            WebkitAppearance: 'none',
            backgroundColor: 'var(--bg-secondary)',
            border: `1px solid ${error ? 'var(--status-danger)' : 'var(--border-color)'}`,
            borderRadius: 'var(--radius-md)',
            padding: '0.65rem 2.2rem 0.65rem 0.85rem',
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            outline: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'border-color var(--transition-fast)',
          }}
          className={`select-interactive ${className}`}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => {
            const val = typeof opt === 'object' ? opt.value : opt;
            const text = typeof opt === 'object' ? opt.label : opt;
            return (
              <option key={val} value={val} style={{ backgroundColor: '#0f172a', color: '#f8fafc' }}>
                {text}
              </option>
            );
          })}
        </select>

        <div
          style={{
            position: 'absolute',
            right: '0.85rem',
            top: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <ChevronDown size={16} />
        </div>
      </div>

      {error && <span style={{ fontSize: '0.8rem', color: 'var(--status-danger)' }}>{error}</span>}
    </div>
  );
}
