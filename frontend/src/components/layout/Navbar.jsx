import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  Plane,
  Compass,
  Ticket,
  Shield,
  User,
  LogOut,
  ChevronDown,
  LayoutDashboard,
  Zap,
  ShieldAlert,
  Layers,
  PlaneTakeoff,
  Eye,
} from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import Badge from '../ui/Badge';

export default function Navbar() {
  const { user, isAuthenticated, isAdmin, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    setProfileOpen(false);
    navigate('/auth/signin');
  };

  const isActive = (path) => location.pathname === path;
  const isDashboard =
    location.pathname.startsWith('/admin') ||
    location.pathname === '/my-bookings' ||
    location.pathname === '/profile';

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        height: 'var(--header-height)',
        backgroundColor: 'rgba(255, 255, 255, 0.98)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--border-color)',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <div
        className={isDashboard ? '' : 'container'}
        style={{
          width: '100%',
          maxWidth: isDashboard ? '100%' : 'var(--max-width)',
          padding: isDashboard ? '0 clamp(1rem, 2vw, 1.75rem)' : '0 1.5rem',
          margin: isDashboard ? '0' : '0 auto',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Brand (Left Column) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', zIndex: 2 }}>
          <Link
            to="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              textDecoration: 'none',
            }}
          >
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #1d4ed8, #2563eb)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                boxShadow: '0 4px 10px rgba(29, 78, 216, 0.25)',
              }}
            >
              <Plane size={20} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span
                style={{
                  fontSize: '1.15rem',
                  fontWeight: '800',
                  letterSpacing: '-0.02em',
                  color: '#0f172a',
                  lineHeight: 1.1,
                }}
              >
                AeroScale
              </span>
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#64748b',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  fontWeight: '700',
                }}
              >
                Airline Inventory System
              </span>
            </div>
          </Link>
        </div>

        {/* Navigation Links - Mathematically Centered via Absolute Position */}
        <nav
          className="navbar-centered-nav"
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            zIndex: 1,
          }}
        >
          {isAdmin() ? (
            /* Admin Operations Segmented Controller */
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                backgroundColor: '#f1f5f9',
                padding: '4px',
                borderRadius: '12px',
                border: '1px solid #e2e8f0',
                gap: '4px',
              }}
            >
              <Link
                to="/admin/dashboard"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  padding: '0.42rem 0.95rem',
                  borderRadius: '8px',
                  fontSize: '0.84rem',
                  fontWeight: isActive('/admin/dashboard') ? '800' : '600',
                  color: isActive('/admin/dashboard') ? '#1d4ed8' : '#64748b',
                  backgroundColor: isActive('/admin/dashboard') ? '#ffffff' : 'transparent',
                  border: isActive('/admin/dashboard') ? '1px solid #cbd5e1' : '1px solid transparent',
                  boxShadow: isActive('/admin/dashboard') ? '0 1px 3px rgba(0, 0, 0, 0.05)' : 'none',
                  transition: 'all 0.15s ease',
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <LayoutDashboard size={14} />
                Operations Dashboard
              </Link>

              <Link
                to="/admin/lab"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  padding: '0.42rem 0.95rem',
                  borderRadius: '8px',
                  fontSize: '0.84rem',
                  fontWeight: isActive('/admin/lab') ? '800' : '600',
                  color: isActive('/admin/lab') ? '#1d4ed8' : '#64748b',
                  backgroundColor: isActive('/admin/lab') ? '#ffffff' : 'transparent',
                  border: isActive('/admin/lab') ? '1px solid #cbd5e1' : '1px solid transparent',
                  boxShadow: isActive('/admin/lab') ? '0 1px 3px rgba(0, 0, 0, 0.05)' : 'none',
                  transition: 'all 0.15s ease',
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <Zap size={14} />
                Testing & 1M Load Center
              </Link>
            </div>
          ) : (
            /* Passenger / Guest Customer Portal Navigation */
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Link
                to="/flights/search"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.45rem 0.95rem',
                  borderRadius: '8px',
                  fontSize: '0.88rem',
                  fontWeight: '600',
                  color: isActive('/flights/search') ? '#1d4ed8' : '#64748b',
                  backgroundColor: isActive('/flights/search') ? '#eff6ff' : 'transparent',
                  transition: 'all var(--transition-fast)',
                  textDecoration: 'none',
                }}
              >
                <Compass size={16} />
                Search Flights
              </Link>

              <Link
                to="/admin/lab"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.45rem 0.95rem',
                  borderRadius: '8px',
                  fontSize: '0.88rem',
                  fontWeight: '600',
                  color: isActive('/admin/lab') ? '#1d4ed8' : '#64748b',
                  backgroundColor: isActive('/admin/lab') ? '#eff6ff' : 'transparent',
                  transition: 'all var(--transition-fast)',
                  textDecoration: 'none',
                }}
              >
                <Zap size={16} />
                Control Room & Tests
              </Link>

              {isAuthenticated() && (
                <Link
                  to="/my-bookings"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.45rem 0.95rem',
                    borderRadius: '8px',
                    fontSize: '0.88rem',
                    fontWeight: '600',
                    color: isActive('/my-bookings') ? '#1d4ed8' : '#64748b',
                    backgroundColor: isActive('/my-bookings') ? '#eff6ff' : 'transparent',
                    transition: 'all var(--transition-fast)',
                    textDecoration: 'none',
                  }}
                >
                  <Ticket size={16} />
                  My Bookings
                </Link>
              )}
            </div>
          )}
        </nav>

        {/* Auth / Profile Area (Right Column) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', zIndex: 2 }}>
          {isAuthenticated() ? (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.65rem',
                  padding: '0.35rem 0.75rem 0.35rem 0.4rem',
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '24px',
                  cursor: 'pointer',
                  color: '#0f172a',
                  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#93c5fd'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e2e8f0'; }}
              >
                {/* Dynamic User Avatar based on Admin vs Passenger */}
                {isAdmin() ? (
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 60%, #2563eb 100%)',
                      color: '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 2px 6px rgba(15, 23, 42, 0.25)',
                      position: 'relative',
                      border: '1.5px solid #ffffff',
                      flexShrink: 0,
                    }}
                  >
                    <Shield size={16} fill="rgba(255,255,255,0.25)" color="#ffffff" />
                    <span
                      style={{
                        position: 'absolute',
                        bottom: '-1px',
                        right: '-1px',
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: '#10b981',
                        border: '2px solid #ffffff',
                        boxShadow: '0 0 4px rgba(16, 185, 129, 0.5)',
                      }}
                    />
                  </div>
                ) : (
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #1d4ed8 0%, #0284c7 100%)',
                      color: '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: '800',
                      fontSize: '0.85rem',
                      boxShadow: '0 2px 6px rgba(29, 78, 216, 0.25)',
                      position: 'relative',
                      border: '1.5px solid #ffffff',
                      flexShrink: 0,
                    }}
                  >
                    {user?.fullName ? user.fullName[0].toUpperCase() : 'T'}
                    <span
                      style={{
                        position: 'absolute',
                        bottom: '-1px',
                        right: '-1px',
                        width: '9px',
                        height: '9px',
                        borderRadius: '50%',
                        backgroundColor: '#10b981',
                        border: '2px solid #ffffff',
                        boxShadow: '0 0 4px rgba(16, 185, 129, 0.5)',
                      }}
                    />
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', lineHeight: 1.15 }}>
                  <span
                    style={{
                      fontWeight: '800',
                      fontSize: '0.82rem',
                      color: '#0f172a',
                      whiteSpace: 'nowrap',
                      maxWidth: '130px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {isAdmin() ? (user?.fullName || 'Executive Admin') : (user?.fullName || 'Traveler Account')}
                  </span>
                  <span
                    style={{
                      fontSize: '0.66rem',
                      color: isAdmin() ? '#64748b' : '#059669',
                      fontWeight: '700',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {isAdmin() ? 'System Operations' : 'SkyClub Member'}
                  </span>
                </div>

                <span
                  style={{
                    background: isAdmin() ? '#eff6ff' : '#ecfdf5',
                    color: isAdmin() ? '#1d4ed8' : '#059669',
                    border: `1px solid ${isAdmin() ? '#bfdbfe' : '#a7f3d0'}`,
                    fontSize: '0.65rem',
                    fontWeight: '800',
                    padding: '2px 7px',
                    borderRadius: '8px',
                    letterSpacing: '0.04em',
                    marginLeft: '2px',
                  }}
                >
                  {isAdmin() ? 'ADMIN' : 'PASSENGER'}
                </span>

                <ChevronDown size={14} style={{ color: '#64748b', transform: profileOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
              </button>

              {profileOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    width: '240px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '14px',
                    boxShadow: '0 10px 25px -5px rgba(15, 23, 42, 0.12), 0 8px 10px -6px rgba(15, 23, 42, 0.08)',
                    padding: '0.65rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.3rem',
                    zIndex: 1010,
                  }}
                >
                  <div
                    style={{
                      padding: '0.6rem 0.75rem',
                      borderBottom: '1px solid #f1f5f9',
                      marginBottom: '0.35rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                      <span style={{ fontSize: '0.68rem', color: '#64748b', textTransform: 'uppercase', fontWeight: '800', letterSpacing: '0.04em' }}>
                        {isAdmin() ? 'Administrator' : 'Verified Traveler'}
                      </span>
                      <span
                        style={{
                          fontSize: '0.62rem',
                          fontWeight: '800',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          background: isAdmin() ? '#eff6ff' : '#ecfdf5',
                          color: isAdmin() ? '#1d4ed8' : '#059669',
                          border: `1px solid ${isAdmin() ? '#bfdbfe' : '#a7f3d0'}`
                        }}
                      >
                        {user?.role || (isAdmin() ? 'ADMIN' : 'PASSENGER')}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: '0.88rem',
                        fontWeight: '800',
                        color: '#0f172a',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {isAdmin() ? (user?.fullName || 'Executive Admin') : (user?.fullName || 'Ada Lovelace')}
                    </div>
                    <div
                      style={{
                        fontSize: '0.74rem',
                        color: '#64748b',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: '1px',
                      }}
                    >
                      {user?.email}
                    </div>
                  </div>

                  {isAdmin() ? (
                    <>
                      <Link
                        to="/admin/dashboard"
                        onClick={() => setProfileOpen(false)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.55rem',
                          padding: '0.5rem 0.75rem',
                          borderRadius: '8px',
                          fontSize: '0.86rem',
                          color: '#1d4ed8',
                          fontWeight: '700',
                          textDecoration: 'none',
                        }}
                        className="menu-item-hover"
                      >
                        <LayoutDashboard size={15} />
                        Operations Dashboard
                      </Link>

                      <Link
                        to="/admin/lab"
                        onClick={() => setProfileOpen(false)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.55rem',
                          padding: '0.5rem 0.75rem',
                          borderRadius: '8px',
                          fontSize: '0.86rem',
                          color: '#0f172a',
                          fontWeight: '600',
                          textDecoration: 'none',
                        }}
                        className="menu-item-hover"
                      >
                        <Zap size={15} color="#1d4ed8" />
                        Testing & 1M Load Center
                      </Link>

                      <Link
                        to="/flights/search"
                        onClick={() => setProfileOpen(false)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.5rem 0.75rem',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.88rem',
                          color: 'var(--text-secondary)',
                          borderTop: '1px solid var(--border-subtle)',
                          marginTop: '0.2rem',
                          paddingTop: '0.5rem',
                        }}
                        className="menu-item-hover"
                      >
                        <Eye size={15} />
                        Preview Passenger View
                      </Link>
                    </>
                  ) : (
                    <>
                      <Link
                        to="/my-bookings"
                        onClick={() => setProfileOpen(false)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.5rem 0.75rem',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.88rem',
                          color: 'var(--text-primary)',
                        }}
                        className="menu-item-hover"
                      >
                        <Ticket size={15} />
                        My Reservations
                      </Link>

                      <Link
                        to="/profile"
                        onClick={() => setProfileOpen(false)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          padding: '0.5rem 0.75rem',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.88rem',
                          color: 'var(--text-primary)',
                        }}
                        className="menu-item-hover"
                      >
                        <User size={15} />
                        Account Settings
                      </Link>
                    </>
                  )}

                  <button
                    onClick={handleLogout}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.88rem',
                      color: 'var(--status-danger)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      width: '100%',
                    }}
                    className="menu-item-hover"
                  >
                    <LogOut size={15} />
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              <Link
                to="/auth/signin"
                style={{
                  fontSize: '0.88rem',
                  fontWeight: '700',
                  color: '#334155',
                  padding: '0.45rem 1rem',
                  borderRadius: '10px',
                  border: '1px solid #cbd5e1',
                  backgroundColor: '#ffffff',
                  textDecoration: 'none',
                  transition: 'all 0.15s ease',
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
                }}
              >
                Sign In
              </Link>
              <Link
                to="/auth/signup"
                style={{
                  fontSize: '0.88rem',
                  fontWeight: '700',
                  color: '#ffffff',
                  backgroundColor: '#1d4ed8',
                  padding: '0.48rem 1.15rem',
                  borderRadius: '10px',
                  textDecoration: 'none',
                  boxShadow: '0 2px 6px rgba(29, 78, 216, 0.28)',
                  transition: 'all 0.15s ease',
                }}
              >
                Register
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
