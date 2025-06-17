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

      // TODO: Implement batch endpoint for URL prefetching when ready
      return {};
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

// Helper to check if a source has a valid download URL
export const hasValidDownloadUrl = (source: TAttachment & { urlExpiresAt?: string }) => {
  if (!source.downloadUrl || !source.urlExpiresAt) {
    return false;
  }

  return new Date(source.urlExpiresAt) > new Date();
};
