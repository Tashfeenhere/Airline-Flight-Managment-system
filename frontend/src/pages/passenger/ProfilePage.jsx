import React from 'react';
import {
  User,
  Mail,
  Shield,
  Phone,
  Key,
  LogOut,
  CheckCircle2,
  ShieldCheck,
  Radio,
  Star,
  Plane,
  Lock,
  Database,
  Award,
  CreditCard,
  Sparkles
} from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import PassengerSidebar from '../../components/layout/PassengerSidebar';
import Badge from '../../components/ui/Badge';
import Button from '../../components/ui/Button';

export default function ProfilePage() {
  const { user, logout } = useAuthStore();

  return (
    <div style={{ display: 'flex', width: '100%', minHeight: 'calc(100vh - var(--header-height))', backgroundColor: '#f8fafc' }}>
      <PassengerSidebar activeTab="profile" />

      <div style={{ flex: 1, padding: '2rem 2.5rem', display: 'flex', flexDirection: 'column', gap: '1.75rem', maxWidth: '1080px', boxSizing: 'border-box' }}>
        {/* Header Banner */}
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '16px',
            padding: '1.75rem 2rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <span
                style={{
                  fontSize: '0.72rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontWeight: 800,
                  color: '#1d4ed8',
                  backgroundColor: '#eff6ff',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  border: '1px solid #bfdbfe',
                }}
              >
                Traveler Profile & Security
              </span>
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  color: '#059669',
                  background: '#ecfdf5',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  border: '1px solid #a7f3d0',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <CheckCircle2 size={11} /> Cryptographically Hardened
              </span>
            </div>
            <h1 style={{ fontSize: '1.85rem', fontWeight: 800, color: '#0f172a', margin: '0 0 0.35rem 0', letterSpacing: '-0.02em' }}>
              Account & Traveler Identity
            </h1>
            <p style={{ fontSize: '0.88rem', color: '#64748b', margin: 0, maxWidth: '640px', lineHeight: 1.5 }}>
              Review your verified passenger credentials, loyalty mileage status, and Citus distributed database allocation.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                background: '#fffbeb',
                border: '1px solid #fde68a',
                color: '#b45309',
                padding: '6px 12px',
                borderRadius: '8px',
                fontWeight: 700,
                fontSize: '0.82rem',
              }}
            >
              <Star size={14} fill="#f59e0b" color="#f59e0b" />
              <span>SkyClub Diamond Elite</span>
            </span>
          </div>
        </div>

        {/* User Identity Card */}
        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '16px',
            padding: '2rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.75rem',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
          }}
        >
          {/* User Avatar & Name Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid #f1f5f9',
              paddingBottom: '1.5rem',
              flexWrap: 'wrap',
              gap: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
              <div
                style={{
                  width: '68px',
                  height: '68px',
                  borderRadius: '18px',
                  background: 'linear-gradient(135deg, #1d4ed8 0%, #0284c7 100%)',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 800,
                  fontSize: '1.75rem',
                  boxShadow: '0 4px 12px rgba(29, 78, 216, 0.25)',
                }}
              >
                {user?.fullName ? user.fullName[0].toUpperCase() : 'T'}
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <h2 style={{ fontSize: '1.35rem', fontWeight: 800, color: '#0f172a', margin: 0 }}>
                    {user?.fullName || 'Verified Traveler'}
                  </h2>
                  <span
                    style={{
                      background: '#ecfdf5',
                      color: '#059669',
                      fontSize: '0.72rem',
                      fontWeight: 800,
                      padding: '2px 8px',
                      borderRadius: '12px',
                      border: '1px solid #a7f3d0',
                    }}
                  >
                    ACTIVE
                  </span>
                </div>
                <div style={{ fontSize: '0.86rem', color: '#64748b', marginTop: '2px' }}>{user?.email || 'traveler@aeroscale.internal'}</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Badge status={user?.role || 'PASSENGER'} size="lg" />
            </div>
          </div>

          {/* Profile Details Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
            <div style={{ backgroundColor: '#f8fafc', padding: '1.1rem', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <span style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
                <User size={13} color="#1d4ed8" /> Traveler Identifier
              </span>
              <div style={{ fontSize: '0.92rem', fontFamily: 'var(--font-mono)', color: '#1d4ed8', marginTop: '0.35rem', fontWeight: 700 }}>
                {user?.userId || 'usr-local-dev-ada'}
              </div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>Citus Sharded User Key</div>
            </div>

            <div style={{ backgroundColor: '#f8fafc', padding: '1.1rem', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <span style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Award size={13} color="#d97706" /> SkyClub Mileage Balance
              </span>
              <div style={{ fontSize: '0.95rem', color: '#b45309', marginTop: '0.35rem', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                14,250 Elite Miles
              </div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>Complimentary Lounge Access</div>
            </div>

            <div style={{ backgroundColor: '#f8fafc', padding: '1.1rem', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <span style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
                <ShieldCheck size={13} color="#059669" /> Password Security
              </span>
              <div style={{ fontSize: '0.88rem', color: '#059669', marginTop: '0.35rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <CheckCircle2 size={13} /> Argon2id (64MB Hardened)
              </div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>Memory-bound GPU resistant</div>
            </div>

            <div style={{ backgroundColor: '#f8fafc', padding: '1.1rem', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
              <span style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Database size={13} color="#0284c7" /> Ledger Shard Node
              </span>
              <div style={{ fontSize: '0.88rem', color: '#0f172a', marginTop: '0.35rem', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                Shard Hash (Worker 1 & 2)
              </div>
              <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>Auto-replicated reference model</div>
            </div>
          </div>

          {/* Traveler Preferences Section */}
          <div>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 800, color: '#0f172a', marginBottom: '0.75rem' }}>
              Travel Preferences & Fast Track Documents
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.85rem' }}>
              <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.85rem 1rem', background: '#ffffff' }}>
                <div style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>Passport & Identity</div>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#0f172a', marginTop: '2px' }}>Verified on File (AeroPass)</div>
              </div>

              <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.85rem 1rem', background: '#ffffff' }}>
                <div style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>TSA PreCheck / KTN</div>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#059669', marginTop: '2px' }}>Active • KTN-882194</div>
              </div>

              <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.85rem 1rem', background: '#ffffff' }}>
                <div style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>Seating Preference</div>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#0f172a', marginTop: '2px' }}>Forward Cabin / Window</div>
              </div>
            </div>
          </div>

          {/* Sign Out & Session Security */}
          <div
            style={{
              borderTop: '1px solid #f1f5f9',
              paddingTop: '1.25rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '1rem',
            }}
          >
            <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
              Signing out invalidates your active cryptographic JWT refresh token family across all nodes.
            </div>
            <button
              onClick={logout}
              style={{
                background: '#ffffff',
                border: '1px solid #fecaca',
                color: '#dc2626',
                padding: '0.55rem 1.15rem',
                borderRadius: '8px',
                fontSize: '0.84rem',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fef2f2'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
            >
              <LogOut size={15} />
              <span>Sign Out Everywhere</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
