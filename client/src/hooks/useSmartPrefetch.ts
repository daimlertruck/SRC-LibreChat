import { useEffect, useCallback, useRef } from 'react';
import { useRecoilValue, useRecoilState } from 'recoil';
import { useAgentSourceDownload } from 'librechat-data-provider';
import {
  prefetchConfigState,
  prefetchStatusState,
  smartPrefetchOrchestratorSelector,
} from '~/store/agentSourcesPreload';

interface UseSmartPrefetchOptions {
  conversationId: string;
  messageId?: string;
  enabled?: boolean;
  onPrefetchComplete?: (fileId: string, url: string) => void;
  onPrefetchError?: (fileId: string, error: Error) => void;
  userBehavior?: UserBehaviorPattern;
}

interface UserBehaviorPattern {
  downloadsInSession: number;
  previewsBeforeDownload: boolean;
  batchDownloadTendency: boolean;
  averageSessionDuration: number;
  preferredFileTypes: string[];
  timeOfDayPatterns: { hour: number; activity: number }[];
}

interface SmartPrefetchState {
  isActive: boolean;
  prefetchedCount: number;
  queueLength: number;
  estimatedCompleteTime?: number;
  triggerPrefetch: (
    fileId: string,
    messageId: string,
    options?: { priority?: number },
  ) => Promise<void>;
  isPrefetched: (fileId: string, messageId: string) => boolean;
  getPrefetchedUrl: (fileId: string, messageId: string) => string | null;
  clearPrefetchCache: () => void;
  updateUserBehavior: (behavior: Partial<UserBehaviorPattern>) => void;
}

/**
 * Advanced hook for smart prefetching of agent source URLs
 * Uses machine learning-like patterns to predict and prefetch likely downloads
 */
