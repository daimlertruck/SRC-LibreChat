import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

// SharePoint file interface (from existing useSharePointPicker)
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

// Download progress interface
export interface SharePointDownloadProgress {
  fileId: string;
  fileName: string;
  loaded: number;
  total: number;
  progress: number; // 0-100
}

// Batch download progress
export interface SharePointBatchProgress {
  completed: number;
  total: number;
  currentFile?: string;
  failed: string[];
}

// Single file download mutation
export const useSharePointFileDownload = (): UseMutationResult<
  File, // response: downloaded file
  unknown, // error
  {
    file: SharePointFile;
    accessToken: string;
    onProgress?: (progress: SharePointDownloadProgress) => void;
  }, // variables
  unknown // context
> => {
  return useMutation({
    mutationFn: async ({ file, accessToken, onProgress }) => {
      // Use Microsoft Graph API to download file
      const downloadUrl =
        file.downloadUrl ||
        `https://graph.microsoft.com/v1.0/drives/${file.driveId}/items/${file.itemId}/content`;

      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      // Get content length for progress tracking
      const contentLength = parseInt(response.headers.get('content-length') || '0');

      // Read response as stream for progress tracking
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

        // Report progress
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

      // Combine chunks into single array
      const allChunks = new Uint8Array(receivedLength);
      let position = 0;
      for (const chunk of chunks) {
        allChunks.set(chunk, position);
        position += chunk.length;
      }

      // Determine MIME type from filename or response
      const contentType =
        response.headers.get('content-type') || getMimeTypeFromFileName(file.name);

      // Create blob and File object
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

// Batch download mutation for multiple files
export const useSharePointBatchDownload = (): UseMutationResult<
  File[], // response: array of downloaded files
  unknown, // error
  {
    files: SharePointFile[];
    accessToken: string;
    onProgress?: (progress: SharePointBatchProgress) => void;
  }, // variables
  unknown // context
> => {
  return useMutation({
    mutationFn: async ({ files, accessToken, onProgress }) => {
      const downloadedFiles: File[] = [];
      const failed: string[] = [];
      let completed = 0;

      // Download files with concurrency limit (3 at a time)
      const concurrencyLimit = 3;
      const chunks = [];
      for (let i = 0; i < files.length; i += concurrencyLimit) {
        chunks.push(files.slice(i, i + concurrencyLimit));
      }

      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (file) => {
          try {
            const downloadUrl =
              file.downloadUrl ||
              `https://graph.microsoft.com/v1.0/drives/${file.driveId}/items/${file.itemId}/content`;

            const response = await fetch(downloadUrl, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            });

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

        // Collect successful downloads
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

// MIME type utility (following LibreChat utils pattern)
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
