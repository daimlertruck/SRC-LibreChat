import { useId, useMemo, useState } from 'react';
import { FEEDBACK_REASON_KEYS, agentStatisticsQuerySchema } from 'librechat-data-provider';
import {
  Button,
  Input,
  Skeleton,
  OGDialog,
  OGDialogContent,
  OGDialogDescription,
  OGDialogTitle,
} from '@librechat/client';
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

type ChartSeries = {
  label: string;
  className: string;
  values: number[];
  format?: (value: number) => string;
};

const failureSourceKeys = {
  llm: 'com_ui_agent_statistics_failure_llm',
  tool: 'com_ui_agent_statistics_failure_tool',
  agent: 'com_ui_agent_statistics_failure_agent',
} as const;

function TrendChart({
  title,
  dates,
  series,
}: {
  title: string;
  dates: string[];
  series: ChartSeries[];
}) {
  const localize = useLocalize();
  const chartId = useId().replace(/:/g, '');
  const [activeIndex, setActiveIndex] = useState<number>();
  const maximum = useMemo(() => Math.max(0, ...series.flatMap((item) => item.values)), [series]);
  const scaleMaximum = Math.max(Number.EPSILON, maximum);
  const yPosition = (value: number) => 150 - (value / scaleMaximum) * 130;
  const points = (values: number[]) =>
    values
      .map((value, index) => {
        const x = values.length === 1 ? 320 : 40 + (index / (values.length - 1)) * 590;
        return `${x},${yPosition(value)}`;
      })
      .join(' ');
  const activeDate = activeIndex == null ? undefined : dates[activeIndex];

  return (
    <section className="min-w-0 rounded-lg border border-border-light bg-surface-primary p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-text-primary">{title}</h3>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
          {series.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1.5">
              <span
                className={`size-2 rounded-full bg-current ${item.className}`}
                aria-hidden="true"
              />
              {item.label}
            </span>
          ))}
        </div>
      </div>
      <div
        className="relative h-52 w-full outline-none"
        role="img"
        tabIndex={0}
        aria-label={title}
        onFocus={() => dates.length > 0 && setActiveIndex(dates.length - 1)}
        onBlur={() => setActiveIndex(undefined)}
        onMouseLeave={() => setActiveIndex(undefined)}
        onMouseMove={(event) => {
          if (dates.length === 0) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
          setActiveIndex(Math.round(ratio * (dates.length - 1)));
        }}
      >
        <svg
          className="h-full w-full overflow-visible text-border-medium"
          viewBox="0 0 640 180"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <pattern id={chartId} width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M0 8 L8 0" stroke="currentColor" strokeWidth="0.6" opacity="0.12" />
            </pattern>
          </defs>
          {[20, 85, 150].map((y) => (
            <line key={y} x1="40" x2="630" y1={y} y2={y} stroke="currentColor" />
          ))}
          <rect x="40" y="20" width="590" height="130" fill={`url(#${chartId})`} />
          {series.map((item) =>
            item.values.length === 1 ? (
              <circle
                key={item.label}
                cx="320"
                cy={yPosition(item.values[0] ?? 0)}
                r="4"
                className={item.className}
                fill="currentColor"
              />
            ) : (
              <polyline
                key={item.label}
                points={points(item.values)}
                fill="none"
                className={item.className}
                stroke="currentColor"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
            ),
          )}
        </svg>
        <span className="pointer-events-none absolute left-0 top-0 text-[10px] text-text-tertiary">
          {series[0]?.format?.(maximum) ?? numberFormat.format(maximum)}
        </span>
        <span className="pointer-events-none absolute bottom-5 left-0 text-[10px] text-text-tertiary">
          {series[0]?.format?.(0) ?? 0}
        </span>
        {dates.length > 0 && (
          <div className="mt-1 flex justify-between text-[10px] text-text-tertiary">
            <span>{dates[0]}</span>
            <span>{dates[dates.length - 1]}</span>
          </div>
        )}
        {activeDate && activeIndex != null && (
          <div className="pointer-events-none absolute right-2 top-2 rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-xs text-text-primary shadow-lg">
            <div className="mb-1 font-medium">{activeDate}</div>
            {series.map((item) => (
              <div key={item.label}>
                {item.label}:{' '}
                {item.format?.(item.values[activeIndex] ?? 0) ??
                  numberFormat.format(item.values[activeIndex] ?? 0)}
              </div>
            ))}
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>{localize('com_ui_agent_statistics_date')}</th>
            {series.map((item) => (
              <th key={item.label}>{item.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((date, index) => (
            <tr key={date}>
              <th>{date}</th>
              {series.map((item) => (
                <td key={item.label}>
                  {item.format?.(item.values[index] ?? 0) ??
                    numberFormat.format(item.values[index] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
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
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
  const statistics = useAgentStatisticsQuery(agent_id, query, { enabled: !!agent_id });
  const customQuery = { from, to };
  const customValid = agentStatisticsQuerySchema.safeParse(customQuery).success;
  const summary = statistics.data?.summary;
  const chartData = useMemo(() => {
    const values = {
      dates: [] as string[],
      conversations: [] as number[],
      responses: [] as number[],
      failures: [] as number[],
      tokens: [] as number[],
      cost: [] as number[],
    };
    for (const day of statistics.data?.daily ?? []) {
      values.dates.push(day.date);
      values.conversations.push(day.conversations);
      values.responses.push(day.responses);
      values.failures.push(day.failedResponses);
      values.tokens.push(day.totalTokens);
      values.cost.push(day.costUSD ?? 0);
    }
    return values;
  }, [statistics.data?.daily]);
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
    <OGDialog open onOpenChange={(open) => !open && setActivePanel(Panel.builder)}>
      <OGDialogContent className="w-11/12 max-w-[1200px] overflow-hidden rounded-2xl border-border-medium p-0 shadow-xl md:max-h-[92vh]">
        <OGDialogTitle className="sr-only">{localize('com_ui_agent_statistics')}</OGDialogTitle>
        <OGDialogDescription className="sr-only">
          {localize('com_ui_agent_statistics_description')}
        </OGDialogDescription>
        <div className="flex h-[88vh] max-h-[840px] flex-col">
          <div className="border-b border-border-light px-6 pb-4 pt-5">
            <h2 className="text-xl font-semibold text-text-primary">
              {localize('com_ui_agent_statistics')}
            </h2>
          </div>
          <div className="scrollbar-gutter-stable flex-1 overflow-y-auto px-6 py-5 text-sm">
            <div className="flex flex-col gap-5">
              <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border-light bg-surface-primary p-2">
                <div className="flex gap-1" aria-label={localize('com_ui_agent_statistics_range')}>
                  {(['7d', '30d', '90d'] as const).map((range) => (
                    <Button
                      key={range}
                      type="button"
                      size="sm"
                      className="min-w-14"
                      variant={'range' in query && query.range === range ? 'default' : 'outline'}
                      onClick={() => setQuery({ range })}
                    >
                      {range}
                    </Button>
                  ))}
                </div>
                <div className="mx-1 h-6 w-px bg-border-light" aria-hidden="true" />
                <label className="flex min-w-44 flex-1 items-center gap-2 sm:max-w-60">
                  <span className="shrink-0 text-xs text-text-secondary">
                    {localize('com_ui_agent_statistics_single_day_utc')}
                  </span>
                  <Input
                    type="date"
                    className="h-8 min-w-0 bg-transparent px-2 text-sm"
                    aria-label={localize('com_ui_agent_statistics_single_day_utc')}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(event) =>
                      event.target.value && setQuery({ date: event.target.value })
                    }
                  />
                </label>
                <div className="flex min-w-80 flex-1 items-center gap-2">
                  <label className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="shrink-0 text-xs text-text-secondary">
                      {localize('com_ui_agent_statistics_from_utc')}
                    </span>
                    <Input
                      type="date"
                      value={from}
                      max={to || new Date().toISOString().slice(0, 10)}
                      className="h-8 min-w-0 bg-transparent px-2 text-sm"
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  </label>
                  <label className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="shrink-0 text-xs text-text-secondary">
                      {localize('com_ui_agent_statistics_to_utc')}
                    </span>
                    <Input
                      type="date"
                      value={to}
                      min={from || undefined}
                      max={new Date().toISOString().slice(0, 10)}
                      className="h-8 min-w-0 bg-transparent px-2 text-sm"
                      onChange={(event) => setTo(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!customValid}
                    onClick={() => customValid && setQuery(customQuery)}
                  >
                    {localize('com_ui_agent_statistics_apply_range')}
                  </Button>
                </div>
              </section>
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
                  <div className="grid gap-4 xl:grid-cols-2">
                    <TrendChart
                      title={localize('com_ui_agent_statistics_daily')}
                      dates={chartData.dates}
                      series={[
                        {
                          label: localize('com_ui_agent_statistics_conversations'),
                          className: 'text-status-info',
                          values: chartData.conversations,
                        },
                        {
                          label: localize('com_ui_agent_statistics_responses'),
                          className: 'text-status-success',
                          values: chartData.responses,
                        },
                        {
                          label: localize('com_ui_agent_statistics_failures'),
                          className: 'text-status-danger',
                          values: chartData.failures,
                        },
                      ]}
                    />
                    <TrendChart
                      title={localize('com_ui_agent_statistics_tokens')}
                      dates={chartData.dates}
                      series={[
                        {
                          label: localize('com_ui_agent_statistics_tokens'),
                          className: 'text-status-info',
                          values: chartData.tokens,
                        },
                      ]}
                    />
                    {statistics.data.summary.costAvailable ? (
                      <TrendChart
                        title={localize('com_ui_agent_statistics_cost')}
                        dates={chartData.dates}
                        series={[
                          {
                            label: localize('com_ui_agent_statistics_cost'),
                            className: 'text-status-success',
                            values: chartData.cost,
                            format: formatCost,
                          },
                        ]}
                      />
                    ) : (
                      <section className="flex min-h-52 flex-col rounded-lg border border-border-light bg-surface-primary p-4">
                        <h3 className="font-medium text-text-primary">
                          {localize('com_ui_agent_statistics_cost')}
                        </h3>
                        <div className="flex flex-1 items-center justify-center text-text-secondary">
                          {localize('com_ui_agent_statistics_cost_unavailable')}
                        </div>
                      </section>
                    )}
                  </div>
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
                          value={numberFormat.format(
                            statistics.data?.summary.feedbackTags[key] ?? 0,
                          )}
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
                      <ul className="grid gap-2 sm:grid-cols-2">
                        {statistics.data.recentFailures.map((failure) => (
                          <li
                            key={`${failure.occurredAt}-${failure.source}`}
                            className="rounded-lg border border-border-light bg-surface-secondary px-3 py-2"
                          >
                            <div className="font-medium text-text-primary">
                              {localize(failureSourceKeys[failure.source])}
                            </div>
                            <p className="break-words text-sm text-text-primary">
                              {failure.message}
                            </p>
                            <time
                              className="text-xs text-text-secondary"
                              dateTime={failure.occurredAt}
                            >
                              {dateTimeFormat.format(new Date(failure.occurredAt))}
                            </time>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
