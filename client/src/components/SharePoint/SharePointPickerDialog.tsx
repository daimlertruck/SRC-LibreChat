import React, { useState, useEffect } from 'react';
import {
  OGDialog,
  OGDialogContent,
  OGDialogOverlay,
  OGDialogPortal,
  OGDialogTitle,
} from '~/components/ui/OriginalDialog';
import { useSharePointPicker } from '~/hooks';

interface SharePointPickerDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onFilesSelected?: (files: any[]) => void;
  disabled?: boolean;
}

export default function SharePointPickerDialog({
  isOpen,
  onOpenChange,
  onFilesSelected,
  disabled = false,
}: SharePointPickerDialogProps) {
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);

  const { openSharePointPicker, closeSharePointPicker, cleanup } = useSharePointPicker({
    containerNode,
    onFilesSelected,
    disabled,
    onClose: () => handleOpenChange(false),
  });
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      closeSharePointPicker();
    }
    onOpenChange(open);
  };
  // Use callback ref to trigger SharePoint picker when container is attached
  const containerCallbackRef = React.useCallback((node: HTMLDivElement | null) => {
    setContainerNode(node);
  }, []);

  useEffect(() => {
    if (containerNode && isOpen) {
      openSharePointPicker();
    }
    return () => {
      if (!isOpen) {
        cleanup();
      }
    };
  }, [containerNode, isOpen]);
  return (
    <OGDialog open={isOpen} onOpenChange={handleOpenChange}>
      <OGDialogPortal>
        <OGDialogOverlay className="bg-black/50" />
        <OGDialogContent
          className="bg-#F5F5F5 sharepoint-picker-bg fixed left-1/2 top-1/2 z-50 h-[680px] max-h-[90vh] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-2 shadow-lg focus:outline-none"
          showCloseButton={true}
        >
          <OGDialogTitle className="sr-only">{`SharePoint File Picker`}</OGDialogTitle>
          <div ref={containerCallbackRef} className="sharepoint-picker-bg flex p-2">
            {/* {isLoading && (
              <div className="text-center">
                <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"></div>
                <p className="text-gray-600">Loading SharePoint...</p>
              </div>
            )} */}
            {/* SharePoint iframe will be injected here by the hook */}
          </div>
        </OGDialogContent>
      </OGDialogPortal>
    </OGDialog>
  );
}
