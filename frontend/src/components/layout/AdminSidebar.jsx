import React from 'react';
import { NavLink, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  Zap,
  ShieldCheck,
  CheckCircle2,
  ArrowUpRight
} from 'lucide-react';

export default function AdminSidebar() {
  const sections = [
    {
      title: 'Operations',
      items: [
        { to: '/admin/dashboard', label: 'Overview Dashboard', icon: LayoutDashboard },
        { to: '/admin/lab', label: 'Testing & 1M Load Center', icon: Zap, badge: 'LIVE', badgeColor: '#1d4ed8' },
      ],
    },
  ];

  return (
    <aside
      style={{
        width: '260px',
        flexShrink: 0,
        backgroundColor: '#ffffff',
        borderRight: '1px solid #e2e8f0',
        height: 'calc(100vh - var(--header-height))',
        position: 'sticky',
        top: 'var(--header-height)',
        padding: '1.25rem 1.15rem',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        zIndex: 50,
      }}
    >
      {/* Top Section: Operations Hub Header & Navigation */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Operations Hub Header */}
        <div
          style={{
            paddingBottom: '0.85rem',
            borderBottom: '1px solid #f1f5f9',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span
              style={{
                fontSize: '0.7rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: '#1d4ed8',
                fontWeight: '800',
              }}
            >
              Management Console
            </span>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '0.68rem',
                backgroundColor: '#ecfdf5',
                color: '#059669',
                padding: '2px 8px',
                borderRadius: '12px',
                fontWeight: '700',
                border: '1px solid #a7f3d0'
              }}
            >
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#059669' }} />
              ACTIVE
            </div>
          </div>
          <div style={{ fontSize: '1.05rem', fontWeight: '800', color: '#0f172a', marginTop: '0.3rem' }}>
            Airline Administration
          </div>
        </div>

        {/* Navigation Sections */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <div
            style={{
              fontSize: '0.68rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: '#64748b',
              fontWeight: '700',
              paddingLeft: '0.4rem',
              marginBottom: '0.15rem',
            }}
          >
            Operations
          </div>

          {sections[0].items.map((item) => {
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
                  borderRadius: '10px',
                  fontSize: '0.88rem',
                  fontWeight: isActive ? '700' : '600',
                  color: isActive ? '#1d4ed8' : '#475569',
                  backgroundColor: isActive ? '#eff6ff' : 'transparent',
                  border: isActive ? '1px solid #bfdbfe' : '1px solid transparent',
                  transition: 'all 0.15s ease',
                  textDecoration: 'none',
                })}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                  <Icon size={18} />
                  <span>{item.label}</span>
                </div>

                {item.badge && (
                  <span
                    style={{
                      fontSize: '0.65rem',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: '800',
                      padding: '2px 7px',
                      borderRadius: '6px',
                      backgroundColor: item.badgeColor ? `${item.badgeColor}15` : '#eff6ff',
                      color: item.badgeColor || '#1d4ed8',
                      border: `1px solid ${item.badgeColor ? `${item.badgeColor}40` : '#bfdbfe'}`,
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      </div>

      {/* Fixed Bottom Section: System Integrity & Cluster Safety Card */}
      <div
        style={{
          marginTop: 'auto',
          padding: '1rem',
          backgroundColor: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.6rem',
          boxShadow: '0 2px 8px rgba(16, 185, 129, 0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <ShieldCheck size={16} color="#16a34a" />
            <span style={{ fontSize: '0.72rem', color: '#15803d', textTransform: 'uppercase', fontWeight: '800', letterSpacing: '0.04em' }}>
              System Integrity
            </span>
          </div>
          <span style={{ fontSize: '0.68rem', color: '#15803d', fontWeight: '800', background: '#dcfce7', padding: '1px 6px', borderRadius: '4px', border: '1px solid #a7f3d0' }}>
            100% ONLINE
          </span>
        </div>

        <div>
          <div style={{ fontSize: '0.84rem', fontWeight: '800', color: '#0f172a', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#16a34a' }} />
            Zero-Oversell Active
          </div>
          <div style={{ fontSize: '0.73rem', color: '#475569', lineHeight: 1.45, marginTop: '0.2rem' }}>
            Row-locked transaction safety & saga reconciliation verified.
          </div>
        </div>

        <div style={{ borderTop: '1px solid #dcfce7', paddingTop: '0.45rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: '#166534' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>Write Coordinator:</span>
            <span style={{ fontWeight: '700' }}>Port 55432</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#64748b' }}>CQRS Read Model:</span>
            <span style={{ fontWeight: '700' }}>Port 5433</span>
          </div>
        </div>

        <Link
          to="/admin/lab"
          style={{
            marginTop: '0.2rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.35rem',
            fontSize: '0.74rem',
            fontWeight: '700',
            color: '#15803d',
            backgroundColor: '#ffffff',
            border: '1px solid #a7f3d0',
            borderRadius: '8px',
            padding: '0.4rem 0.65rem',
            textDecoration: 'none',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#ecfdf5'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
        >
          <span>Open Control Room & Tests</span>
          <ArrowUpRight size={13} />
        </Link>
      </div>
    </aside>
  );
}
