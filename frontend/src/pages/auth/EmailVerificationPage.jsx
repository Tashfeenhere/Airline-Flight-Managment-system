import React, { useState } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { MailCheck, CheckCircle2, AlertCircle, ArrowRight, KeyRound } from 'lucide-react';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import Alert from '../../components/ui/Alert';
import { authApi } from '../../api/auth';

export default function EmailVerificationPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const emailParam = searchParams.get('email') || '';
  const tokenParam = searchParams.get('token') || '';

  const [email, setEmail] = useState(emailParam);
  const [code, setCode] = useState(tokenParam);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resendStatus, setResendStatus] = useState(null);
  const [resending, setResending] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!email || !code) {
      setError('Please provide both your registered email and the 6-digit verification code.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await authApi.verifyEmail({ email: email.trim(), code: code.trim() });
      if (res.success) {
        setVerified(true);
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Verification failed. Please check the code.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!email) {
      setError('Please enter your email to resend verification code.');
      return;
    }
    setResending(true);
    setResendStatus(null);
    setError(null);
    try {
      const res = await authApi.resendCode({ email: email.trim(), type: 'REGISTER_VERIFY' });
      if (res.success) {
        setResendStatus('A fresh verification code has been dispatched to your email.');
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Failed to resend code.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div
      style={{
        maxWidth: '480px',
        margin: '3.5rem auto',
        width: '100%',
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)',
        padding: '2.5rem',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '1.25rem',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        style={{
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          backgroundColor: verified ? 'var(--status-success-bg)' : 'var(--accent-light)',
          color: verified ? 'var(--status-success)' : 'var(--accent-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {verified ? <CheckCircle2 size={32} /> : <MailCheck size={32} />}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: '800' }}>
          {verified ? 'Email Verified Successfully' : 'Confirm Your Email Address'}
        </h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {verified
            ? 'Your account email has been verified. You now have full access to reservations, itineraries, and booking tools.'
            : 'Enter the 6-digit confirmation code dispatched to your Gmail address below to activate your account.'}
        </p>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}
      {resendStatus && <Alert variant="success">{resendStatus}</Alert>}

      {verified ? (
        <div style={{ width: '100%', marginTop: '1rem' }}>
          <Link to="/auth/signin" style={{ width: '100%', textDecoration: 'none' }}>
            <Button variant="primary" size="lg" icon={ArrowRight} iconPosition="right" style={{ width: '100%' }}>
              Proceed to Sign In
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleVerify} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '1.2rem', marginTop: '0.5rem' }}>
          <Input
            label="Email Address"
            type="email"
            placeholder="name@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <Input
            label="6-Digit Verification Code"
            type="text"
            placeholder="123456"
            icon={KeyRound}
            required
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={loading}
            style={{ width: '100%', marginTop: '0.5rem' }}
          >
            Confirm & Activate Account
          </Button>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.84rem', marginTop: '0.5rem' }}>
            <Link to="/auth/signin" style={{ color: 'var(--text-secondary)' }}>
              ← Return to Sign In
            </Link>

            <button
              type="button"
              disabled={resending}
              onClick={handleResend}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-primary)',
                fontWeight: '600',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {resending ? 'Sending...' : 'Resend Code'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
