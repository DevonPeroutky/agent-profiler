import { CornerUpLeft } from 'lucide-react';
import { fmt } from '../format';
import { totalTokens, type Dispatch } from './transforms';

interface Props {
  dispatch: Dispatch;
}

export function SpurFooter({ dispatch }: Props) {
  const total = totalTokens(dispatch.subagentTokens);
  return (
    <div className="flex items-center gap-1.5 border-t border-violet-500/20 pt-1.5 text-[10px] text-violet-500/80">
      <CornerUpLeft aria-hidden="true" className="h-3 w-3" />
      <span className="font-mono uppercase tracking-[0.06em]">return</span>
      {dispatch.requestCount > 0 && (
        <span className="font-mono text-muted-foreground/70">
          · {dispatch.requestCount} call{dispatch.requestCount === 1 ? '' : 's'}
        </span>
      )}
      {total > 0 && (
        <span className="ml-auto font-mono text-muted-foreground/70">
          {fmt.n(total)} tok
        </span>
      )}
    </div>
  );
}
