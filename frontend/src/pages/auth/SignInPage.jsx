import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Plane, Mail, Lock, Shield, User, KeyRound, ArrowRight } from 'lucide-react';
import { authApi } from '../../api/auth';
import { useAuthStore } from '../../stores/authStore';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';

export default function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setAuth } = useAuthStore();

  const [email, setEmail] = useState('ada.lovelace@example.com');
  const [password, setPassword] = useState('S3cur3-Pa$$w0rd');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // 2FA State
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [tempToken, setTempToken] = useState(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [devCode, setDevCode] = useState(null);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState(null);

  const from = location.state?.from?.pathname || null;

  const completeAuth = (data) => {
    setAuth({
      user: data.user,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    });

    if (from) {
      navigate(from, { replace: true });
    } else if (data.user.role === 'ADMIN') {
      navigate('/admin/dashboard', { replace: true });
    } else {
      navigate('/my-bookings', { replace: true });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (twoFactorRequired) {
        // Step 2: Validate 2FA Security Code
        const res = await authApi.verify2FA({ tempToken, code: twoFactorCode.trim() });
        if (res.success && res.data) {
          completeAuth(res.data);
        }
      } else {
        // Step 1: Submit email & password
        const res = await authApi.login({ email, password });
        if (res.success && res.data) {
          if (res.data.requires2FA) {
            setTwoFactorRequired(true);
            setTempToken(res.data.tempToken);
            setDevCode(res.data.devCode || null);
          } else {
            completeAuth(res.data);
          }
        }
      }
    } catch (err) {
      setError(
        err.error?.message || err.message || 'Invalid credentials or verification code.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleResend2FA = async () => {
    setResending(true);
    setResendMsg(null);
    setError(null);
    try {
      const res = await authApi.resendCode({ tempToken, email, type: 'LOGIN_2FA' });
      if (res.success) {
        setResendMsg('A fresh verification code has been dispatched to your email.');
        if (res.data?.devCode) setDevCode(res.data.devCode);
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Failed to resend code.');
    } finally {
      setResending(false);
    }
  };

  const handleQuickPassenger = () => {
    setTwoFactorRequired(false);
    setEmail('ada.lovelace@example.com');
    setPassword('S3cur3-Pa$$w0rd');
  };

  const handleQuickAdmin = () => {
    setTwoFactorRequired(false);
    setEmail('admin.operator@aeroscale.internal');
    setPassword('Citus-Admin-2026!');
  };

  return (
    <div
      style={{
        maxWidth: '440px',
        margin: '2.5rem auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
      }}
    >
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--accent-primary)',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '0.25rem',
          }}
        >
          <Plane size={24} />
        </div>
        <h1 style={{ fontSize: '1.8rem', fontWeight: '800' }}>Sign In to AeroScale</h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Access your flight itineraries, active bookings, and cluster admin portal.
        </p>
      </div>

      <div
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          padding: '2rem',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {twoFactorRequired ? (
          /* Two-Factor Verification Step */
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {error && <Alert variant="danger">{error}</Alert>}
            {resendMsg && <Alert variant="success">{resendMsg}</Alert>}

            <div style={{ textAlign: 'center', padding: '0.25rem 0' }}>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '52px',
                  height: '52px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent-light)',
                  color: 'var(--accent-primary)',
                  marginBottom: '0.75rem',
                }}
              >
                <Shield size={28} />
              </div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '0.35rem' }}>
                Two-Factor Authentication
              </h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                A 6-digit security code was dispatched to{' '}
                <strong style={{ color: 'var(--text-primary)' }}>{email}</strong> via Gmail.
              </p>
            </div>

            {devCode && (
              <div
                style={{
                  padding: '0.75rem 1rem',
                  backgroundColor: 'rgba(37, 99, 235, 0.12)',
                  border: '1px solid rgba(59, 130, 246, 0.3)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.82rem',
                  color: '#60a5fa',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>Development Code:</span>
                <strong style={{ fontFamily: 'var(--font-mono)', letterSpacing: '2px', fontSize: '1rem', color: '#93c5fd' }}>
                  {devCode}
                </strong>
              </div>
            )}

            <div>
              <Input
                label="Security Code (6 digits)"
                type="text"
                placeholder="123456"
                icon={KeyRound}
                required
                maxLength={6}
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value)}
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              icon={ArrowRight}
              iconPosition="right"
              style={{ width: '100%', marginTop: '0.25rem' }}
            >
              Verify & Complete Sign In
            </Button>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: '0.82rem',
                marginTop: '0.5rem',
                borderTop: '1px solid var(--border-subtle)',
                paddingTop: '1rem',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setTwoFactorRequired(false);
                  setTwoFactorCode('');
                  setError(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: '0.82rem',
                }}
              >
                ← Back to Login
              </button>

              <button
                type="button"
                disabled={resending}
                onClick={handleResend2FA}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent-primary)',
                  cursor: 'pointer',
                  fontWeight: '600',
                  padding: 0,
                  fontSize: '0.82rem',
                }}
              >
                {resending ? 'Sending...' : 'Resend Code'}
              </button>
            </div>
          </form>
        ) : (
          /* Primary Sign-In Form */
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {error && <Alert variant="danger">{error}</Alert>}

            <Input
              label="Email Address"
              type="email"
              placeholder="ada.lovelace@example.com"
              icon={Mail}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                <label
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: '500',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Password
                </label>
                <Link
                  to="/auth/forgot-password"
                  style={{ fontSize: '0.8rem', color: 'var(--accent-primary)' }}
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                type="password"
                placeholder="••••••••"
                icon={Lock}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              style={{ width: '100%', marginTop: '0.5rem' }}
            >
              Sign In
            </Button>

            {/* Quick Demo Pre-fill */}
            <div
              style={{
                borderTop: '1px solid var(--border-subtle)',
                paddingTop: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Quick Demo Login:
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={User}
                  onClick={handleQuickPassenger}
                  style={{ flex: 1 }}
                >
                  Passenger
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Shield}
                  onClick={handleQuickAdmin}
                  style={{ flex: 1, color: '#c084fc' }}
                >
                  Admin
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>

      <div style={{ textAlign: 'center', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
        Do not have an account yet?{' '}
        <Link to="/auth/signup" style={{ color: 'var(--accent-primary)', fontWeight: '600' }}>
          Create passenger account
        </Link>
      </div>
    </div>
  );
}
