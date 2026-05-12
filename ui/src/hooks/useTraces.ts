import { filterTraces } from '@/lib/trace-filters';
import type { TraceSummary, TracesResponse } from '@/types';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseTracesResult {
  traces: TraceSummary[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
  refetch: () => void;
}

export function useTraces(pollMs = 5000): UseTracesResult {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  // Keep the previous server-supplied version. When it matches, skip setTraces
  // so the reference stays stable and downstream useMemo / useEffect chains
  // don't re-run on no-op polls.
  const lastVersionRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/traces');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TracesResponse = await res.json();
      if (data.version !== lastVersionRef.current) {
        lastVersionRef.current = data.version;
        setTraces(filterTraces(data.traces));
      }
      setLastFetched(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, pollMs);
    return () => clearInterval(interval);
  }, [load, pollMs]);

  return { traces, loading, error, lastFetched, refetch: load };
}
