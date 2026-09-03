import { Switch } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import type { AgentForm } from '~/common';
import { useAgentPanelContext } from '~/Providers';
import { useLocalize } from '~/hooks';

export default function StatisticsToggle() {
  const localize = useLocalize();
  const { agentsConfig } = useAgentPanelContext();
  const { control, setValue } = useFormContext<AgentForm>();
  const checked = useWatch({ control, name: 'statistics_enabled' }) === true;

  if (agentsConfig?.statistics !== true) return null;

  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border-light bg-surface-secondary p-3">
      <div className="min-w-0">
        <label htmlFor="agent-statistics-enabled" className="text-sm font-medium text-text-primary">
          {localize('com_ui_agent_statistics')}
        </label>
        <p className="text-xs text-text-secondary">
          {localize('com_ui_agent_statistics_enable_info')}
        </p>
      </div>
      <Switch
        id="agent-statistics-enabled"
        checked={checked}
        onCheckedChange={(value) =>
          setValue('statistics_enabled', value, { shouldDirty: true, shouldTouch: true })
        }
        aria-label={localize('com_ui_agent_statistics')}
      />
    </div>
  );
}
