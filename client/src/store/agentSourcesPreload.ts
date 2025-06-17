import { selector, selectorFamily, atom, GetRecoilValue } from 'recoil';
import { agentSourcesByMessageId } from './agents';
import type { TAttachment } from 'librechat-data-provider';

/**
 * Configuration for prefetching behavior
 */
export const prefetchConfigState = atom({
  key: 'prefetchConfig',
  default: {
    enabled: true,
    maxConcurrentPrefetch: 3,
    prefetchThreshold: 0.1, // Start prefetching when 10% likely to be needed
    cacheTimeout: 5 * 60 * 1000, // 5 minutes
    backgroundPrefetch: true,
  },
});

/**
 * Tracks which sources have been prefetched to avoid duplicate work
 */
export const prefetchStatusState = atom<
  Map<string, { status: 'pending' | 'complete' | 'error'; timestamp: number }>
>({
  key: 'prefetchStatus',
  default: new Map(),
});

/**
 * Prefetch queue management
 */
export const prefetchQueueState = atom<
  Array<{ messageId: string; fileId: string; priority: number }>
>({
  key: 'prefetchQueue',
  default: [],
});

/**
 * Advanced selector that determines which sources should be prefetched
 * based on user behavior patterns and content relationships
 */
export const prefetchCandidatesSelector = selectorFamily<
  Array<{ messageId: string; fileId: string; priority: number; reason: string }>,
  { conversationId: string; currentMessageId?: string }
>({
  key: 'prefetchCandidates',
  get:
    ({ conversationId, currentMessageId }) =>
    ({ get }) => {
      const config = get(prefetchConfigState);
      if (!config.enabled) return [];

      const candidates: Array<{
        messageId: string;
        fileId: string;
        priority: number;
        reason: string;
      }> = [];

      // Get all agent sources for the conversation (approximated by getting sources for current message)
      const currentSources = currentMessageId ? get(agentSourcesByMessageId(currentMessageId)) : [];

      if (!currentSources?.length) return [];

      // Strategy 1: Prefetch related files in the same message
      currentSources.forEach((source, index) => {
        if (source.file_id && currentMessageId) {
          // Higher priority for files that appear earlier in the list
          const priority = Math.max(1, 10 - index);
          candidates.push({
            messageId: currentMessageId,
            fileId: source.file_id,
            priority,
            reason: 'same_message_related',
          });
        }
      });

      // Strategy 2: Prefetch files of similar types
      const fileTypes = currentSources
        .filter((source) => source.type)
        .map((source) => source.type?.toLowerCase())
        .filter((type, index, arr) => arr.indexOf(type) === index); // Unique types

      currentSources.forEach((source) => {
        if (source.file_id && source.type && currentMessageId) {
          const isCommonType = ['pdf', 'text', 'docx'].includes(source.type.toLowerCase());
          if (isCommonType) {
            candidates.push({
              messageId: currentMessageId,
              fileId: source.file_id,
              priority: 7,
              reason: 'common_file_type',
            });
          }
        }
      });

      // Strategy 3: Prefetch files that are likely to be downloaded together
      const documentSources = currentSources.filter(
        (source) =>
          source.type?.toLowerCase().includes('pdf') ||
          source.type?.toLowerCase().includes('doc') ||
          source.type?.toLowerCase().includes('text'),
      );

      if (documentSources.length > 1) {
        documentSources.forEach((source) => {
          if (source.file_id && currentMessageId) {
            candidates.push({
              messageId: currentMessageId,
              fileId: source.file_id,
              priority: 6,
              reason: 'document_batch_likely',
            });
          }
        });
      }

      // Strategy 4: Prefetch small files (likely to be quick to process)
      currentSources.forEach((source) => {
        if (source.file_id && source.bytes && source.bytes < 1024 * 1024 && currentMessageId) {
          // Less than 1MB
          candidates.push({
            messageId: currentMessageId,
            fileId: source.file_id,
            priority: 5,
            reason: 'small_file_fast_prefetch',
          });
        }
      });

      // Remove duplicates and sort by priority
      const uniqueCandidates = candidates.reduce((acc, candidate) => {
        const key = `${candidate.messageId}:${candidate.fileId}`;
        if (!acc.has(key) || acc.get(key)!.priority < candidate.priority) {
          acc.set(key, candidate);
        }
        return acc;
      }, new Map<string, (typeof candidates)[0]>());

      return Array.from(uniqueCandidates.values())
        .sort((a, b) => b.priority - a.priority)
        .slice(0, config.maxConcurrentPrefetch);
    },
});

