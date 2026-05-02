export const fmt = {
  n(x: number): string {
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return '0';
    if (x < 1000) return String(x);
    if (x < 1e6) return `${(x / 1000).toFixed(x < 10000 ? 2 : 1).replace(/\.0+$/, '')}k`;
    return `${(x / 1e6).toFixed(2)}M`;
  },
  pct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
  },
  ms(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  },
  bytes(b: number): string {
    if (!Number.isFinite(b) || b <= 0) return '0B';
    if (b < 1024) return `${b}B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)}KB`;
    return `${(b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)}MB`;
  },
};
