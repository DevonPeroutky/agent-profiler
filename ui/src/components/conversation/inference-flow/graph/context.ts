import { createContext, useContext } from 'react';
import type { SpanNode } from '@/types';

interface InferenceGraphContextValue {
  onSelectSpan?: (span: SpanNode) => void;
}

export const InferenceGraphContext =
  createContext<InferenceGraphContextValue>({});

export function useInferenceGraphContext(): InferenceGraphContextValue {
  return useContext(InferenceGraphContext);
}
