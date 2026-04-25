import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'agent-trace-sidebar-collapsed';

function getInitial(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === '1';
}

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<boolean>(getInitial);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((p) => !p), []);
  return { collapsed, toggle };
}
