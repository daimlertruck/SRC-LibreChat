import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthContext } from '~/hooks/AuthContext';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useToastContext } from '~/Providers';
import { useGetStartupConfig } from '~/data-provider';
import { SPPickerConfig } from '../../components/SidePanel/Agents/config';

interface UseSharePointPickerProps {
  onFilesSelected?: (files: any[]) => void;
  disabled?: boolean;
}

interface UseSharePointPickerReturn {
  openSharePointPicker: () => void;
  isPickerOpen: boolean;
  isLoading: boolean;
  error: string | null;
}

export default function useSharePointPicker({
  onFilesSelected,
  disabled = false,
}: UseSharePointPickerProps): UseSharePointPickerReturn {
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const channelIdRef = useRef<string>('');

  // Get startup configuration
  const { data: startupConfig } = useGetStartupConfig();

  const sharePointBaseUrl = startupConfig?.sharePointBaseUrl;
  const sharePointPickerGraphScope = startupConfig?.sharePointPickerGraphScope;

  // Check if user is authenticated via Entra ID (OpenID)
  const isEntraIdUser = user?.provider === 'openid';

  // Get Graph API token for SharePoint access
  const graphScopes =
    sharePointPickerGraphScope ||
    `${sharePointBaseUrl}MyFiles.Read ${sharePointBaseUrl}AllSites.Read`;

  const {
    data: token,
    isLoading: isTokenLoading,
    error: tokenError,
  } = useQuery({
    queryKey: [QueryKeys.graphToken, graphScopes],
    queryFn: () =>
      dataService.getGraphApiToken({
        scopes: graphScopes,
      }),
    enabled: isEntraIdUser && !disabled && !!sharePointBaseUrl,
    staleTime: 50 * 60 * 1000, // 50 minutes (tokens expire in 60 minutes)
    retry: 1,
  });

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, []);

  // Generate unique channel ID for this picker instance
  const generateChannelId = useCallback(() => {
    return `sharepoint-picker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // MessagePort command handler - follows Microsoft samples pattern
  const portMessageHandler = useCallback(
    async (message: MessageEvent) => {
      console.log('=== SharePoint picker port message received ===');
      console.log('Message data:', message.data);

      const port = portRef.current;
      if (!port) {
        console.error('No port available for communication');
        return;
      }

      try {
        switch (message.data.type) {
          case 'notification':
            console.log('SharePoint picker notification:', message.data);
            break;

          case 'command': {
            // Always acknowledge the command first
            port.postMessage({
              type: 'acknowledge',
              id: message.data.id,
            });

            const command = message.data.data;
            console.log('SharePoint picker command:', command);

            switch (command.command) {
              case 'authenticate':
                console.log('Authentication requested, providing token');
                if (token?.access_token) {
                  port.postMessage({
                    type: 'result',
                    id: message.data.id,
                    data: {
                      result: 'token',
                      token: token.access_token,
                    },
                  });
                } else {
                  console.error('No token available for authentication');
                  port.postMessage({
                    type: 'result',
                    id: message.data.id,
                    data: {
                      result: 'error',
                      error: {
                        code: 'noToken',
                        message: 'No authentication token available',
                      },
                    },
                  });
                }
                break;

              case 'close':
                console.log('Close command received');
                port.postMessage({
                  type: 'result',
                  id: message.data.id,
                  data: {
                    result: 'success',
                  },
                });
                if (cleanupRef.current) {
                  cleanupRef.current();
                }
                break;

              case 'pick': {
                console.log('Files picked from SharePoint:', command);

                // Extract files from the command data
                const items = command.items || command.files || [];
                console.log('Extracted items:', items);

                if (items && items.length > 0) {
                  const selectedFiles = items.map((item: any) => ({
                    id: item.id || item.shareId || item.driveItem?.id,
                    name: item.name || item.driveItem?.name,
                    size: item.size || item.driveItem?.size,
                    webUrl: item.webUrl || item.driveItem?.webUrl,
                    downloadUrl:
                      item.downloadUrl || item.driveItem?.['@microsoft.graph.downloadUrl'],
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
                }

                port.postMessage({
                  type: 'result',
                  id: message.data.id,
                  data: {
                    result: 'success',
                  },
                });

                if (cleanupRef.current) {
                  cleanupRef.current();
                }
                break;
              }

              default:
                console.warn(`Unsupported command: ${command.command}`);
                port.postMessage({
                  type: 'result',
                  id: message.data.id,
                  data: {
                    result: 'error',
                    error: {
                      code: 'unsupportedCommand',
                      message: command.command,
                    },
                  },
                });
                break;
            }
            break;
          }

          default:
            console.log('Unknown message type:', message.data.type);
            break;
        }
      } catch (error) {
        console.error('Error processing port message:', error);
      }
    },
    [token, onFilesSelected, showToast],
  );

  // Initialization message handler - establishes MessagePort communication
  const initMessageHandler = useCallback(
    (event: MessageEvent) => {
      console.log('=== SharePoint picker init message received ===');
      console.log('Event source:', event.source);
      console.log('Event data:', event.data);
      console.log('Expected channelId:', channelIdRef.current);

      // Check if this message is from our iframe
      if (event.source && event.source === iframeRef.current?.contentWindow) {
        const message = event.data;

        if (message.type === 'initialize' && message.channelId === channelIdRef.current) {
          console.log('Establishing MessagePort communication');

          // Get the MessagePort from the event
          portRef.current = event.ports[0];

          if (portRef.current) {
            // Set up the port message listener
            portRef.current.addEventListener('message', portMessageHandler);
            portRef.current.start();

            // Send activate message to start the picker
            portRef.current.postMessage({
              type: 'activate',
            });

            console.log('MessagePort established and activated');
          } else {
            console.error('No MessagePort found in initialize event');
          }
        }
      }
    },
    [portMessageHandler],
  );

  const openSharePointPicker = async () => {
    if (!token) {
      showToast({
        message: 'Unable to access SharePoint. Please ensure you are logged in with Microsoft.',
        status: 'error',
      });
      return;
    }

    try {
      setIsPickerOpen(true);

      // Generate unique channel ID for this picker instance
      const channelId = generateChannelId();
      channelIdRef.current = channelId;

      console.log('=== SharePoint File Picker v8 (MessagePort) ===');
      console.log('Token available:', {
        hasToken: !!token.access_token,
        tokenType: token.token_type,
        expiresIn: token.expires_in,
        scopes: token.scope,
      });
      console.log('Channel ID:', channelId);

      // Microsoft File Picker v8 iframe approach with MessagePort communication
      const pickerOptions: SPPickerConfig = {
        sdk: '8.0',
        entry: {
          sharePoint: {},
        },
        messaging: {
          origin: window.location.origin,
          channelId: channelId,
        },
        authentication: {
          enabled: false, // Host app handles authentication
        },
        typesAndSources: {
          mode: 'files',
          pivots: {
            oneDrive: true,
            recent: true,
            shared: true,
            sharedLibraries: true,
            myOrganization: true,
            site: true,
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
      iframeRef.current = iframe;

      // Create overlay
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
      overlay.style.zIndex = '9999';
      overlayRef.current = overlay;

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
        const url = sharePointBaseUrl + `/_layouts/15/FilePicker.aspx?${queryString}`;

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

      const cleanup = () => {
        // Remove initialization message listener
        window.removeEventListener('message', initMessageHandler);

        // Close MessagePort if it exists
        if (portRef.current) {
          portRef.current.removeEventListener('message', portMessageHandler);
          portRef.current.close();
          portRef.current = null;
        }

        // Remove DOM elements
        if (overlayRef.current && overlayRef.current.parentNode) {
          document.body.removeChild(overlayRef.current);
        }

        // Reset refs
        overlayRef.current = null;
        iframeRef.current = null;
        channelIdRef.current = '';
        cleanupRef.current = null;
        setIsPickerOpen(false);
      };

      cleanupRef.current = cleanup;

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
      overlayRef.current?.appendChild(closeButton);

      // Add initialization message listener to establish MessagePort communication
      window.addEventListener('message', initMessageHandler);
    } catch (error) {
      console.error('SharePoint file picker error:', error);
      showToast({
        message: 'Failed to open SharePoint file picker.',
        status: 'error',
      });
      setIsPickerOpen(false);
    }
  };

  // Check if SharePoint is enabled and user is authenticated
  const isAvailable = startupConfig?.sharePointFilePickerEnabled && isEntraIdUser && !tokenError;

  return {
    openSharePointPicker: isAvailable ? openSharePointPicker : () => {},
    isPickerOpen,
    isLoading: isTokenLoading,
    error: tokenError ? 'Failed to authenticate with SharePoint' : null,
  };
}
