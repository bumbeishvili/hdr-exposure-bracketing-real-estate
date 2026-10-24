// Number formatting for the inspector. Negative numbers use a true minus sign.

const MINUS = '−';

export function signed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return text;
  return (value < 0 ? MINUS : '+') + text;
}

export function ev(value: number, digits = 2): string {
  return `${signed(value, digits)} EV`;
}

/** Camera-style shutter speed: 1/100 s, 0.6 s, 2.5 s. */
export function shutter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds >= 0.3) return `${Number(seconds.toFixed(1))} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

export function percent(fraction: number, digits = 2): string {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : '—';
}

export function signedPercent(fraction: number, digits = 2): string {
  return Number.isFinite(fraction) ? `${signed(fraction * 100, digits)}%` : '—';
}

export function integer(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}
