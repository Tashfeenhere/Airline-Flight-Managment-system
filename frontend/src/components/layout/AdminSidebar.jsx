import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  PlaneTakeoff,
  PlusCircle,
  ShieldAlert,
  Inbox,
  Network,
  Layers,
  RotateCcw,
} from 'lucide-react';

export default function AdminSidebar() {
  const navItems = [
    { to: '/admin/dashboard', label: 'Cluster Overview', icon: LayoutDashboard },
    { to: '/admin/flights', label: 'Manage Flights', icon: PlaneTakeoff },
    { to: '/admin/flights/create', label: 'Create Flight', icon: PlusCircle },
    { to: '/admin/inventory/audit', label: 'Oversell Audit', icon: ShieldAlert },
    { to: '/admin/outbox', label: 'Outbox Monitor', icon: Inbox },
    { to: '/admin/topology', label: 'Citus Shard Map', icon: Network },
    { to: '/admin/partitions', label: 'Partitions Horizon', icon: Layers },
    { to: '/admin/projections', label: 'Read-Model Reproject', icon: RotateCcw },
  ];

  return (
    <aside
      style={{
        width: '260px',
        flexShrink: 0,
        backgroundColor: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-color)',
        minHeight: 'calc(100vh - var(--header-height))',
        padding: '1.5rem 1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      <div
        style={{
          padding: '0 0.75rem 1rem 0.75rem',
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: '0.5rem',
        }}
      >
        <div
          style={{
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-muted)',
            fontWeight: '700',
          }}
        >
          Operations Center
        </div>
        <div style={{ fontSize: '0.95rem', fontWeight: '600', color: '#c084fc' }}>
          Cluster Admin Panel
        </div>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.65rem 0.85rem',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.9rem',
                fontWeight: isActive ? '600' : '500',
                color: isActive ? '#ffffff' : 'var(--text-secondary)',
                backgroundColor: isActive ? 'var(--accent-primary)' : 'transparent',
                transition: 'all var(--transition-fast)',
                textDecoration: 'none',
              })}
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
