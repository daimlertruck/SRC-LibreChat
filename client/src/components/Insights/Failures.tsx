import type {
  TInsightsDailyPoint,
  TInsightsFailureCategory,
  TInsightsRecentFailures,
  TInsightsSummary,
} from 'librechat-data-provider';
import type { TranslationKeys, useLocalize } from '~/hooks';
import type { VersionMark } from './versions';
import { formatExactValue } from './format';
import { TablePanel } from './Panel';
import { Sparkline } from './Card';

const categoryKeys: Record<TInsightsFailureCategory, TranslationKeys> = {
  provider: 'com_insights_failure_provider',
  limit: 'com_insights_failure_limit',
  credentials: 'com_insights_failure_credentials',
  moderation: 'com_insights_failure_moderation',
  configuration: 'com_insights_failure_configuration',
  other: 'com_insights_failure_other',
};

export default function RecentFailures({
  failures,
  summary,
  daily,
  versionMarks,
  agentNames,
  showAgent,
  localize,
  locale,
  timeZone,
}: {
  failures: TInsightsRecentFailures;
  summary: TInsightsSummary;
  daily: TInsightsDailyPoint[];
  versionMarks?: VersionMark[];
  agentNames: Map<string, string>;
  showAgent: boolean;
  localize: ReturnType<typeof useLocalize>;
  locale: string;
  timeZone: string;
}) {
  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const [latest] = failures.occurrences;
  const count = (value: number) => formatExactValue(value, locale);
  const failureRate = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(summary.totalResponses > 0 ? summary.failedResponses / summary.totalResponses : 0);
  const stats: Array<{ label: TranslationKeys; value: React.ReactNode; detail: string | null }> =
    latest == null
      ? []
      : [
          {
            label: 'com_insights_last_failure',
            value: <time dateTime={latest.at}>{time.format(new Date(latest.at))}</time>,
            detail: null,
          },
          {
            label: 'com_insights_failed',
            value: count(summary.failedResponses),
            detail: localize('com_insights_failure_rate', {
              rate: failureRate,
              total: count(summary.totalResponses),
            }),
          },
          {
            label: 'com_insights_interrupted',
            value: count(summary.interruptedResponses),
            detail: null,
          },
          {
            label: 'com_insights_users_affected',
            value: count(failures.affectedUsers),
            detail:
              failures.repeatedUsers > 0
                ? localize('com_insights_repeated_users', {
                    repeated: count(failures.repeatedUsers),
                  })
                : null,
          },
        ];
  const trendLabel = localize(
    failures.hourly ? 'com_insights_failures_by_hour' : 'com_insights_failures_by_day',
  );
  const trendAccessibleLabel = localize('com_insights_sparkline_accessibility', {
    label: trendLabel,
  });

  return (
    <TablePanel title={localize('com_insights_recent_failures')}>
      <p className="text-text-secondary -mt-1 mb-3 text-sm">
        {localize('com_insights_recent_failures_definition')}
      </p>
      {latest == null ? (
        <p className="text-text-primary mb-3 text-sm">{localize('com_insights_no_failures')}</p>
      ) : (
        <dl className="mb-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {stats.map(({ label, value, detail }) => (
            <div key={label} className="flex items-start justify-between gap-4 text-sm">
              <dt>{localize(label)}</dt>
              <dd className="text-right font-semibold tabular-nums">
                {value}
                {detail && <span className="text-text-secondary ms-1 font-normal">({detail})</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <h3 className="text-text-muted text-sm font-normal">{trendLabel}</h3>
      {failures.hourly ? (
        <Sparkline
          values={failures.hourly.map(({ hour, failed, interrupted }) => ({
            date: `${hour}:00:00Z`,
            value: failed + interrupted,
          }))}
          label={trendAccessibleLabel}
          locale={locale}
          hour="numeric"
        />
      ) : (
        <Sparkline
          values={daily.map(({ date, failedResponses, interruptedResponses }) => ({
            date,
            value: failedResponses + interruptedResponses,
          }))}
          label={trendAccessibleLabel}
          locale={locale}
          versionMarks={versionMarks}
        />
      )}
      {failures.occurrences.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-border-medium text-text-secondary border-b text-xs">
              <tr>
                <th className="px-2 py-2 font-medium">{localize('com_insights_time')}</th>
                {showAgent && (
                  <th className="px-2 py-2 font-medium">{localize('com_insights_agent')}</th>
                )}
                <th className="px-2 py-2 font-medium">{localize('com_insights_status')}</th>
                <th className="px-2 py-2 font-medium">{localize('com_insights_failure_type')}</th>
              </tr>
            </thead>
            <tbody className="divide-border-light divide-y">
              {failures.occurrences.map((failure, index) => (
                <tr key={`${failure.at}-${index}`} className="hover:bg-surface-hover">
                  <td className="px-2 py-3 whitespace-nowrap">
                    <time dateTime={failure.at}>{time.format(new Date(failure.at))}</time>
                  </td>
                  {showAgent && (
                    <td className="max-w-[16rem] truncate px-2 py-3">
                      {agentNames.get(failure.agentId) ?? failure.agentId}
                    </td>
                  )}
                  <td className="px-2 py-3">
                    {localize(
                      failure.status === 'failed'
                        ? 'com_insights_failed'
                        : 'com_insights_interrupted',
                    )}
                  </td>
                  <td className="text-text-secondary px-2 py-3">
                    {failure.category == null ? '—' : localize(categoryKeys[failure.category])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TablePanel>
  );
}
