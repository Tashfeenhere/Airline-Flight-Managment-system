import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Mail, ArrowLeft, CheckCircle2 } from 'lucide-react';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <div
      style={{
        maxWidth: '440px',
        margin: '4rem auto',
        width: '100%',
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-lg)',
        padding: '2.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            backgroundColor: 'var(--accent-light)',
            color: 'var(--accent-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <KeyRound size={24} />
        </div>
        <h1 style={{ fontSize: '1.6rem', fontWeight: '800' }}>Reset Password</h1>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Enter your registered email address and we will generate a password recovery link.
        </p>
      </div>

      {submitted ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}>
          <div style={{ color: 'var(--status-success)', display: 'flex', justifyContent: 'center' }}>
            <CheckCircle2 size={40} />
          </div>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            If an account matches <strong style={{ color: 'var(--text-primary)' }}>{email}</strong>, a secure reset token has been dispatched.
          </p>
          <Link to="/auth/signin" style={{ textDecoration: 'none' }}>
            <Button variant="secondary" icon={ArrowLeft} style={{ width: '100%' }}>
              Return to Sign In
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <Input
            label="Email Address"
            type="email"
            placeholder="ada.lovelace@example.com"
            icon={Mail}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <Button type="submit" variant="primary" size="lg" style={{ width: '100%' }}>
            Send Reset Link
          </Button>

          <div style={{ textAlign: 'center' }}>
            <Link
              to="/auth/signin"
              style={{
                fontSize: '0.88rem',
                color: 'var(--text-secondary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
              }}
            >
              <ArrowLeft size={14} /> Back to Sign In
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
