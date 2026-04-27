import type { ConversationSummary, SpanNode } from '@/types';
import { ContextWindowChart } from './ContextWindowChart';
import { ConversationContextChart } from './ConversationContextChart';
import { ConversationOverview } from './ConversationOverview';
import { ConversationSteps } from './ConversationSteps';
import { TurnMessages } from './TurnMessages';

interface Props {
  conversation: ConversationSummary;
  selectedSpanId: string | null;
  onSelectSpan: (span: SpanNode) => void;
  showMeta: boolean;
}

export function ConversationView({
  conversation,
  selectedSpanId,
  onSelectSpan,
  showMeta,
}: Props) {
  return (
    <div className="grid grid-cols-1 gap-8 pb-8">
      <div className="px-6 pt-4">
        <ConversationOverview conversation={conversation} />
      </div>
      <div className="grid grid-cols-1 gap-4 px-6 lg:grid-cols-2">
        <ContextWindowChart conversation={conversation} />
        <ConversationContextChart conversation={conversation} />
      </div>
      <div className="px-6">
        <ConversationSteps conversation={conversation} />
      </div>
      <TurnMessages
        conversation={conversation}
        selectedSpanId={selectedSpanId}
        onSelectSpan={onSelectSpan}
        showMeta={showMeta}
      />
    </div>
  );
}