/**
 * Selector that manages the intelligent prefetching of agent source URLs
 */
export const agentSourcePrefetchSelector = selectorFamily<
  Map<string, { url: string; expiresAt: string; prefetchedAt: number }>,
  { conversationId: string; currentMessageId?: string }
>({
  key: 'agentSourcePrefetch',
  get:
    ({ conversationId, currentMessageId }) =>
    async ({ get }) => {
      const config = get(prefetchConfigState);
      const prefetchStatus = get(prefetchStatusState);

      if (!config.enabled || !config.backgroundPrefetch) {
        return new Map();
      }

      const candidates = get(prefetchCandidatesSelector({ conversationId, currentMessageId }));
      const prefetchedUrls = new Map<
        string,
        { url: string; expiresAt: string; prefetchedAt: number }
      >();

      // Process candidates based on priority
      for (const candidate of candidates.slice(0, config.maxConcurrentPrefetch)) {
        const prefetchKey = `${candidate.messageId}:${candidate.fileId}`;
        const status = prefetchStatus.get(prefetchKey);

        // Skip if already prefetched recently
        if (
          status &&
          status.status === 'complete' &&
          Date.now() - status.timestamp < config.cacheTimeout
        ) {
          continue;
        }

        try {
          // In a real implementation, this would call the actual API
          // For now, we'll simulate the prefetch operation
          console.log(
            `Prefetching source URL for ${candidate.fileId} (reason: ${candidate.reason})`,
          );

          // Simulate async prefetch operation
          await new Promise((resolve) => setTimeout(resolve, 100));

          const mockPrefetchedData = {
            url: `/api/files/download-secure/prefetched-${candidate.fileId}`,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            prefetchedAt: Date.now(),
          };

          prefetchedUrls.set(prefetchKey, mockPrefetchedData);

          // Update prefetch status
          const newStatus = new Map(prefetchStatus);
          newStatus.set(prefetchKey, { status: 'complete', timestamp: Date.now() });
        } catch (error) {
          console.warn(`Failed to prefetch ${candidate.fileId}:`, error);

          // Update error status
          const newStatus = new Map(prefetchStatus);
          newStatus.set(prefetchKey, { status: 'error', timestamp: Date.now() });
        }
      }

      return prefetchedUrls;
    },
});

/**
 * Selector for predictive caching based on user patterns
 */
export const predictiveCacheSelector = selectorFamily<
  { shouldPreload: boolean; confidence: number; reasons: string[] },
  { messageId: string; fileId: string; userBehavior?: UserBehaviorPattern }
