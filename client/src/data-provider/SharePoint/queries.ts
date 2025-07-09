import { useMutation, useInfiniteQuery } from '@tanstack/react-query';
import type { UseMutationResult, UseInfiniteQueryResult } from '@tanstack/react-query';
import { parseSearchResponse, SharePointSite } from '~/utils/sharepoint';

export interface SharePointFile {
  id: string;
  name: string;
  size: number;
  webUrl: string;
  downloadUrl: string;
  driveId: string;
  itemId: string;
  sharePointItem: any;
}

export interface SharePointDownloadProgress {
  fileId: string;
  fileName: string;
  loaded: number;
  total: number;
  progress: number;
}

export interface SharePointBatchProgress {
  completed: number;
  total: number;
  currentFile?: string;
  failed: string[];
}

export const useSharePointFileDownload = (): UseMutationResult<
  File,
  unknown,
  {
    file: SharePointFile;
    onProgress?: (progress: SharePointDownloadProgress) => void;
  }
> => {
  return useMutation({
    mutationFn: async ({ file, onProgress }) => {
      if (!file.downloadUrl) {
        throw new Error(`Download URL not provided for file: ${file.name}`);
      }
      const downloadUrl = file.downloadUrl;

      const response = await fetch(downloadUrl);

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const contentLength = parseInt(response.headers.get('content-length') || '0');
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response reader');
      }

      const chunks: Uint8Array[] = [];
      let receivedLength = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        chunks.push(value);
        receivedLength += value.length;

        if (onProgress) {
          onProgress({
            fileId: file.id,
            fileName: file.name,
            loaded: receivedLength,
            total: contentLength || file.size,
            progress: Math.round((receivedLength / (contentLength || file.size)) * 100),
          });
        }
      }

      const allChunks = new Uint8Array(receivedLength);
      let position = 0;
      for (const chunk of chunks) {
        allChunks.set(chunk, position);
        position += chunk.length;
      }

      const contentType =
        response.headers.get('content-type') || getMimeTypeFromFileName(file.name);

      const blob = new Blob([allChunks], { type: contentType });
      const downloadedFile = new File([blob], file.name, {
        type: contentType,
        lastModified: Date.now(),
      });

      return downloadedFile;
    },
    retry: 2,
  });
};

export const useSharePointBatchDownload = (): UseMutationResult<
  File[],
  unknown,
  {
    files: SharePointFile[];
    onProgress?: (progress: SharePointBatchProgress) => void;
  },
  unknown
> => {
  return useMutation({
    mutationFn: async ({ files, onProgress }) => {
      const downloadedFiles: File[] = [];
      const failed: string[] = [];
      let completed = 0;

      const concurrencyLimit = 3;
      const chunks: SharePointFile[][] = [];
      for (let i = 0; i < files.length; i += concurrencyLimit) {
        chunks.push(files.slice(i, i + concurrencyLimit));
      }

      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (file) => {
          try {
            if (!file.downloadUrl) {
              throw new Error(`Download URL not provided for file: ${file.name}`);
            }
            const downloadUrl = file.downloadUrl;

            const response = await fetch(downloadUrl);

            if (!response.ok) {
              throw new Error(`${response.status} ${response.statusText}`);
            }

            const blob = await response.blob();
            const contentType =
              response.headers.get('content-type') || getMimeTypeFromFileName(file.name);

            const downloadedFile = new File([blob], file.name, {
              type: contentType,
              lastModified: Date.now(),
            });

            completed++;
            onProgress?.({
              completed,
              total: files.length,
              currentFile: file.name,
              failed,
            });

            return downloadedFile;
          } catch (error) {
            console.error(`Failed to download ${file.name}:`, error);
            failed.push(file.name);
            completed++;
            onProgress?.({
              completed,
              total: files.length,
              currentFile: `Error: ${file.name}`,
              failed,
            });
            throw error;
          }
        });

        const chunkResults = await Promise.allSettled(chunkPromises);

        chunkResults.forEach((result) => {
          if (result.status === 'fulfilled') {
            downloadedFiles.push(result.value);
          }
        });
      }

      if (failed.length > 0) {
        console.warn(`Failed to download ${failed.length} files:`, failed);
      }

      return downloadedFiles;
    },
    retry: 1,
  });
};

function getMimeTypeFromFileName(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',

    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    webp: 'image/webp',

    // Archives
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',

    // Media
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };

  return mimeTypes[extension || ''] || 'application/octet-stream';
}

export { getMimeTypeFromFileName };

export interface UseSharePointSitesQueryParams {
  baseUrl: string;
  accessToken: string;
  searchQuery?: string;
  rowsPerPage?: number;
  enabled?: boolean;
}

export const useSharePointSitesInfiniteQuery = ({
  baseUrl,
  accessToken,
  searchQuery = '',
  rowsPerPage = 10,
  enabled = true,
}: UseSharePointSitesQueryParams): UseInfiniteQueryResult<
  { sites: SharePointSite[]; hasMore: boolean; total: number },
  Error
> => {
  return useInfiniteQuery({
    queryKey: ['sharepoint-sites', baseUrl, accessToken, searchQuery],
    queryFn: async ({ pageParam = 0 }) => {
      if (!baseUrl || !accessToken) {
        throw new Error('SharePoint configuration or access token not available');
      }

      // Build search query
      let spSearchQuery = 'contentclass:STS_Site OR contentclass:STS_Web';
      if (searchQuery && searchQuery.trim().length > 0) {
        const trimmedQuery = searchQuery.trim();
        spSearchQuery = `(${spSearchQuery}) AND (Title:${trimmedQuery}* OR SiteDescription:${trimmedQuery}*)`;
      }

      // Build search URL
      const searchUrl =
        `${baseUrl}/_api/search/query` +
        `?querytext='${encodeURIComponent(spSearchQuery)}'` +
        `&startrow=${pageParam}` +
        `&rowlimit=${rowsPerPage}` +
        `&selectproperties='Title,SiteName,SiteDescription,SPWebUrl,Path,SiteId,UniqueId,WebTemplate,contentclass'`;

      // Execute search
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json;odata=verbose',
          'Content-Type': 'application/json;odata=verbose',
        },
      });

      if (!response.ok) {
        throw new Error(`SharePoint search failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const sites = parseSearchResponse(data);
      const totalRows = data?.d?.query?.PrimaryQueryResult?.RelevantResults?.TotalRows || 0;

      return {
        sites,
        hasMore: pageParam + sites.length < totalRows,
        total: totalRows,
      };
    },
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.hasMore) {
        return allPages.reduce((acc, page) => acc + page.sites.length, 0);
      }
      return undefined;
    },
    enabled: Boolean(baseUrl && accessToken && enabled),
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2,
  });
};
