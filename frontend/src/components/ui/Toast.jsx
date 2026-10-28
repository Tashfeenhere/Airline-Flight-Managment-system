import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, AlertOctagon, Info, X, Sparkles } from 'lucide-react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback(({ title, message, type = 'info', duration = 4500 }) => {
    const id = 'toast-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now();
    const newToast = { id, title, message, type, duration, createdAt: Date.now() };

    setToasts((prev) => [...prev, newToast]);

    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = {
    success: (message, title = 'Operation Successful') => addToast({ title, message, type: 'success' }),
    error: (message, title = 'Attention Required') => addToast({ title, message, type: 'error', duration: 6000 }),
    warning: (message, title = 'Cluster Warning') => addToast({ title, message, type: 'warning' }),
    info: (message, title = 'System Notice') => addToast({ title, message, type: 'info' }),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Floating Modern Pill Toast Container */}
      <div
        className="toast-container"
        style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          zIndex: 99999,
          display: 'flex',
          flexDirection: 'column-reverse',
          gap: '12px',
          maxWidth: '420px',
          width: 'calc(100vw - 32px)',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => {
          const isSuccess = t.type === 'success';
          const isError = t.type === 'error';
          const isWarning = t.type === 'warning';

          const accentColor = isSuccess
            ? '#10b981'
            : isError
            ? '#f43f5e'
            : isWarning
            ? '#f59e0b'
            : '#06b6d4';

          const glowColor = isSuccess
            ? 'rgba(16, 185, 129, 0.35)'
            : isError
            ? 'rgba(244, 63, 94, 0.35)'
            : isWarning
            ? 'rgba(245, 158, 11, 0.35)'
            : 'rgba(6, 182, 212, 0.35)';

          const Icon = isSuccess
            ? CheckCircle2
            : isError
            ? AlertOctagon
            : isWarning
            ? AlertTriangle
            : Sparkles;

          return (
            <div
              key={t.id}
              className="toast-item"
              style={{
                pointerEvents: 'auto',
                position: 'relative',
                overflow: 'hidden',
                backgroundColor: 'rgba(10, 14, 26, 0.96)',
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                border: `1px solid rgba(255, 255, 255, 0.12)`,
                boxShadow: `0 20px 45px -10px rgba(0, 0, 0, 0.8), 0 0 20px ${glowColor}`,
                borderRadius: '16px',
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '14px',
                color: '#ffffff',
                animation: 'toastSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards',
                transition: 'all 0.2s ease',
              }}
            >
              {/* Status Glow Icon */}
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  backgroundColor: `${accentColor}18`,
                  border: `1px solid ${accentColor}40`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  boxShadow: `0 0 14px ${glowColor}`,
                }}
              >
                <Icon size={18} style={{ color: accentColor }} />
              </div>

              {/* Toast Text Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {t.title && (
                  <div
                    style={{
                      fontWeight: '700',
                      fontSize: '0.88rem',
                      color: '#ffffff',
                      marginBottom: '3px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <span>{t.title}</span>
                    <span
                      style={{
                        display: 'inline-block',
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        backgroundColor: accentColor,
                        boxShadow: `0 0 8px ${accentColor}`,
                      }}
                    />
                  </div>
                )}
                <div
                  style={{
                    fontSize: '0.82rem',
                    color: '#cbd5e1',
                    lineHeight: '1.45',
                    wordBreak: 'break-word',
                  }}
                >
                  {t.message}
                </div>
              </div>

              {/* Close Button */}
              <button
                onClick={() => removeToast(t.id)}
                className="btn-interactive"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '8px',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  padding: '5px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all 0.15s ease',
                }}
                title="Dismiss"
              >
                <X size={14} />
              </button>

              {/* Progress Duration Hairline */}
              {t.duration > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    height: '2.5px',
                    backgroundColor: accentColor,
                    boxShadow: `0 0 8px ${accentColor}`,
                    animation: `toastProgress ${t.duration}ms linear forwards`,
                    width: '100%',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
