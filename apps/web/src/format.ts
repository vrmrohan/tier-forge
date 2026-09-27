const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const fmt = (n: number): string => whole.format(n);
export const fmtMoney = (n: number): string => money.format(n);
export const pct = (part: number, total: number): string =>
  total === 0 ? '0%' : `${Math.round((part / total) * 100)}%`;

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'not yet';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function duration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso) return '–';
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
