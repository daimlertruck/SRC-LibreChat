import { useCallback, useState } from 'react';
import { useToastContext } from '~/Providers';
import { useSharePointBatchDownload } from '~/data-provider/Files/sharepoint';
import useSharePointToken from './useSharePointToken';
import type { SharePointFile, SharePointBatchProgress } from '~/data-provider/Files/sharepoint';

interface UseSharePointDownloadProps {
  onFilesDownloaded?: (files: File[]) => void | Promise<void>;
  onError?: (error: Error) => void;
}

interface UseSharePointDownloadReturn {
  downloadSharePointFiles: (files: SharePointFile[]) => Promise<File[]>;
  isDownloading: boolean;
  downloadProgress: SharePointBatchProgress | null;
  error: string | null;
}

export default function useSharePointDownload({
  onFilesDownloaded,
  onError,
}: UseSharePointDownloadProps = {}): UseSharePointDownloadReturn {
  const { showToast } = useToastContext();
  const [downloadProgress, setDownloadProgress] = useState<SharePointBatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Graph API token (using shared hook with same scopes as picker)
  const { token, refetch: refetchToken } = useSharePointToken({
    enabled: false,
    purpose: 'Download',
  });

  // Batch download mutation (correct as mutation - user-triggered action)
  const batchDownloadMutation = useSharePointBatchDownload();

  const downloadSharePointFiles = useCallback(
    async (files: SharePointFile[]): Promise<File[]> => {
      if (!files || files.length === 0) {
        throw new Error('No files provided for download');
      }

      setError(null);
      setDownloadProgress({ completed: 0, total: files.length, failed: [] });

      try {
        // Get fresh token for this download session
        let accessToken = token?.access_token;
        if (!accessToken) {
          showToast({
            message: 'Getting SharePoint access token...',
            status: 'info',
            duration: 2000,
          });

          const tokenResult = await refetchToken();
          accessToken = tokenResult.data?.access_token;

          if (!accessToken) {
            throw new Error('Failed to obtain SharePoint access token');
          }
        }

        // Show download start toast
        showToast({
          message: `Downloading ${files.length} file(s) from SharePoint...`,
          status: 'info',
          duration: 3000,
        });

        // Start batch download mutation
        const downloadedFiles = await batchDownloadMutation.mutateAsync({
          files,
          accessToken,
          onProgress: (progress) => {
            setDownloadProgress(progress);

            // Show progress updates for large downloads
            if (files.length > 5 && progress.completed % 3 === 0) {
              showToast({
                message: `Downloaded ${progress.completed}/${progress.total} files...`,
                status: 'info',
                duration: 1000,
              });
            }
          },
        });

        // Success handling
        if (downloadedFiles.length > 0) {
          const failedCount = files.length - downloadedFiles.length;
          const successMessage =
            failedCount > 0
              ? `Downloaded ${downloadedFiles.length}/${files.length} files from SharePoint (${failedCount} failed)`
              : `Successfully downloaded ${downloadedFiles.length} file(s) from SharePoint`;

          showToast({
            message: successMessage,
            status: failedCount > 0 ? 'warning' : 'success',
            duration: 4000,
          });

          // Call success callback
          if (onFilesDownloaded) {
            await onFilesDownloaded(downloadedFiles);
          }
        }

        setDownloadProgress(null);
        return downloadedFiles;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown download error';
        setError(errorMessage);

        showToast({
          message: `SharePoint download failed: ${errorMessage}`,
          status: 'error',
          duration: 5000,
        });

        if (onError) {
          onError(error instanceof Error ? error : new Error(errorMessage));
        }

        setDownloadProgress(null);
        throw error;
      }
    },
    [token, showToast, batchDownloadMutation, onFilesDownloaded, onError, refetchToken],
  );

  return {
    downloadSharePointFiles,
    isDownloading: batchDownloadMutation.isLoading,
    downloadProgress,
    error,
  };
}
