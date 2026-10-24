import React from 'react';
import { User, Mail, Shield, Phone, Key, LogOut } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';

export default function ProfilePage() {
  const { user, logout } = useAuthStore();

  return (
    <div
      style={{
        maxWidth: '680px',
        margin: '2rem auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '2rem',
      }}
    >
      <div>
        <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
          Account & Traveler Profile
        </h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Manage your credentials, role privileges, and active session tokens.
        </p>
      </div>

      <div
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '2rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '1.25rem' }}>
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              backgroundColor: 'var(--accent-primary)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: '800',
              fontSize: '1.4rem',
            }}
          >
            {user?.fullName ? user.fullName[0].toUpperCase() : 'U'}
          </div>
          <div>
            <div style={{ fontSize: '1.3rem', fontWeight: '700' }}>{user?.fullName || 'Traveler'}</div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{user?.email}</div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <Badge status={user?.role || 'PASSENGER'} size="lg" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
          <div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Account Identifier
            </span>
            <div style={{ fontSize: '0.9rem', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', marginTop: '0.2rem' }}>
              {user?.userId || 'usr-local-dev'}
            </div>
          </div>

          <div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Assigned Role
            </span>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginTop: '0.2rem', fontWeight: '600' }}>
              {user?.role || 'PASSENGER'}
            </div>
          </div>

          <div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Contact Phone
            </span>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginTop: '0.2rem' }}>
              {user?.phone || 'Not configured'}
            </div>
          </div>

          <div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Token Rotation Mode
            </span>
            <div style={{ fontSize: '0.9rem', color: 'var(--status-success)', marginTop: '0.2rem', fontWeight: '500' }}>
              Single-use Family Rotation Active
            </div>
          </div>
        </div>

        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: '1.25rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Revokes active refresh token and invalidates device credentials.
          </span>
          <Button variant="danger" size="sm" icon={LogOut} onClick={logout}>
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}
