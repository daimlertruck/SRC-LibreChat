import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthContext } from '~/hooks/AuthContext';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useToastContext } from '~/Providers';
import { SPPickerConfig } from './config';

interface SharePointFilePickerProps {
  disabled?: boolean;
  onFilesSelected?: (files: any[]) => void;
}

// TODO: Replace with env var check and config later
const ENABLE_SHAREPOINT_PICKER = true;
const SHAREPOINT_BASE_URL = 'https://m365x98302257.sharepoint.com/';

export default function SharePointFilePicker({
  disabled = false,
  onFilesSelected,
}: SharePointFilePickerProps) {
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Feature toggle - return null if disabled
  if (!ENABLE_SHAREPOINT_PICKER) {
    return null;
  }

  // Check if user is authenticated via Entra ID (OpenID)
  const isEntraIdUser = user?.provider === 'openid' && user?.openidId;

  // Get Graph API token for SharePoint access
  const {
    data: token,
    isLoading: isTokenLoading,
    error: tokenError,
  } = useQuery({
    queryKey: [
      QueryKeys.graphToken,
      `${SHAREPOINT_BASE_URL}MyFiles.Read ${SHAREPOINT_BASE_URL}AllSites.Read`,
    ],
    queryFn: () =>
      dataService.getGraphApiToken({
        scopes: `${SHAREPOINT_BASE_URL}MyFiles.Read ${SHAREPOINT_BASE_URL}AllSites.Read`,
      }),
    enabled: isEntraIdUser && !disabled,
    staleTime: 50 * 60 * 1000, // 50 minutes (tokens expire in 60 minutes)
    retry: 1,
  });

  const handleSharePointPicker = async () => {
    if (!token) {
      showToast({
        message: 'Unable to access SharePoint. Please ensure you are logged in with Microsoft.',
        status: 'error',
      });
      return;
    }

    try {
      setIsPickerOpen(true);

      console.log('=== SharePoint File Picker v8 ===');
      console.log('Token available:', {
        hasToken: !!token.access_token,
        tokenType: token.token_type,
        expiresIn: token.expires_in,
        scopes: token.scope,
      });

      // Microsoft File Picker v8 iframe approach - remove token from options
      const pickerOptions: SPPickerConfig = {
        sdk: '8.0',
        entry: {
          sharePoint: {
            // byPath: SHAREPOINT_BASE_URL,
          },
        },
        messaging: {
          origin: window.location.origin,
          channelId: `sharepoint-picker-123123123`,
        },
        typesAndSources: {
          mode: 'files',
          pivots: {
            oneDrive: true,
            recent: true,
            // sharePoint: true,
          },
        },
        selection: {
          mode: 'multiple',
        },
        title: 'LibreChat SharePoint File Picker',
        commands: {
          upload: {
            enabled: false,
          },
          createFolder: {
            enabled: false,
          },
        },
        search: { enabled: true },
        // tray: {
        //   commands: [
        //     {
        //       key: 'upload',
        //       label: 'Upload',
        //       action: 'pick',
        //     },
        //   ],

        // },
      };

      // Create iframe for picker
      const iframe = document.createElement('iframe');
      iframe.style.width = '1080px';
      iframe.style.height = '680px';
      iframe.style.border = '1px solid #ccc';
      iframe.style.position = 'fixed';
      iframe.style.top = '50%';
      iframe.style.left = '50%';
      iframe.style.transform = 'translate(-50%, -50%)';
      iframe.style.zIndex = '10000';
      iframe.style.backgroundColor = 'white';

      // Create overlay
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
      overlay.style.zIndex = '9999';

      document.body.appendChild(overlay);
      overlay.appendChild(iframe);

      // Set iframe src to about:blank and wait for load
      iframe.src = 'about:blank';
      iframe.onload = () => {
        const win = iframe.contentWindow;
        if (!win) return;

        // Construct query string following Microsoft docs
        const queryString = new URLSearchParams({
          filePicker: JSON.stringify(pickerOptions),
          locale: 'en-us',
        });

        // Create the absolute URL
        const url = SHAREPOINT_BASE_URL + `_layouts/15/FilePicker.aspx?${queryString}`;

        // Create form in iframe document following Microsoft docs pattern
        const form = win.document.createElement('form');
        form.setAttribute('action', url);
        form.setAttribute('method', 'POST');

        // Create hidden input for OAuth token (required for iframe)
        const tokenInput = win.document.createElement('input');
        tokenInput.setAttribute('type', 'hidden');
        tokenInput.setAttribute('name', 'access_token');
        tokenInput.setAttribute('value', token.access_token);
        form.appendChild(tokenInput);

        // Append form to iframe body and submit
        win.document.body.appendChild(form);
        form.submit();
      };

      // Listen for messages from the picker
      const messageHandler = (event: MessageEvent) => {
        console.log('=== SharePoint picker message received ===');
        console.log('Event origin:', event.origin);
        console.log('Expected origin:', new URL(SHAREPOINT_BASE_URL).origin);
        console.log('Event data:', event.data);
        console.log('Event source:', event.source);

        // More flexible origin checking - SharePoint can send messages from different subdomains
        const expectedOrigin = new URL(SHAREPOINT_BASE_URL).origin;
        if (!event.origin.includes('sharepoint.com') && event.origin !== expectedOrigin) {
          console.log('Origin check failed, ignoring message');
          return;
        }

        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          console.log('Parsed message data:', data);

          if (data.type === 'initialize') {
            console.log('SharePoint picker initialized');
          } else if (data.type === 'activate') {
            console.log('SharePoint picker activated');
          } else if (data.type === 'pick' || data.type === 'picked') {
            console.log('Files picked from SharePoint:', data);

            // Handle different response formats
            const items = data.items || data.files || data.result?.items || [];
            console.log('Extracted items:', items);

            if (items && items.length > 0) {
              const selectedFiles = items.map((item: any) => ({
                id: item.id || item.shareId || item.driveItem?.id,
                name: item.name || item.driveItem?.name,
                size: item.size || item.driveItem?.size,
                webUrl: item.webUrl || item.driveItem?.webUrl,
                downloadUrl: item.downloadUrl || item.driveItem?.['@microsoft.graph.downloadUrl'],
                driveId:
                  item.driveId ||
                  item.parentReference?.driveId ||
                  item.driveItem?.parentReference?.driveId,
                itemId: item.id || item.driveItem?.id,
                sharePointItem: item,
              }));

              console.log('Processed SharePoint files:', selectedFiles);

              if (onFilesSelected) {
                onFilesSelected(selectedFiles);
              }

              showToast({
                message: `Selected ${selectedFiles.length} file(s) from SharePoint`,
                status: 'success',
              });
            } else {
              console.log('No files found in pick message');
            }

            // Close picker
            cleanup();
          } else if (data.type === 'cancel' || data.type === 'cancelled') {
            console.log('SharePoint picker cancelled');
            cleanup();
          } else if (data.type === 'error') {
            console.error('SharePoint picker error:', data.error);
            showToast({
              message: `SharePoint picker error: ${data.error?.message || 'Unknown error'}`,
              status: 'error',
            });
            cleanup();
          } else {
            console.log('Unknown message type:', data.type);
          }
        } catch (error) {
          console.error('Error processing picker message:', error);
          console.log('Raw event data that failed to parse:', event.data);
        }
      };

      const cleanup = () => {
        window.removeEventListener('message', messageHandler);
        if (overlay && overlay.parentNode) {
          document.body.removeChild(overlay);
        }
        setIsPickerOpen(false);
      };

      // Add close button to overlay
      const closeButton = document.createElement('button');
      closeButton.textContent = '×';
      closeButton.style.position = 'absolute';
      closeButton.style.top = '20px';
      closeButton.style.right = '20px';
      closeButton.style.background = 'white';
      closeButton.style.border = '1px solid #ccc';
      closeButton.style.borderRadius = '50%';
      closeButton.style.width = '30px';
      closeButton.style.height = '30px';
      closeButton.style.cursor = 'pointer';
      closeButton.style.fontSize = '20px';
      closeButton.style.zIndex = '10001';
      closeButton.onclick = cleanup;
      overlay.appendChild(closeButton);

      window.addEventListener('message', messageHandler);
    } catch (error) {
      console.error('SharePoint file picker error:', error);
      showToast({
        message: 'Failed to open SharePoint file picker.',
        status: 'error',
      });
      setIsPickerOpen(false);
    }
  };

  // Don't show the button if user is not authenticated via Entra ID
  if (!isEntraIdUser) {
    return null;
  }

  // Show error if token failed to load
  if (tokenError) {
    console.error('Graph token error:', tokenError);
    return null;
  }

  return (
    <button
      type="button"
      disabled={disabled || isTokenLoading || isPickerOpen}
      className="btn btn-neutral border-token-border-light relative mt-2 h-9 w-full rounded-lg font-medium"
      onClick={handleSharePointPicker}
    >
      <div className="flex w-full items-center justify-center gap-1">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
          {/* SharePoint icon */}
          <path d="M18.5 2c3 0 3.5.5 3.5 3.5v13c0 3-.5 3.5-3.5 3.5h-13C2.5 22 2 21.5 2 18.5v-13C2 2.5 2.5 2 5.5 2h13zm-1.25 6.25h-2.5v2.5h2.5v-2.5zm0 3.75h-2.5V14.5h2.5V12zm-3.75-3.75h-2.5v2.5h2.5v-2.5zm0 3.75h-2.5V14.5h2.5V12zM10 8.25H7.5v2.5H10v-2.5zM10 12H7.5V14.5H10V12z" />
        </svg>
        {isTokenLoading
          ? 'Loading...'
          : isPickerOpen
            ? 'Opening SharePoint...'
            : 'Upload from SharePoint'}
      </div>
    </button>
  );
}