>({
  key: 'predictiveCache',
  get:
    ({ messageId, fileId, userBehavior }) =>
    ({ get }) => {
      const config = get(prefetchConfigState);

      if (!config.enabled) {
        return { shouldPreload: false, confidence: 0, reasons: [] };
      }

      const sources = get(agentSourcesByMessageId(messageId));
      const targetSource = sources?.find((source) => source.file_id === fileId);

      if (!targetSource) {
        return { shouldPreload: false, confidence: 0, reasons: ['source_not_found'] };
      }

      const reasons: string[] = [];
      let confidence = 0;

      // Factor 1: File size (smaller files are more likely to be opened)
      if (targetSource.bytes && targetSource.bytes < 5 * 1024 * 1024) {
        // Less than 5MB
        confidence += 0.3;
        reasons.push('optimal_file_size');
      }

      // Factor 2: File type popularity
      const popularTypes = ['pdf', 'txt', 'docx', 'xlsx'];
      if (
        targetSource.type &&
        popularTypes.some((type) => targetSource.type!.toLowerCase().includes(type))
      ) {
        confidence += 0.2;
        reasons.push('popular_file_type');
      }

      // Factor 3: Position in source list (earlier = more likely to be accessed)
      const sourceIndex = sources?.indexOf(targetSource) ?? -1;
      if (sourceIndex >= 0 && sourceIndex < 3) {
        confidence += 0.2 - sourceIndex * 0.05;
        reasons.push('high_visibility_position');
      }

      // Factor 4: User behavior patterns
      if (userBehavior) {
        if (userBehavior.downloadsInSession > 2) {
          confidence += 0.15;
          reasons.push('active_download_session');
        }

        if (userBehavior.previewsBeforeDownload) {
          confidence += 0.1;
          reasons.push('preview_behavior_pattern');
        }

        if (userBehavior.batchDownloadTendency) {
          confidence += 0.15;
          reasons.push('batch_download_tendency');
        }
      }

      // Factor 5: Time of day patterns (simulated)
      const hour = new Date().getHours();
      const isBusinessHours = hour >= 9 && hour <= 17;
      if (isBusinessHours) {
        confidence += 0.1;
        reasons.push('business_hours_activity');
      }

      const shouldPreload = confidence >= config.prefetchThreshold;

      return {
        shouldPreload,
        confidence: Math.min(confidence, 1.0),
        reasons,
      };
    },
});

/**
 * Smart prefetch orchestrator that coordinates all prefetching strategies
 */
export const smartPrefetchOrchestratorSelector = selectorFamily<
  {
    status: 'idle' | 'active' | 'complete';
    prefetchedCount: number;
    queueLength: number;
    estimatedCompleteTime?: number;
  },
  { conversationId: string; currentMessageId?: string; userBehavior?: UserBehaviorPattern }
>({
  key: 'smartPrefetchOrchestrator',
  get:
    ({ conversationId, currentMessageId, userBehavior }) =>
    ({ get }) => {
      const config = get(prefetchConfigState);
      const candidates = get(prefetchCandidatesSelector({ conversationId, currentMessageId }));
      const prefetchStatus = get(prefetchStatusState);

      if (!config.enabled) {
        return { status: 'idle', prefetchedCount: 0, queueLength: 0 };
      }

      // Analyze each candidate with predictive caching
      const analyzedCandidates = candidates.map((candidate) => {
        const prediction = get(
          predictiveCacheSelector({
            messageId: candidate.messageId,
            fileId: candidate.fileId,
            userBehavior,
          }),
        );

        return {
          ...candidate,
          ...prediction,
        };
      });

      // Filter candidates that should be prefetched
      const shouldPrefetch = analyzedCandidates.filter((c) => c.shouldPreload);

      // Count already prefetched items
      const prefetchedCount = shouldPrefetch.reduce((count, candidate) => {
        const key = `${candidate.messageId}:${candidate.fileId}`;
        const status = prefetchStatus.get(key);
        return status?.status === 'complete' ? count + 1 : count;
      }, 0);

      const queueLength = shouldPrefetch.length - prefetchedCount;
      const estimatedCompleteTime = queueLength > 0 ? Date.now() + queueLength * 1000 : undefined;

      return {
        status: queueLength > 0 ? 'active' : prefetchedCount > 0 ? 'complete' : 'idle',
        prefetchedCount,
        queueLength,
        estimatedCompleteTime,
      };
    },
});

// Type definitions for user behavior tracking
interface UserBehaviorPattern {
  downloadsInSession: number;
  previewsBeforeDownload: boolean;
  batchDownloadTendency: boolean;
  averageSessionDuration: number;
  preferredFileTypes: string[];
  timeOfDayPatterns: { hour: number; activity: number }[];
}
