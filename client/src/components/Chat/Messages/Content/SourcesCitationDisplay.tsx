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
  pageRelevance?: Record<number, number>;
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

  const { downloadFile } = useAgentFileDownload({
    conversationId,
    onSuccess: (fileName) => {
      setDownloadingFiles((prev) => {
        const next = new Set(prev);
        next.delete(fileName);
        return next;
      });
    },
    onError: (_error) => {
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

  // Helper function to sort pages by relevance (highest first)
  const sortPagesByRelevance = useCallback((pages: number[], pageRelevance?: Record<number, number>) => {
    if (!pageRelevance || Object.keys(pageRelevance).length === 0) {
      return pages; // Return original order if no relevance data
    }
    
    return [...pages].sort((a, b) => {
      const relevanceA = pageRelevance[a] || 0;
      const relevanceB = pageRelevance[b] || 0;
      return relevanceB - relevanceA; // Highest relevance first
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
    return null;
  }
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        {localize('com_sources_referenced_files')}
      </div>
      <div className="scrollbar-none grid w-full grid-cols-4 gap-2 overflow-x-auto">
        {sources.map((source) => {
          const isExpanded = expandedSources.has(source.fileId);
          const isDownloading = downloadingFiles.has(source.fileName);
          const canDownload = source.metadata?.storageType === 's3';

          return (
            <div key={source.fileId} className="w-full min-w-[120px]">
              <button
                onClick={() => toggleSource(source.fileId)}
                disabled={isDownloading}
                className="flex w-full flex-col rounded-lg bg-surface-primary-contrast px-3 py-2 text-sm transition-all duration-300 hover:bg-surface-tertiary disabled:opacity-50"
              >
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate text-xs font-medium text-text-secondary">
                    {localize('com_sources_agent_file')}
                  </span>
                  {canDownload && (
                    <Download className="ml-auto h-3 w-3" />
                  )}
                </div>
                <div className="mt-1">
                  <span className="line-clamp-2 text-left text-sm font-medium text-text-primary md:line-clamp-3">
                    {source.fileName}
                  </span>
                  {source.pages && source.pages.length > 0 && (
                    <span className="mt-1 line-clamp-1 text-left text-xs text-text-secondary">
                      Pages: {sortPagesByRelevance(source.pages, source.pageRelevance).join(', ')}
                    </span>
                  )}
                  {source.relevance && (
                    <span className="mt-1 line-clamp-1 text-xs text-text-secondary">
                      {Math.round(source.relevance * 100)}% {localize('com_sources_relevant')}
                    </span>
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SourcesCitationDisplay;