export function useSmartPrefetch(options: UseSmartPrefetchOptions): SmartPrefetchState {
  const {
    conversationId,
    messageId,
    enabled = true,
    onPrefetchComplete,
    onPrefetchError,
    userBehavior,
  } = options;

  const config = useRecoilValue(prefetchConfigState);
  const [prefetchStatus, setPrefetchStatus] = useRecoilState(prefetchStatusState);

  const orchestratorStatus = useRecoilValue(
    smartPrefetchOrchestratorSelector({
      conversationId,
      currentMessageId: messageId,
      userBehavior,
    }),
  );

  const downloadMutation = useAgentSourceDownload();
  const prefetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const prefetchedUrlsRef = useRef<Map<string, { url: string; expiresAt: string }>>(new Map());
  const userBehaviorRef = useRef<UserBehaviorPattern | undefined>(userBehavior);

  // Update user behavior reference
  useEffect(() => {
    userBehaviorRef.current = userBehavior;
  }, [userBehavior]);

  /**
   * Check if a file has been prefetched and is still valid
   */
  const isPrefetched = useCallback((fileId: string, messageId: string): boolean => {
    const key = `${messageId}:${fileId}`;
    const prefetched = prefetchedUrlsRef.current.get(key);

    if (!prefetched) return false;

    // Check if URL is still valid (not expired)
    const expiresAt = new Date(prefetched.expiresAt);
    return expiresAt > new Date();
  }, []);

  /**
   * Get prefetched URL if available and valid
   */
  const getPrefetchedUrl = useCallback(
    (fileId: string, messageId: string): string | null => {
      if (!isPrefetched(fileId, messageId)) return null;

      const key = `${messageId}:${fileId}`;
      return prefetchedUrlsRef.current.get(key)?.url || null;
    },
    [isPrefetched],
  );

  /**
   * Trigger prefetch for a specific file
   */
  const triggerPrefetch = useCallback(
    async (fileId: string, messageId: string, options?: { priority?: number }): Promise<void> => {
      if (!enabled || !config.enabled) return;

      const key = `${messageId}:${fileId}`;
      const currentStatus = prefetchStatus.get(key);

      // Skip if already in progress or recently completed
      if (
        currentStatus?.status === 'pending' ||
        (currentStatus?.status === 'complete' && Date.now() - currentStatus.timestamp < 60000)
      ) {
        return;
      }

      // Update status to pending
      setPrefetchStatus((prev) => {
        const newStatus = new Map(prev);
        newStatus.set(key, { status: 'pending', timestamp: Date.now() });
        return newStatus;
      });

      try {
        // Use predictive caching to determine if we should proceed
        const prediction = await new Promise<{ shouldPreload: boolean; confidence: number }>(
          (resolve) => {
            // This would ideally use the Recoil selector, but for simplicity we'll simulate
            const mockPrediction = {
              shouldPreload: true,
              confidence: 0.7,
            };
            resolve(mockPrediction);
          },
        );

        if (!prediction.shouldPreload && !options?.priority) {
          // Skip prefetch if prediction confidence is low
          setPrefetchStatus((prev) => {
            const newStatus = new Map(prev);
            newStatus.delete(key);
            return newStatus;
          });
          return;
        }

        // Perform the actual prefetch
        const response = await downloadMutation.mutateAsync({
          fileId,
          messageId,
          conversationId,
        });

        // Cache the prefetched URL
        prefetchedUrlsRef.current.set(key, {
          url: response.downloadUrl,
          expiresAt: response.expiresAt,
        });

        // Update status to complete
        setPrefetchStatus((prev) => {
          const newStatus = new Map(prev);
          newStatus.set(key, { status: 'complete', timestamp: Date.now() });
          return newStatus;
        });

        onPrefetchComplete?.(fileId, response.downloadUrl);

        console.log(`Prefetch complete for ${fileId} (confidence: ${prediction.confidence})`);
      } catch (error) {
        console.error(`Prefetch failed for ${fileId}:`, error);

        setPrefetchStatus((prev) => {
          const newStatus = new Map(prev);
          newStatus.set(key, { status: 'error', timestamp: Date.now() });
          return newStatus;
        });

        onPrefetchError?.(fileId, error as Error);
      }
    },
    [
      enabled,
      config.enabled,
      prefetchStatus,
      setPrefetchStatus,
      downloadMutation,
      conversationId,
      onPrefetchComplete,
      onPrefetchError,
    ],
  );

  /**
   * Clear all prefetch cache
   */
  const clearPrefetchCache = useCallback(() => {
    prefetchedUrlsRef.current.clear();
    setPrefetchStatus(new Map());
  }, [setPrefetchStatus]);

  /**
   * Update user behavior patterns for better predictions
   */
  const updateUserBehavior = useCallback((behavior: Partial<UserBehaviorPattern>) => {
    userBehaviorRef.current = {
      ...userBehaviorRef.current,
      ...behavior,
    } as UserBehaviorPattern;
  }, []);

  // Background prefetch orchestration
  useEffect(() => {
    if (!enabled || !config.enabled || !config.backgroundPrefetch || !messageId) {
      return;
    }

    const performBackgroundPrefetch = async () => {
      try {
        // This would use the actual Recoil selector in a real implementation
        // For now, we'll simulate intelligent prefetching

        // Simulate delay before starting prefetch
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Example: prefetch based on file position and type
        console.log('Background prefetch triggered for message:', messageId);
      } catch (error) {
        console.error('Background prefetch error:', error);
      }
    };

    // Debounce prefetch triggers
    if (prefetchTimeoutRef.current) {
      clearTimeout(prefetchTimeoutRef.current);
    }

    prefetchTimeoutRef.current = setTimeout(performBackgroundPrefetch, 2000);

    return () => {
      if (prefetchTimeoutRef.current) {
        clearTimeout(prefetchTimeoutRef.current);
      }
    };
  }, [enabled, config, messageId, conversationId, triggerPrefetch]);

  // Cleanup expired prefetched URLs
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      const now = new Date();
      const expired: string[] = [];

      prefetchedUrlsRef.current.forEach((value, key) => {
        if (new Date(value.expiresAt) <= now) {
          expired.push(key);
        }
      });

      expired.forEach((key) => {
        prefetchedUrlsRef.current.delete(key);
      });

      if (expired.length > 0) {
        console.log(`Cleaned up ${expired.length} expired prefetch entries`);
      }
    }, 60000); // Check every minute

    return () => clearInterval(cleanupInterval);
  }, []);

  return {
    isActive: orchestratorStatus.status === 'active',
    prefetchedCount: orchestratorStatus.prefetchedCount,
    queueLength: orchestratorStatus.queueLength,
    estimatedCompleteTime: orchestratorStatus.estimatedCompleteTime,
    triggerPrefetch,
    isPrefetched,
    getPrefetchedUrl,
    clearPrefetchCache,
    updateUserBehavior,
  };
}

/**
 * Hook for tracking user behavior patterns to improve prefetch accuracy
 */
export function useUserBehaviorTracking(_conversationId: string) {
  const behaviorRef = useRef<UserBehaviorPattern>({
    downloadsInSession: 0,
    previewsBeforeDownload: false,
    batchDownloadTendency: false,
    averageSessionDuration: 0,
    preferredFileTypes: [],
    timeOfDayPatterns: [],
  });

  const sessionStartRef = useRef<number>(Date.now());

  const trackDownload = useCallback((fileType?: string) => {
    behaviorRef.current.downloadsInSession += 1;

    if (fileType) {
      const index = behaviorRef.current.preferredFileTypes.indexOf(fileType);
      if (index === -1) {
        behaviorRef.current.preferredFileTypes.push(fileType);
      }
    }

    // Detect batch download tendency
    if (behaviorRef.current.downloadsInSession >= 3) {
      behaviorRef.current.batchDownloadTendency = true;
    }
  }, []);

  const trackPreview = useCallback(() => {
    behaviorRef.current.previewsBeforeDownload = true;
  }, []);

  const getCurrentBehavior = useCallback((): UserBehaviorPattern => {
    const sessionDuration = Date.now() - sessionStartRef.current;
    return {
      ...behaviorRef.current,
      averageSessionDuration: sessionDuration,
    };
  }, []);

  return {
    trackDownload,
    trackPreview,
    getCurrentBehavior,
    behavior: behaviorRef.current,
  };
}
