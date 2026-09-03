import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button, Input, Skeleton } from '@librechat/client';
import { FEEDBACK_REASON_KEYS, agentStatisticsQuerySchema } from 'librechat-data-provider';
import type {
  AgentStatisticsQuery,
  AgentStatisticsResponse,
  TFeedbackTagKey,
} from 'librechat-data-provider';
import { useAgentStatisticsQuery } from '~/data-provider';
import { useAgentPanelContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { formatCost } from '~/utils';
import { Panel } from '~/common';

const numberFormat = new Intl.NumberFormat();
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

function errorStatus(error: Error | null): number | undefined {
  return (error as (Error & { response?: { status?: number } }) | null)?.response?.status;
}

function errorKey(error: Error | null) {
  const status = errorStatus(error);
  if (status === 403 || status === 404) return 'com_ui_agent_statistics_unavailable' as const;
  if (status === 429) return 'com_ui_agent_statistics_rate_limited' as const;
  return 'com_ui_agent_statistics_error' as const;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-light bg-surface-secondary p-3">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-text-primary">{value}</dd>
    </div>
  );
}

function Summary({ data }: { data: AgentStatisticsResponse }) {
  const localize = useLocalize();
  const { summary } = data;
  const uniqueLabel =
    data.range.days === 1
      ? localize('com_ui_agent_statistics_unique_users')
      : localize('com_ui_agent_statistics_average_daily_unique_users');
  return (
    <>
      <dl className="grid grid-cols-2 gap-2">
        <Metric
          label={localize('com_ui_agent_statistics_conversations')}
          value={numberFormat.format(summary.conversations)}
        />
        <Metric
          label={localize('com_ui_agent_statistics_responses')}
          value={numberFormat.format(summary.responses)}
        />
        <Metric
          label={localize('com_ui_agent_statistics_success_rate')}
          value={summary.successRate == null ? '—' : `${(summary.successRate * 100).toFixed(1)}%`}
        />
        <Metric
          label={localize('com_ui_agent_statistics_ratings')}
          value={`${numberFormat.format(summary.thumbsUp)} / ${numberFormat.format(summary.thumbsDown)}`}
        />
        <Metric
          label={localize('com_ui_agent_statistics_tokens')}
          value={numberFormat.format(summary.totalTokens)}
        />
        <Metric
          label={localize('com_ui_agent_statistics_cost')}
          value={
            summary.costAvailable && summary.costUSD != null
              ? formatCost(summary.costUSD)
              : localize('com_ui_agent_statistics_cost_unavailable')
          }
        />
        <Metric label={uniqueLabel} value={numberFormat.format(summary.averageDailyUniqueUsers)} />
        <Metric
          label={localize('com_ui_agent_statistics_last_used')}
          value={summary.lastUsedAt ? dateTimeFormat.format(new Date(summary.lastUsedAt)) : '—'}
        />
      </dl>
      <p className="text-xs text-text-secondary">
        {localize('com_ui_agent_statistics_unique_users_info')}
      </p>
    </>
  );
}

