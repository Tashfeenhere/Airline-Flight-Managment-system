import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plane, Mail, Lock, User, Phone, CheckCircle2, ArrowRight } from 'lucide-react';
import { authApi } from '../../api/auth';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Alert from '../../components/ui/Alert';

export default function SignUpPage() {
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match. Please verify your entries.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters in length.');
      return;
    }

    setLoading(true);
    try {
      const res = await authApi.register({
        fullName,
        email,
        password,
        phone: phone || undefined,
      });

      if (res.success) {
        setSuccess(true);
      }
    } catch (err) {
      setError(err.error?.message || err.message || 'Registration failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        maxWidth: '480px',
        margin: '2rem auto',
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
        <h1 style={{ fontSize: '1.8rem', fontWeight: '800' }}>Create Passenger Account</h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Sign up for direct flight reservations and instant ticket issuance.
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
        {success ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center', padding: '1rem 0' }}>
            <div style={{ color: 'var(--status-success)', display: 'flex', justifyContent: 'center' }}>
              <CheckCircle2 size={48} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.35rem', marginBottom: '0.5rem' }}>Registration Successful!</h2>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                A confirmation code has been dispatched to <strong style={{ color: 'var(--text-primary)' }}>{email}</strong> via Gmail. Please confirm your email address to activate all privileges.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
              <Button
                variant="primary"
                size="md"
                onClick={() => navigate(`/auth/verify-email?email=${encodeURIComponent(email)}`)}
                icon={ArrowRight}
                iconPosition="right"
                style={{ width: '100%' }}
              >
                Enter Verification Code
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => navigate('/auth/signin')}
                style={{ width: '100%' }}
              >
                Go to Sign In
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            {error && (
              <Alert variant="danger">
                {error}
              </Alert>
            )}

            <Input
              label="Full Legal Name"
              type="text"
              placeholder="e.g. Ada Lovelace"
              icon={User}
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />

            <Input
              label="Email Address"
              type="email"
              placeholder="name@example.com"
              icon={Mail}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <Input
              label="Phone Number (Optional)"
              type="tel"
              placeholder="+1-555-0192"
              icon={Phone}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />

            <Input
              label="Password (min 8 characters)"
              type="password"
              placeholder="••••••••"
              icon={Lock}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <Input
              label="Confirm Password"
              type="password"
              placeholder="••••••••"
              icon={Lock}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />

            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '0.25rem' }}>
              By creating an account, you agree to our travel terms and acknowledge that operator accounts (<code style={{ color: 'var(--accent-cyan)' }}>ADMIN</code>) are provisioned out-of-band.
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              style={{ width: '100%', marginTop: '0.5rem' }}
            >
              Register Account
            </Button>
          </form>
        )}
      </div>

      <div style={{ textAlign: 'center', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
        Already have an account?{' '}
        <Link to="/auth/signin" style={{ color: 'var(--accent-primary)', fontWeight: '600' }}>
          Sign In
        </Link>
      </div>
    </div>
  );
}
