import { BarChart3 } from 'lucide-react';
import { Button } from '@librechat/client';
import type { AgentPanelProps } from '~/common';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';

export default function StatisticsButton({
  setActivePanel,
}: Pick<AgentPanelProps, 'setActivePanel'>) {
  const localize = useLocalize();
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => setActivePanel(Panel.statistics)}
      aria-label={localize('com_ui_agent_statistics')}
      className="h-9 w-full px-3"
    >
      <BarChart3 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      {localize('com_ui_agent_statistics')}
    </Button>
  );
}
