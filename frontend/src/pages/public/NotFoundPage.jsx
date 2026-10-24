import React from 'react';
import { Link } from 'react-router-dom';
import { Compass, Home } from 'lucide-react';
import Button from '../../components/ui/Button';

export default function NotFoundPage() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '6rem 1.5rem',
        gap: '1.5rem',
      }}
    >
      <div
        style={{
          width: '64px',
          height: '64px',
          borderRadius: 'var(--radius-xl)',
          backgroundColor: 'var(--bg-surface-elevated)',
          border: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent-primary)',
        }}
      >
        <Compass size={32} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <h1 style={{ fontSize: '3.5rem', fontWeight: '800', fontFamily: 'var(--font-mono)' }}>
          404
        </h1>
        <h2 style={{ fontSize: '1.5rem', color: 'var(--text-primary)' }}>Route Not Found</h2>
        <p style={{ color: 'var(--text-secondary)', maxWidth: '460px', margin: '0 auto' }}>
          The requested navigational airway or endpoint does not exist in the active cluster routing table.
        </p>
      </div>

      <Link to="/" style={{ textDecoration: 'none', marginTop: '1rem' }}>
        <Button variant="primary" icon={Home}>
          Return to Flight Operations
        </Button>
      </Link>
    </div>
  );
}
