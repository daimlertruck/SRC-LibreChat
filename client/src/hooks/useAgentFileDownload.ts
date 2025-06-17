import { useCallback } from 'react';
import { useAgentSourceDownload } from 'librechat-data-provider';

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

        // Check if it's a PDF file
        const finalFileName = response.fileName || fileName;
        const isPDF =
          finalFileName.toLowerCase().endsWith('.pdf') || response.mimeType === 'application/pdf';

        if (isPDF) {
          // Open PDF in new tab for viewing
          window.open(response.downloadUrl, '_blank', 'noopener,noreferrer');
        } else {
          // Download other file types normally
          const link = document.createElement('a');
          link.href = response.downloadUrl;
          link.download = finalFileName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }

        onSuccess?.(fileName);
      } catch (error) {
        console.error('File download failed:', error);
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
