import React from 'react';
import { NavLink, Link } from 'react-router-dom';
import {
  Ticket,
  Compass,
  User,
  ShieldCheck,
  Plane,
  Sparkles,
  ArrowRight,
  Star,
  CheckCircle2,
  ExternalLink
} from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';

export default function PassengerSidebar({ activeTab = 'bookings' }) {
  const { user } = useAuthStore();

  const navItems = [
    { to: '/my-bookings', label: 'My Reservations', icon: Ticket, badge: 'ACTIVE' },
    { to: '/flights/search', label: 'Search Flights', icon: Compass },
    { to: '/profile', label: 'Account & Security', icon: User },
  ];

  return (
    <aside
      style={{
        width: '280px',
        flexShrink: 0,
        backgroundColor: '#ffffff',
        borderRight: '1px solid #e2e8f0',
        height: 'calc(100vh - var(--header-height))',
        position: 'sticky',
        top: 'var(--header-height)',
        padding: '1.25rem 1rem',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: '1.25rem',
        overflowY: 'auto',
        boxShadow: '1px 0 3px rgba(0, 0, 0, 0.02)',
        zIndex: 40,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Passenger Profile Card */}
        <div
          style={{
            padding: '1rem',
            background: 'linear-gradient(135deg, #f0fdf4 0%, #eff6ff 100%)',
            border: '1px solid #bfdbfe',
            borderRadius: '12px',
            boxShadow: '0 1px 3px rgba(29, 78, 216, 0.04)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.65rem' }}>
            <span
              style={{
                fontSize: '0.68rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: '#1d4ed8',
                fontWeight: '800',
              }}
            >
              Passenger Portal
            </span>
            <span
              style={{
                fontSize: '0.68rem',
                backgroundColor: '#ecfdf5',
                color: '#059669',
                border: '1px solid #a7f3d0',
                padding: '2px 7px',
                borderRadius: '9999px',
                fontWeight: '800',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <CheckCircle2 size={10} />
              VERIFIED
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #1d4ed8 0%, #0284c7 100%)',
                color: '#ffffff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: '800',
                fontSize: '0.95rem',
                flexShrink: 0,
                boxShadow: '0 2px 6px rgba(29, 78, 216, 0.25)',
              }}
            >
              {user?.fullName ? user.fullName[0].toUpperCase() : 'T'}
            </div>
            <div style={{ overflow: 'hidden' }}>
              <div
                style={{
                  fontSize: '0.92rem',
                  fontWeight: '800',
                  color: '#0f172a',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {user?.fullName || 'Traveler Account'}
              </div>
              <div
                style={{
                  fontSize: '0.74rem',
                  color: '#64748b',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {user?.email || 'traveler@aeroscale.internal'}
              </div>
            </div>
          </div>

          {/* Tier Badge */}
          <div
            style={{
              marginTop: '0.75rem',
              paddingTop: '0.6rem',
              borderTop: '1px solid rgba(191, 219, 254, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '0.72rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#b45309', fontWeight: '700' }}>
              <Star size={12} fill="#f59e0b" color="#f59e0b" />
              <span>SkyClub Diamond</span>
            </div>
            <span style={{ color: '#1d4ed8', fontWeight: '800', fontFamily: 'var(--font-mono)' }}>14,250 Miles</span>
          </div>
        </div>

        {/* Navigation */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <div
            style={{
              fontSize: '0.68rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: '#94a3b8',
              fontWeight: '800',
              paddingLeft: '0.65rem',
              marginBottom: '0.2rem',
            }}
          >
            Travel Portal
          </div>

          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.65rem 0.85rem',
                  borderRadius: '8px',
                  fontSize: '0.88rem',
                  fontWeight: isActive ? '700' : '600',
                  color: isActive ? '#1d4ed8' : '#334155',
                  backgroundColor: isActive ? '#eff6ff' : 'transparent',
                  border: isActive ? '1px solid #bfdbfe' : '1px solid transparent',
                  transition: 'all 0.15s ease',
                  textDecoration: 'none',
                })}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                  <Icon size={16} />
                  <span>{item.label}</span>
                </div>

                {item.badge && (
                  <span
                    style={{
                      fontSize: '0.65rem',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: '800',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: '#dbeafe',
                      color: '#1e40af',
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Quick Route Presets */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <div
            style={{
              fontSize: '0.68rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: '#94a3b8',
              fontWeight: '800',
              paddingLeft: '0.65rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>Popular Flight Routes</span>
            <Plane size={11} color="#64748b" />
          </div>

          {[
            { origin: 'ISB', dest: 'DXB', label: 'Islamabad → Dubai', price: '$380' },
            { origin: 'ISB', dest: 'LHR', label: 'Islamabad → London', price: '$650' },
            { origin: 'JFK', dest: 'LHR', label: 'New York → London', price: '$850' },
          ].map((r, idx) => (
            <Link
              key={idx}
              to={`/flights/search?origin=${r.origin}&destination=${r.dest}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.55rem 0.75rem',
                backgroundColor: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                fontSize: '0.78rem',
                color: '#334155',
                textDecoration: 'none',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#eff6ff';
                e.currentTarget.style.borderColor = '#bfdbfe';
                e.currentTarget.style.transform = 'translateX(2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#f8fafc';
                e.currentTarget.style.borderColor = '#e2e8f0';
                e.currentTarget.style.transform = 'none';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#0284c7' }} />
                <span style={{ fontWeight: 600 }}>{r.label}</span>
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#059669', fontSize: '0.72rem' }}>
                {r.price}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* Live Distributed Ticket Guarantee Widget */}
      <div
        style={{
          padding: '0.9rem',
          backgroundColor: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.45rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#15803d', fontSize: '0.78rem', fontWeight: '800' }}>
            <ShieldCheck size={16} />
            <span>Zero-Oversell Guarantee</span>
          </div>
          <span style={{ fontSize: '0.68rem', fontWeight: 800, color: '#15803d', background: '#dcfce7', padding: '1px 5px', borderRadius: '4px' }}>
            100% ACID
          </span>
        </div>
        <p style={{ fontSize: '0.73rem', color: '#166534', lineHeight: '1.45', margin: 0 }}>
          Your confirmed seats are committed in real-time to Citus distributed worker ledgers. Double-booking is mathematically impossible.
        </p>
      </div>
    </aside>
  );
}
