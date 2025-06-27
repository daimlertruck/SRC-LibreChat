import { useCallback } from 'react';
import useFileHandling from './useFileHandling';
import useSharePointDownload from './useSharePointDownload';
import type { SharePointFile } from '~/data-provider/Files/sharepoint';

interface UseSharePointFileHandlingProps {
  fileSetter?: any;
  fileFilter?: (file: File) => boolean;
  additionalMetadata?: Record<string, string | undefined>;
  overrideEndpoint?: any;
  overrideEndpointFileConfig?: any;
  toolResource?: string;
}

interface UseSharePointFileHandlingReturn {
  handleSharePointFiles: (files: SharePointFile[]) => Promise<void>;
  isProcessing: boolean;
  downloadProgress: any;
  error: string | null;
}

export default function useSharePointFileHandling(
  props?: UseSharePointFileHandlingProps,
): UseSharePointFileHandlingReturn {
  // Get the main file handling hook
  const { handleFiles } = useFileHandling(props);

  // Get SharePoint download capability
  const { downloadSharePointFiles, isDownloading, downloadProgress, error } = useSharePointDownload(
    {
      onFilesDownloaded: async (downloadedFiles: File[]) => {
        // Convert downloaded files to FileList-like array and pass to existing pipeline
        const fileArray = Array.from(downloadedFiles);

        // Feed into existing file handling pipeline with tool resource
        await handleFiles(fileArray, props?.toolResource);
      },
      onError: (error) => {
        console.error('SharePoint download failed:', error);
      },
    },
  );

  const handleSharePointFiles = useCallback(
    async (sharePointFiles: SharePointFile[]) => {
      try {
        // This will download the files and automatically feed them into the existing pipeline
        await downloadSharePointFiles(sharePointFiles);
      } catch (error) {
        console.error('SharePoint file handling error:', error);
        throw error;
      }
    },
    [downloadSharePointFiles],
  );

  return {
    handleSharePointFiles,
    isProcessing: isDownloading,
    downloadProgress,
    error,
  };
}
