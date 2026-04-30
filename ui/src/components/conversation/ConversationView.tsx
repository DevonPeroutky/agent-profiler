import type { ConversationSummary, SpanNode } from '@/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ContextWindowChart } from './ContextWindowChart';
import { ConversationContextChart } from './ConversationContextChart';
import { ConversationDebug } from './ConversationDebug';
import { ConversationOverview } from './ConversationOverview';
import { ConversationSteps } from './ConversationSteps';
import { ConversationTrajectory } from './ConversationTrajectory';
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
      <div className="grid grid-cols-1 gap-6 px-6 lg:grid-cols-2">
        <Tabs defaultValue="steps" className="min-w-0">
          <TabsList>
            <TabsTrigger value="steps">Steps</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
            <TabsTrigger value="trajectory">Trajectory</TabsTrigger>
            <TabsTrigger value="debug">Debug</TabsTrigger>
          </TabsList>
          <TabsContent value="steps">
            <ConversationSteps conversation={conversation} />
          </TabsContent>
          <TabsContent value="messages">
            <TurnMessages
              conversation={conversation}
              selectedSpanId={selectedSpanId}
              onSelectSpan={onSelectSpan}
              showMeta={showMeta}
            />
          </TabsContent>
          <TabsContent value="trajectory">
            <ConversationTrajectory conversation={conversation} />
          </TabsContent>
          <TabsContent value="debug">
            <ConversationDebug sessionId={conversation.sessionId} />
          </TabsContent>
        </Tabs>
        <div className="min-w-0">
          <ConversationDebug sessionId={conversation.sessionId} />
        </div>
      </div>
    </div>
  );
}
