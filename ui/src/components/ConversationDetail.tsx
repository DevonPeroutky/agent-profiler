import { Separator } from '@/components/ui/separator';
import { ConversationView } from '@/components/conversation/ConversationView';
import { SpanDetail } from '@/components/SpanDetail';
import type { ConversationSummary, SpanNode } from '@/types';

interface Props {
  conversation: ConversationSummary | null;
  selectedSpan: SpanNode | null;
  onSelectSpan: (span: SpanNode) => void;
  onCloseSpan: () => void;
  loading: boolean;
}

export function ConversationDetail({
  conversation,
  selectedSpan,
  onSelectSpan,
  onCloseSpan,
  loading,
}: Props) {
  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {loading
          ? 'Loading…'
          : 'No traces yet. Run any tool-using prompt in Claude Code to populate.'}
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <ConversationView
          conversation={conversation}
          selectedSpanId={selectedSpan?.spanId ?? null}
          onSelectSpan={onSelectSpan}
        />
      </div>
      {selectedSpan && (
        <>
          <Separator orientation="vertical" />
          <aside className="w-96 shrink-0 overflow-y-auto bg-card/40">
            <SpanDetail span={selectedSpan} onClose={onCloseSpan} />
          </aside>
        </>
      )}
    </div>
  );
}
