import React from 'react';
import { useLocation } from 'react-router-dom';
import Navbar from './Navbar';
import Footer from './Footer';

export default function PageWrapper({ children, fullWidth = false }) {
  const location = useLocation();

  // Dashboard routes require flush edge-to-edge layout with docked sidebar and no marketing footer
  const isDashboardRoute =
    location.pathname.startsWith('/admin') ||
    location.pathname === '/my-bookings' ||
    location.pathname === '/profile';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      <Navbar />
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
        }}
      >
        {isDashboardRoute || fullWidth ? (
          children
        ) : (
          <div className="container" style={{ flex: 1, paddingTop: '1.75rem', paddingBottom: '3.5rem' }}>
            {children}
          </div>
        )}
      </main>
      {/* Hide marketing footer on dashboard routes to keep the sidebar & viewport intact */}
      {!isDashboardRoute && <Footer />}
    </div>
  );
}
