import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  Cpu,
  ArrowRight,
  Activity,
  Zap,
  Plane,
  Database,
  Sparkles,
  Layers,
  Globe,
  CheckCircle2,
  Clock,
  Lock,
} from 'lucide-react';
import SearchForm from '../../components/flights/SearchForm';
import Button from '../../components/ui/Button';

export default function HomePage() {
  const navigate = useNavigate();

  const popularRoutes = [
    {
      origin: 'ISB',
      destination: 'LHR',
      cityName: 'Islamabad to London Heathrow',
      aircraft: 'Boeing 777-300ER',
      duration: '8h 25m',
      price: '$650',
      badge: 'High Frequency',
    },
    {
      origin: 'JFK',
      destination: 'LHR',
      cityName: 'New York JFK to London Heathrow',
      aircraft: 'Boeing 787-9 Dreamliner',
      duration: '7h 10m',
      price: '$850',
      badge: 'Transatlantic Express',
    },
    {
      origin: 'DXB',
      destination: 'SIN',
      cityName: 'Dubai to Singapore Changi',
      aircraft: 'Airbus A380-800',
      duration: '7h 35m',
      price: '$520',
      badge: 'Flagship Route',
    },
    {
      origin: 'KHI',
      destination: 'DXB',
      cityName: 'Karachi to Dubai International',
      aircraft: 'Airbus A321neo',
      duration: '2h 15m',
      price: '$290',
      badge: 'Direct Daily',
    },
  ];

  const handleQuickRoute = (r) => {
    navigate(
      `/flights/search?origin=${r.origin}&destination=${r.destination}&departureDate=2026-11-02&cabin=ECONOMY&passengers=1`
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3.5rem', paddingBottom: '3rem' }}>
      {/* Hero Section */}
      <section
        style={{
          position: 'relative',
          paddingTop: '3.5rem',
          paddingBottom: '3rem',
          paddingLeft: '1.5rem',
          paddingRight: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '1.75rem',
          background:
            'radial-gradient(130% 90% at 50% 0%, #ebf5ff 0%, #f0f7ff 35%, #f8fafc 100%)',
          borderRadius: '24px',
          border: '1px solid #dbeafe',
          boxShadow: '0 8px 30px -4px rgba(29, 78, 216, 0.06)',
          overflow: 'hidden',
        }}
      >
        {/* Subtle Decorative Ambient Lighting */}
        <div
          style={{
            position: 'absolute',
            top: '-60px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '600px',
            height: '240px',
            background: 'radial-gradient(circle, rgba(37, 99, 235, 0.12) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        {/* Architecture Pill Badge */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.65rem',
            padding: '0.45rem 1.25rem',
            backgroundColor: '#ffffff',
            border: '1px solid #bfdbfe',
            borderRadius: '9999px',
            fontSize: '0.82rem',
            fontWeight: '700',
            color: '#1d4ed8',
            letterSpacing: '0.03em',
            boxShadow: '0 2px 10px rgba(29, 78, 216, 0.08)',
            zIndex: 1,
          }}
        >
          <Sparkles size={15} style={{ color: '#2563eb' }} />
          <span>60M+ FLIGHT RECORDS • CITUS DISTRIBUTED SHARDING • ZERO-OVERSELL SAFE</span>
        </div>

        {/* Hero Heading & Subtitle */}
        <div style={{ maxWidth: '900px', display: 'flex', flexDirection: 'column', gap: '1rem', zIndex: 1 }}>
          <h1
            style={{
              fontSize: 'clamp(2.5rem, 5.2vw, 4.1rem)',
              fontWeight: '800',
              lineHeight: 1.14,
              letterSpacing: '-0.035em',
              color: '#0f172a',
              margin: 0,
            }}
          >
            Mission-Critical Airline Seat Inventory{' '}
            <span
              style={{
                background: 'linear-gradient(135deg, #1d4ed8 0%, #0284c7 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                display: 'block',
                marginTop: '0.35rem',
              }}
            >
              Engineered for Enterprise Scale
            </span>
          </h1>

          <p
            style={{
              fontSize: '1.2rem',
              color: '#334155',
              maxWidth: '740px',
              margin: '0 auto',
              lineHeight: 1.65,
              fontWeight: '400',
            }}
          >
            Search across <strong>60 Million scheduled flights</strong> partitioned across distributed
            Citus database shards. Experience mathematical row-level anti-oversell guarantees and sub-40ms
            CQRS read projections.
          </p>
        </div>

        {/* Quick Action Navigation CTAs */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            zIndex: 1,
          }}
        >
          <Button
            variant="primary"
            size="lg"
            onClick={() => navigate('/flights/search')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              padding: '0.75rem 1.6rem',
              fontSize: '0.96rem',
              fontWeight: '700',
              borderRadius: '12px',
              boxShadow: '0 4px 14px rgba(29, 78, 216, 0.3)',
            }}
          >
            <Globe size={18} />
            <span>Search All 60M Flights (No Filters)</span>
            <ArrowRight size={16} />
          </Button>

          <button
            type="button"
            onClick={() => navigate('/admin/lab')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              padding: '0.75rem 1.4rem',
              fontSize: '0.96rem',
              fontWeight: '700',
              color: '#1d4ed8',
              backgroundColor: '#ffffff',
              border: '1.5px solid #bfdbfe',
              borderRadius: '12px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.04)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#eff6ff';
              e.currentTarget.style.borderColor = '#93c5fd';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '#ffffff';
              e.currentTarget.style.borderColor = '#bfdbfe';
            }}
          >
            <Activity size={18} style={{ color: '#1d4ed8' }} />
            <span>Control Room & Concurrency Lab</span>
          </button>
        </div>

        {/* Search Widget Container */}
        <div style={{ width: '100%', maxWidth: '1180px', marginTop: '0.75rem', zIndex: 1 }}>
          <SearchForm />
        </div>
      </section>

      {/* Live Scale & Architecture Metrics Strip */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1.25rem',
        }}
      >
        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '16px',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
            borderTop: '4px solid #1d4ed8',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Dataset Scale
            </span>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1d4ed8' }}>
              <Database size={18} />
            </div>
          </div>
          <div style={{ fontSize: '1.85rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
            60,000,006
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.5, margin: 0 }}>
            Scheduled flights fully queryable with pagination across 51 Citus distributed shards.
          </p>
        </div>

        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '16px',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
            borderTop: '4px solid #0284c7',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Worker Nodes
            </span>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: '#f0f9ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0284c7' }}>
              <Layers size={18} />
            </div>
          </div>
          <div style={{ fontSize: '1.85rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
            22,064,356
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.5, margin: 0 }}>
            Active inventory shard counters maintained with atomic row locking per cabin class.
          </p>
        </div>

        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '16px',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
            borderTop: '4px solid #059669',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Booking Invariant
            </span>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#059669' }}>
              <ShieldCheck size={18} />
            </div>
          </div>
          <div style={{ fontSize: '1.85rem', fontWeight: '800', color: '#059669', fontFamily: 'var(--font-mono)' }}>
            100% ONLINE
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.5, margin: 0 }}>
            Zero-Oversell guarantee verified via 500-concurrency tests against last 2 remaining seats.
          </p>
        </div>

        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '16px',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
            borderTop: '4px solid #7c3aed',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              CQRS Read Model
            </span>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7c3aed' }}>
              <Zap size={18} />
            </div>
          </div>
          <div style={{ fontSize: '1.85rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
            &lt; 40ms
          </div>
          <p style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.5, margin: 0 }}>
            Ultra-fast denormalized flight search projections completely decouple write shards.
          </p>
        </div>
      </section>

      {/* Architecture Highlights */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div>
          <h2 style={{ fontSize: '1.65rem', fontWeight: '800', color: '#0f172a', marginBottom: '0.35rem' }}>
            Distributed Architecture Pillars
          </h2>
          <p style={{ fontSize: '0.92rem', color: '#475569' }}>
            Core engineering primitives that guarantee 100% data integrity under extreme booking loads
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '1.5rem',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: '16px',
              padding: '1.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
              transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '12px',
                  backgroundColor: '#ecfdf5',
                  color: '#059669',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ShieldCheck size={24} />
              </div>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: '700', color: '#0f172a', margin: 0 }}>
                  Anti-Oversell Concurrency
                </h3>
                <span style={{ fontSize: '0.78rem', color: '#059669', fontWeight: '600' }}>
                  Conditional Row-Level Locks
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.9rem', color: '#334155', lineHeight: 1.6, margin: 0 }}>
              Inventory counters decrement using conditional predicates (
              <code style={{ color: '#1d4ed8', backgroundColor: '#eff6ff', padding: '2px 6px', borderRadius: '4px', fontSize: '0.85rem' }}>
                available_seats &gt;= requested
              </code>
              ). Racing customers attempting to purchase the same seat are safely rejected with zero database corruption.
            </p>
          </div>

          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: '16px',
              padding: '1.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
              transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '12px',
                  backgroundColor: '#eff6ff',
                  color: '#1d4ed8',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Zap size={24} />
              </div>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: '700', color: '#0f172a', margin: 0 }}>
                  CQRS Read Projections
                </h3>
                <span style={{ fontSize: '0.78rem', color: '#1d4ed8', fontWeight: '600' }}>
                  Decoupled Search Replica (:5433)
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.9rem', color: '#334155', lineHeight: 1.6, margin: 0 }}>
              Flight queries and complex filters execute directly on a dedicated denormalized read model.
              Traffic spikes from millions of casual searchers never degrade transactional booking coordinator performance.
            </p>
          </div>

          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: '16px',
              padding: '1.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
              transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '12px',
                  backgroundColor: '#f5f3ff',
                  color: '#7c3aed',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Cpu size={24} />
              </div>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: '700', color: '#0f172a', margin: 0 }}>
                  Transactional Outbox & Sagas
                </h3>
                <span style={{ fontSize: '0.78rem', color: '#7c3aed', fontWeight: '600' }}>
                  Guaranteed Event Delivery
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.9rem', color: '#334155', lineHeight: 1.6, margin: 0 }}>
              Booking creation and event publishing occur atomically inside a single ACID transaction.
              Background saga reconcilers automatically release expired seat reservations and trigger asynchronous notifications.
            </p>
          </div>
        </div>
      </section>

      {/* Featured Global Routes */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '1.65rem', fontWeight: '800', color: '#0f172a', marginBottom: '0.35rem' }}>
              Popular Flight Routes
            </h2>
            <p style={{ fontSize: '0.92rem', color: '#475569' }}>
              Explore real-time seat availability across major international airline corridors
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/flights/search')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.9rem',
              fontWeight: '700',
              color: '#1d4ed8',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <span>View All Scheduled Flights</span>
            <ArrowRight size={16} />
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1.25rem',
          }}
        >
          {popularRoutes.map((r, idx) => (
            <div
              key={idx}
              onClick={() => handleQuickRoute(r)}
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '16px',
                padding: '1.5rem',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                display: 'flex',
                flexDirection: 'column',
                gap: '1.1rem',
                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.03)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-3px)';
                e.currentTarget.style.boxShadow = '0 10px 25px -4px rgba(29, 78, 216, 0.1)';
                e.currentTarget.style.borderColor = '#93c5fd';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'none';
                e.currentTarget.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.03)';
                e.currentTarget.style.borderColor = '#e2e8f0';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: '700',
                    color: '#1d4ed8',
                    backgroundColor: '#eff6ff',
                    padding: '3px 8px',
                    borderRadius: '6px',
                  }}
                >
                  {r.badge}
                </span>
                <span style={{ fontSize: '1.15rem', fontWeight: '800', color: '#059669' }}>
                  {r.price}
                </span>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', marginBottom: '0.35rem' }}>
                  <span style={{ fontSize: '1.4rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
                    {r.origin}
                  </span>
                  <Plane size={18} style={{ color: '#1d4ed8', transform: 'rotate(90deg)' }} />
                  <span style={{ fontSize: '1.4rem', fontWeight: '800', color: '#0f172a', fontFamily: 'var(--font-mono)' }}>
                    {r.destination}
                  </span>
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: '600', color: '#334155' }}>
                  {r.cityName}
                </div>
                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.2rem' }}>
                  {r.aircraft} • {r.duration} • Non-stop
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontSize: '0.88rem',
                  fontWeight: '700',
                  color: '#1d4ed8',
                  marginTop: 'auto',
                  paddingTop: '0.5rem',
                  borderTop: '1px dashed #e2e8f0',
                }}
              >
                <span>Check Live Seat Map</span>
                <ArrowRight size={15} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Assurance & Live Test Lab CTA Banner */}
      <section
        style={{
          backgroundColor: '#0f172a',
          borderRadius: '20px',
          padding: '2.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '2rem',
          color: '#ffffff',
          boxShadow: '0 10px 25px -5px rgba(15, 23, 42, 0.25)',
        }}
      >
        <div style={{ maxWidth: '650px', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: '#38bdf8', fontSize: '0.82rem', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <Activity size={16} />
            <span>Real-Time Concurrency Test Laboratory</span>
          </div>
          <h3 style={{ fontSize: '1.65rem', fontWeight: '800', color: '#ffffff', margin: 0 }}>
            Want to simulate a 500-concurrency booking storm?
          </h3>
          <p style={{ fontSize: '0.95rem', color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>
            Inspect raw PostgreSQL Citus shard counters, simulate racing concurrent shoppers contesting the final 2 seats,
            and monitor zero-oversell proof verified live in the system control room.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            size="lg"
            onClick={() => navigate('/admin/lab')}
            style={{
              backgroundColor: '#2563eb',
              borderColor: '#3b82f6',
              fontWeight: '700',
              padding: '0.75rem 1.6rem',
              borderRadius: '12px',
            }}
          >
            <span>Open Control Room & Tests</span>
            <ArrowRight size={16} />
          </Button>
        </div>
      </section>
    </div>
  );
}
