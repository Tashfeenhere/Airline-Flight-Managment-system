import React from 'react';
import Navbar from './Navbar';
import Footer from './Footer';

export default function PageWrapper({ children, fullWidth = false }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
      }}
    >
      <Navbar />
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          paddingBottom: '3rem',
        }}
      >
        {fullWidth ? children : <div className="container" style={{ flex: 1, paddingTop: '2rem' }}>{children}</div>}
      </main>
      <Footer />
    </div>
  );
}
