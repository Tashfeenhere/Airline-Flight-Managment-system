import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import Alert from '../ui/Alert';
import Button from '../ui/Button';

export default function AdminRoute({ children }) {
  const { isAuthenticated, isAdmin } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated()) {
    return <Navigate to="/auth/signin" state={{ from: location }} replace />;
  }

  if (!isAdmin()) {
    return (
      <div className="container" style={{ paddingTop: '4rem', maxWidth: '600px' }}>
        <Alert
          variant="danger"
          title="Access Restricted: Administrator Privileges Required"
        >
          Your current account does not have operator role clearance to access cluster
          infrastructure, shard topologies, or financial audits.
          <div style={{ marginTop: '1.25rem' }}>
            <Button variant="secondary" onClick={() => window.history.back()}>
              Return to Previous Page
            </Button>
          </div>
        </Alert>
      </div>
    );
  }

  return children;
}
