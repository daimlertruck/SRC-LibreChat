import React, { useState, useCallback } from 'react';
import { FileText, Download } from 'lucide-react';
import { useAgentFileDownload } from '~/hooks/useAgentFileDownload';
import useLocalize from '~/hooks/useLocalize';
import { cn } from '~/utils';

interface FileSource {
  fileId: string;
  fileName: string;
  relevance?: number;
  pages?: number[];
  metadata?: {
    storageType?: string;
    s3Bucket?: string;
    s3Key?: string;
  };
}

interface SourcesCitationDisplayProps {
  sources: FileSource[];
  messageId: string;
  conversationId: string;
}

const SourcesCitationDisplay: React.FC<SourcesCitationDisplayProps> = ({
  sources,
  messageId,
  conversationId,
}) => {
  const localize = useLocalize();
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(new Set());

  console.log('[SourcesCitationDisplay] Rendering with:', {
    sources,
    sourcesLength: sources?.length,
    messageId,
    conversationId,
  });

  const { downloadFile } = useAgentFileDownload({
    conversationId,
    onSuccess: (fileName) => {
      setDownloadingFiles((prev) => {
        const next = new Set(prev);
        next.delete(fileName);
        return next;
      });
    },
    onError: (error) => {
      console.error('Download failed:', error);
      setDownloadingFiles(new Set());
    },
  });

  const toggleSource = useCallback((fileId: string) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  }, []);

  const handleDownload = useCallback(
    async (source: FileSource) => {
      if (source.metadata?.storageType === 's3' && source.metadata?.s3Bucket) {
        setDownloadingFiles((prev) => new Set(prev).add(source.fileName));
        await downloadFile(source.fileId, messageId, source.fileName);
      }
    },
    [downloadFile, messageId],
  );

  if (!sources || sources.length === 0) {
    console.log('[SourcesCitationDisplay] No sources to display, returning null');
    return null;
  }

  console.log(
    '[SourcesCitationDisplay] Rendering citation display with',
    sources.length,
    'sources',
  );
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        {localize('com_sources_referenced_files')}
      </div>
      <div className="space-y-2">
        {sources.map((source) => {
          const isExpanded = expandedSources.has(source.fileId);
          const isDownloading = downloadingFiles.has(source.fileName);
          const canDownload = source.metadata?.storageType === 's3';

          return (
            <div
              key={source.fileId}
              className="rounded-md border border-gray-200 bg-white p-2 dark:border-gray-600 dark:bg-gray-700"
            >
              <div className="flex items-center justify-between">
                <button
                  onClick={() => toggleSource(source.fileId)}
                  className="flex flex-1 items-center gap-2 text-left transition-colors hover:text-blue-600 dark:hover:text-blue-400"
                >
                  <FileText className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm font-medium">{source.fileName}</span>
                  {source.relevance && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      ({Math.round(source.relevance * 100)}% {localize('com_sources_relevant')})
                    </span>
                  )}
                </button>
                {canDownload && (
                  <button
                    onClick={() => handleDownload(source)}
                    disabled={isDownloading}
                    className={cn(
                      'ml-2 rounded p-1 transition-colors',
                      'hover:bg-gray-100 dark:hover:bg-gray-600',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                    title={localize('com_sources_download_file')}
                  >
                    {isDownloading ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600 dark:border-gray-600 dark:border-t-gray-300" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                  </button>
                )}
              </div>
              {isExpanded && source.pages && source.pages.length > 0 && (
                <div className="mt-2 text-left text-xs text-gray-600 dark:text-gray-400">
                  {localize('com_sources_pages')}: {source.pages.join(', ')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SourcesCitationDisplay;