export default function StatisticsPanel() {
  const localize = useLocalize();
  const { agent_id, setActivePanel } = useAgentPanelContext();
  const [query, setQuery] = useState<AgentStatisticsQuery>({ range: '30d' });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const customQuery = { from, to };
  const customValid = agentStatisticsQuerySchema.safeParse(customQuery).success;
  const statistics = useAgentStatisticsQuery(agent_id, query, { enabled: !!agent_id });
  const summary = statistics.data?.summary;
  const isLoading = statistics.isLoading || statistics.isPreviousData;
  const showData = statistics.data != null && !statistics.isPreviousData && !statistics.isError;
  const empty =
    summary != null &&
    summary.conversations === 0 &&
    summary.responses === 0 &&
    summary.thumbsUp === 0 &&
    summary.thumbsDown === 0 &&
    summary.totalTokens === 0 &&
    summary.costUSD === 0 &&
    summary.averageDailyUniqueUsers === 0;

  return (
    <div className="scrollbar-gutter-stable h-full min-h-[40vh] overflow-auto px-2 pb-12 text-sm">
      <header className="grid grid-cols-[auto_1fr_auto] items-center gap-2 pb-3 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setActivePanel(Panel.builder)}
          aria-label={localize('com_ui_back_to_builder')}
          className="flex-shrink-0 text-text-secondary hover:text-text-primary"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <h2 className="text-center text-base font-semibold text-text-primary">
          {localize('com_ui_agent_statistics')}
        </h2>
        <span aria-hidden="true" className="h-9 w-9" />
      </header>

      <div className="flex flex-col gap-3">
        <div
          className="grid grid-cols-3 gap-2"
          aria-label={localize('com_ui_agent_statistics_range')}
        >
          {(['7d', '30d', '90d'] as const).map((range) => (
            <Button
              key={range}
              type="button"
              variant={'range' in query && query.range === range ? 'default' : 'outline'}
              onClick={() => setQuery({ range })}
            >
              {range}
            </Button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          {localize('com_ui_agent_statistics_single_day_utc')}
          <Input
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            onChange={(event) => event.target.value && setQuery({ date: event.target.value })}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {localize('com_ui_agent_statistics_from_utc')}
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {localize('com_ui_agent_statistics_to_utc')}
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!customValid}
          onClick={() => customValid && setQuery(customQuery)}
        >
          {localize('com_ui_agent_statistics_apply_range')}
        </Button>
        {from && to && !customValid && (
          <p role="alert" className="text-xs text-text-secondary">
            {localize('com_ui_agent_statistics_invalid_range')}
          </p>
        )}
        {isLoading && (
          <div
            className="grid grid-cols-2 gap-2"
            role="status"
            aria-label={localize('com_ui_agent_statistics_loading')}
          >
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-20 rounded-lg" />
            ))}
          </div>
        )}
        {statistics.isError && (
          <div
            role="alert"
            className="rounded-lg border border-border-light p-3 text-text-secondary"
          >
            {localize(errorKey(statistics.error))}
          </div>
        )}
        {showData && empty && (
          <div className="rounded-lg border border-border-light p-4 text-center text-text-secondary">
            {localize('com_ui_agent_statistics_empty')}
          </div>
        )}
        {showData && !empty && (
          <>
            <Summary data={statistics.data} />
            <section aria-labelledby="agent-statistics-daily-heading">
              <h3
                id="agent-statistics-daily-heading"
                className="mb-2 font-medium text-text-primary"
              >
                {localize('com_ui_agent_statistics_daily')}
              </h3>
              <div className="overflow-x-auto rounded-lg border border-border-light">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-secondary text-text-secondary">
                    <tr>
                      <th className="p-2">{localize('com_ui_agent_statistics_date')}</th>
                      <th className="p-2">{localize('com_ui_agent_statistics_conversations')}</th>
                      <th className="p-2">{localize('com_ui_agent_statistics_responses')}</th>
                      <th className="p-2">{localize('com_ui_agent_statistics_failures')}</th>
                      <th className="p-2">{localize('com_ui_agent_statistics_tokens')}</th>
                      <th className="p-2">{localize('com_ui_agent_statistics_cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statistics.data.daily.map((day) => (
                      <tr key={day.date} className="border-t border-border-light text-text-primary">
                        <td className="whitespace-nowrap p-2">{day.date}</td>
                        <td className="p-2">{numberFormat.format(day.conversations)}</td>
                        <td className="p-2">{numberFormat.format(day.responses)}</td>
                        <td className="p-2">{numberFormat.format(day.failedResponses)}</td>
                        <td className="p-2">{numberFormat.format(day.totalTokens)}</td>
                        <td className="whitespace-nowrap p-2">
                          {day.costAvailable && day.costUSD != null
                            ? formatCost(day.costUSD)
                            : localize('com_ui_agent_statistics_cost_unavailable')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section aria-labelledby="agent-statistics-feedback-heading">
              <h3
                id="agent-statistics-feedback-heading"
                className="mb-2 font-medium text-text-primary"
              >
                {localize('com_ui_agent_statistics_feedback')}
              </h3>
              <dl className="grid grid-cols-2 gap-2">
                {FEEDBACK_REASON_KEYS.filter(
                  (key) => (statistics.data?.summary.feedbackTags[key] ?? 0) > 0,
                ).map((key: TFeedbackTagKey) => (
                  <Metric
                    key={key}
                    label={localize(`com_ui_feedback_tag_${key}`)}
                    value={numberFormat.format(statistics.data?.summary.feedbackTags[key] ?? 0)}
                  />
                ))}
              </dl>
            </section>
            {statistics.data.recentFailures.length > 0 && (
              <section aria-labelledby="agent-statistics-failures-heading">
                <h3
                  id="agent-statistics-failures-heading"
                  className="mb-2 font-medium text-text-primary"
                >
                  {localize('com_ui_agent_statistics_recent_failures')}
                </h3>
                <ul className="space-y-1 text-xs text-text-secondary">
                  {statistics.data.recentFailures.map((failure) => (
                    <li key={failure}>{dateTimeFormat.format(new Date(failure))}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
