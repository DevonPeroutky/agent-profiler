import type { SpanNode } from '@/types';
import { createContext, useContext } from 'react';

interface InferenceGraphContextValue {
  onSelectSpan?: (span: SpanNode) => void;
  collapsedSegmentIds: ReadonlySet<string>;
  toggleSegmentCollapsed: (segmentId: string) => void;
}

export const InferenceGraphContext = createContext<InferenceGraphContextValue>({
  collapsedSegmentIds: new Set<string>(),
  toggleSegmentCollapsed: () => {},
});

export function useInferenceGraphContext(): InferenceGraphContextValue {
  return useContext(InferenceGraphContext);
}
