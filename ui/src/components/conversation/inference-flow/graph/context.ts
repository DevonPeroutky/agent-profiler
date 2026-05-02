import type { SpanNode } from '@/types';
import { createContext, useContext } from 'react';

interface InferenceGraphContextValue {
  onSelectSpan?: (span: SpanNode) => void;
}

export const InferenceGraphContext = createContext<InferenceGraphContextValue>({});

export function useInferenceGraphContext(): InferenceGraphContextValue {
  return useContext(InferenceGraphContext);
}
