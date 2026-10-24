import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Cpu, ArrowRight, Activity, Zap, Plane } from 'lucide-react';
import SearchForm from '../../components/flights/SearchForm';
import Button from '../../components/ui/Button';

export default function HomePage() {
  const navigate = useNavigate();

  const popularRoutes = [
    { origin: 'ISB', destination: 'LHR', cityPair: 'Islamabad to London', aircraft: 'Boeing 777-300ER', price: '$650' },
    { origin: 'JFK', destination: 'LHR', cityPair: 'New York to London', aircraft: 'Boeing 787-9', price: '$850' },
    { origin: 'ISB', destination: 'DXB', cityPair: 'Islamabad to Dubai', aircraft: 'Airbus A380', price: '$380' },
    { origin: 'ORD', destination: 'FRA', cityPair: 'Chicago to Frankfurt', aircraft: 'Airbus A350', price: '$790' },
  ];

  const handleQuickRoute = (r) => {
    navigate(
      `/flights/search?origin=${r.origin}&destination=${r.destination}&departureDate=2026-11-02&cabin=ECONOMY&passengers=1`
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4rem', paddingBottom: '2rem' }}>
      {/* Hero Section */}
      <section
        style={{
          position: 'relative',
          paddingTop: '3.5rem',
          paddingBottom: '3.5rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '2rem',
        }}
      >
        {/* Architecture Pill */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.65rem',
            padding: '0.4rem 1rem',
            backgroundColor: 'rgba(37, 99, 235, 0.12)',
            border: '1px solid rgba(37, 99, 235, 0.3)',
            borderRadius: 'var(--radius-full)',
            fontSize: '0.82rem',
            fontWeight: '600',
            color: 'var(--accent-cyan)',
            letterSpacing: '0.04em',
            boxShadow: '0 0 15px rgba(37, 99, 235, 0.2)',
          }}
        >
          <Activity size={14} className="animate-spin" style={{ animationDuration: '6s' }} />
          Distributed Citus Architecture • Anti-Oversell Guarantee • CQRS Search Projection
        </div>

        {/* Heading */}
        <div style={{ maxWidth: '850px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h1
            style={{
              fontSize: 'clamp(2.5rem, 5vw, 3.8rem)',
              fontWeight: '800',
              lineHeight: 1.15,
              letterSpacing: '-0.03em',
              background: 'linear-gradient(180deg, #FFFFFF 20%, #94A3B8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Mission-Critical Airline Seat Inventory at Scale
          </h1>
          <p
            style={{
              fontSize: '1.2rem',
              color: 'var(--text-secondary)',
              maxWidth: '680px',
              margin: '0 auto',
              lineHeight: 1.6,
            }}
          >
            Explore real-time seat maps, book flights with mathematical anti-oversell guarantees,
            and monitor high-throughput transactional event outboxes.
          </p>
        </div>

        {/* Search Widget */}
        <div style={{ width: '100%', maxWidth: '1180px', marginTop: '1rem' }}>
          <SearchForm />
        </div>
      </section>

      {/* Architecture Highlights */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '1.5rem',
        }}
      >
        <div
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--status-success-bg)',
              color: 'var(--status-success)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <ShieldCheck size={22} />
          </div>
          <h3 style={{ fontSize: '1.15rem' }}>Anti-Oversell Concurrency</h3>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Inventory counters are updated using strict conditional locks (<code style={{ color: 'var(--accent-cyan)' }}>available_seats &gt; 0</code>), ensuring racing buyers never double-book any cabin.
          </p>
        </div>

        <div
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--accent-light)',
              color: 'var(--accent-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Zap size={22} />
          </div>
          <h3 style={{ fontSize: '1.15rem' }}>CQRS Read Projections</h3>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Global search queries execute against an ultra-fast denormalized search projection, keeping booking shards completely decoupled from search spikes.
          </p>
        </div>

        <div
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            padding: '1.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(168, 85, 247, 0.12)',
              color: '#c084fc',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Cpu size={22} />
          </div>
          <h3 style={{ fontSize: '1.15rem' }}>Transactional Outbox</h3>
          <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Every seat reservation writes outbox events atomically in the same database transaction, ensuring guaranteed asynchronous saga completion.
          </p>
        </div>
      </section>

      {/* Featured Routes */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: '1.6rem', marginBottom: '0.25rem' }}>Popular Flight Routes</h2>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Direct scheduled service between major aviation hubs
            </p>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
            gap: '1.25rem',
          }}
        >
          {popularRoutes.map((r, idx) => (
            <div
              key={idx}
              onClick={() => handleQuickRoute(r)}
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-lg)',
                padding: '1.5rem',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
              }}
              className="route-card-hover"
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.1rem', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                  <span>{r.origin}</span>
                  <Plane size={14} style={{ color: 'var(--accent-primary)' }} />
                  <span>{r.destination}</span>
                </div>
                <span style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--accent-cyan)' }}>
                  from {r.price}
                </span>
              </div>

              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: '500', color: 'var(--text-primary)' }}>
                  {r.cityPair}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {r.aircraft} • Non-stop
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.85rem',
                  fontWeight: '600',
                  color: 'var(--accent-primary)',
                  marginTop: 'auto',
                }}
              >
                <span>View Availability</span>
                <ArrowRight size={14} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
