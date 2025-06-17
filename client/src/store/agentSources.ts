import { atom, atomFamily, selector, selectorFamily } from 'recoil';
import type { TAttachment } from 'librechat-data-provider';

// Atom family for storing agent sources by message ID
export const agentSourcesByMessageId = atomFamily<TAttachment[], string>({
  key: 'agentSourcesByMessageId',
  default: [],
});

// Atom family for storing prefetched download URLs by file ID
export const prefetchedUrlsByFileId = atomFamily<
  {
    downloadUrl?: string;
    expiresAt?: string;
    fileName?: string;
    mimeType?: string;
  } | null,
  string
>({
  key: 'prefetchedUrlsByFileId',
  default: null,
});

// Selector for pre-fetching URLs for agent sources
export const prefetchedUrlsSelector = selectorFamily({
  key: 'prefetchedUrls',
  get:
    (messageId: string) =>
    async ({ get }) => {
      const sources = get(agentSourcesByMessageId(messageId));
      if (sources.length === 0) return {};

      const fileIds = sources
        .filter((s) => s.metadata?.storageType === 's3' && s.fileId)
        .map((s) => s.fileId as string);

      if (fileIds.length === 0) return {};

      try {
        // Use batch endpoint for better performance
        const response = await fetch('/api/files/agent-source-urls-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileIds }),
        });

        if (!response.ok) {
          console.error('Failed to prefetch URLs:', response.statusText);
          return {};
        }

        return response.json();
      } catch (error) {
        console.error('Error prefetching URLs:', error);
        return {};
      }
    },
});

// Selector for getting sources with prefetched URLs
export const sourcesWithUrlsSelector = selectorFamily({
  key: 'sourcesWithUrls',
  get:
    (messageId: string) =>
    ({ get }) => {
      const sources = get(agentSourcesByMessageId(messageId));
      const prefetchedUrls = get(prefetchedUrlsSelector(messageId));

      return sources.map((source) => ({
        ...source,
        downloadUrl: prefetchedUrls[source.fileId as string]?.downloadUrl,
        urlExpiresAt: prefetchedUrls[source.fileId as string]?.expiresAt,
      }));
    },
});

// Hook for managing agent sources with URL prefetching
export const useAgentSourcesWithUrls = (messageId: string) => {
  const sources = sourcesWithUrlsSelector(messageId);

  return {
    sources,
  };
};

// Action to set agent sources for a message
export const setAgentSources = (messageId: string, sources: TAttachment[]) => {
  // This would be used with useSetRecoilState in components
  return sources;
};

// Action to clear agent sources for a message
export const clearAgentSources = (messageId: string) => {
  // This would be used with useResetRecoilState in components
  return [];
};

// Helper to check if a source has a valid download URL
export const hasValidDownloadUrl = (source: TAttachment & { urlExpiresAt?: string }) => {
  if (!source.downloadUrl || !source.urlExpiresAt) {
    return false;
  }

  return new Date(source.urlExpiresAt) > new Date();
};
