import { useCallback } from 'react';
import { useAgentSourceDownload } from 'librechat-data-provider/react-query';

interface UseAgentFileDownloadOptions {
  conversationId: string;
  onSuccess?: (fileName: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Simple hook for agent file downloads
 * Follows LibreChat patterns - straightforward and focused
 */
export function useAgentFileDownload(options: UseAgentFileDownloadOptions) {
  const { conversationId, onSuccess, onError } = options;
  const downloadMutation = useAgentSourceDownload();

  const downloadFile = useCallback(
    async (fileId: string, messageId: string, fileName: string) => {
      try {
        const response = await downloadMutation.mutateAsync({
          fileId,
          messageId,
          conversationId,
        });

        // Download all files directly, regardless of type
        const finalFileName = response.fileName || fileName;
        const link = document.createElement('a');
        link.href = response.downloadUrl;
        link.download = finalFileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        onSuccess?.(fileName);
      } catch (error) {
        onError?.(error as Error);
      }
    },
    [conversationId, downloadMutation, onSuccess, onError],
  );

  return {
    downloadFile,
    isLoading: downloadMutation.isLoading,
    error: downloadMutation.error,
  };
}
