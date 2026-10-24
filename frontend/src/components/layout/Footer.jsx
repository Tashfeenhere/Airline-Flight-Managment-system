import React from 'react';
import { Database, ShieldCheck, Activity } from 'lucide-react';

export default function Footer() {
  return (
    <footer
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border-color)',
        padding: '3rem 0 2rem 0',
        marginTop: 'auto',
      }}
    >
      <div className="container">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '2.5rem',
            paddingBottom: '2.5rem',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {/* Col 1 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '6px',
                  backgroundColor: 'var(--accent-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#ffffff',
                }}
              >
                <Database size={16} />
              </div>
              <span style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                AeroScale
              </span>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Distributed airline seat inventory engine backed by Citus PostgreSQL sharding, transactional
              outbox event streaming, and optimistic anti-oversell concurrency.
            </p>
          </div>

          {/* Col 2 */}
          <div>
            <div
              style={{
                fontSize: '0.85rem',
                fontWeight: '600',
                color: 'var(--text-primary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: '1rem',
              }}
            >
              System Architecture
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ShieldCheck size={14} style={{ color: 'var(--status-success)' }} />
                Anti-Oversell Conditional Locking
              </li>
              <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Activity size={14} style={{ color: 'var(--status-info)' }} />
                CQRS Read Model Projections
              </li>
              <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Database size={14} style={{ color: '#c084fc' }} />
                Citus Distributed Worker Sharding
              </li>
            </ul>
          </div>

          {/* Col 3 */}
          <div>
            <div
              style={{
                fontSize: '0.85rem',
                fontWeight: '600',
                color: 'var(--text-primary)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: '1rem',
              }}
            >
              Operational Endpoints
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.82rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
              <div>GET /api/health/ready</div>
              <div>GET /api/flights/search</div>
              <div>POST /api/bookings (Idempotent)</div>
              <div>POST /api/admin/inventory/audit</div>
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '1.5rem',
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            gap: '1rem',
          }}
        >
          <div>© 2026 AeroScale Distributed Airline Systems. Production Ready Architecture.</div>
          <div style={{ display: 'flex', gap: '1.5rem' }}>
            <span>Node ID: api-primary-edge</span>
            <span>Cluster: Citus 12.1</span>
            <span>Lag: 0ms write-ahead</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
