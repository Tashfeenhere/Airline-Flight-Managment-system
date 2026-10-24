import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

// Layout
import PageWrapper from './components/layout/PageWrapper';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AdminRoute from './components/auth/AdminRoute';

// Public Pages
import HomePage from './pages/public/HomePage';
import SearchResultsPage from './pages/public/SearchResultsPage';
import FlightDetailPage from './pages/public/FlightDetailPage';
import NotFoundPage from './pages/public/NotFoundPage';

// Auth Pages
import SignUpPage from './pages/auth/SignUpPage';
import SignInPage from './pages/auth/SignInPage';
import EmailVerificationPage from './pages/auth/EmailVerificationPage';
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage';

// Passenger / Protected Pages
import BookingCheckoutPage from './pages/passenger/BookingCheckoutPage';
import BookingConfirmationPage from './pages/passenger/BookingConfirmationPage';
import MyBookingsPage from './pages/passenger/MyBookingsPage';
import BookingDetailPage from './pages/passenger/BookingDetailPage';
import BookingByReferencePage from './pages/passenger/BookingByReferencePage';
import ProfilePage from './pages/passenger/ProfilePage';

// Admin Pages
import AdminDashboardPage from './pages/admin/AdminDashboardPage';
import AdminFlightsPage from './pages/admin/AdminFlightsPage';
import AdminCreateFlightPage from './pages/admin/AdminCreateFlightPage';
import AdminInventoryAuditPage from './pages/admin/AdminInventoryAuditPage';
import AdminOutboxStatsPage from './pages/admin/AdminOutboxStatsPage';
import AdminPartitionsPage from './pages/admin/AdminPartitionsPage';
import AdminTopologyPage from './pages/admin/AdminTopologyPage';
import AdminReprojectionPage from './pages/admin/AdminReprojectionPage';

export default function App() {
  return (
    <BrowserRouter>
      <PageWrapper>
        <Routes>
          {/* Public Routes */}
          <Route path="/" element={<HomePage />} />
          <Route path="/flights/search" element={<SearchResultsPage />} />
          <Route path="/flights/:flightId" element={<FlightDetailPage />} />

          {/* Auth Routes */}
          <Route path="/auth/signup" element={<SignUpPage />} />
          <Route path="/auth/signin" element={<SignInPage />} />
          <Route path="/auth/verify-email" element={<EmailVerificationPage />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />

          {/* Passenger / Agent Protected Routes */}
          <Route
            path="/flights/:flightId/book"
            element={
              <ProtectedRoute>
                <BookingCheckoutPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/bookings/:bookingId/confirmation"
            element={
              <ProtectedRoute>
                <BookingConfirmationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/my-bookings"
            element={
              <ProtectedRoute>
                <MyBookingsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/bookings/:bookingId"
            element={
              <ProtectedRoute>
                <BookingDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/bookings/reference/:ref"
            element={
              <ProtectedRoute>
                <BookingByReferencePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <ProfilePage />
              </ProtectedRoute>
            }
          />

          {/* Admin Protected Routes */}
          <Route
            path="/admin/dashboard"
            element={
              <AdminRoute>
                <AdminDashboardPage />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/flights"
            element={
              <AdminRoute>
                <AdminFlightsPage />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/flights/create"
            element={
              <AdminRoute>
                <AdminCreateFlightPage />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/inventory/audit"
            element={
              <AdminRoute>
                <AdminInventoryAuditPage />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/outbox"
            element={
              <AdminRoute>
                <AdminOutboxStatsPage />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/partitions"
            element={
              <AdminRoute>
                <AdminPartitionsPage />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/topology"
            element={
              <AdminRoute>
                <AdminTopologyPage />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/projections"
            element={
              <AdminRoute>
                <AdminReprojectionPage />
              </AdminRoute>
            }
          />

          {/* Fallback 404 Route */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </PageWrapper>
    </BrowserRouter>
  );
}
