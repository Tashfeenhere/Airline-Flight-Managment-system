export function formatCurrency(amount, currency = 'USD') {
  if (amount === null || amount === undefined) return '—';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatDate(dateInput) {
  if (!dateInput) return '—';
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(d);
  } catch {
    return String(dateInput);
  }
}

export function formatTime(dateTimeInput) {
  if (!dateTimeInput) return '—';
  try {
    const d = new Date(dateTimeInput);
    if (isNaN(d.getTime())) return String(dateTimeInput);
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return String(dateTimeInput);
  }
}

export function formatDateTime(dateTimeInput) {
  if (!dateTimeInput) return '—';
  try {
    const d = new Date(dateTimeInput);
    if (isNaN(d.getTime())) return String(dateTimeInput);
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return String(dateTimeInput);
  }
}

export function calculateDuration(start, end) {
  if (!start || !end) return '—';
  try {
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    const diffMs = e - s;
    if (diffMs <= 0) return '—';
    const totalMinutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes > 0 ? `${minutes}m` : ''}`;
  } catch {
    return '—';
  }
}

export function formatLag(ms) {
  if (ms === null || ms === undefined || ms < 0) return 'Live';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s lag`;
}
