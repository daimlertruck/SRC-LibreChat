import { useRef, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import { useQuery } from '@tanstack/react-query';
import { useAuthContext } from '~/hooks/AuthContext';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useToastContext } from '~/Providers';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { SPPickerConfig } from '../../components/SidePanel/Agents/config';
import store from '~/store';

interface UseSharePointPickerProps {
  containerNode: HTMLDivElement | null;
  onFilesSelected?: (files: any[]) => void;
  onClose?: () => void;
  disabled?: boolean;
}

interface UseSharePointPickerReturn {
  openSharePointPicker: () => void;
  closeSharePointPicker: () => void;
  error: string | null;
  cleanup: () => void;
  isTokenLoading: boolean;
}

export default function useSharePointPicker({
  containerNode,
  onFilesSelected,
  onClose,
  disabled = false,
}: UseSharePointPickerProps): UseSharePointPickerReturn {
  const [langcode] = useRecoilState(store.lang);
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
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
                console.log('Command details:', command); // Add this line
                console.log('Token available:', !!token?.access_token); // Add this line
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
                onClose?.();
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
    [token, onFilesSelected, showToast, onClose],
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

    if (!containerNode) {
      console.error('No container ref provided for SharePoint picker');
      return;
    }

    try {
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
        title: localize('com_files_sharepoint_picker_title'),
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

      // Create iframe and inject into container
      const iframe = document.createElement('iframe');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.background = '#F5F5F5';
      iframe.style.border = 'none';
      iframe.title = 'SharePoint File Picker';
      iframe.setAttribute(
        'sandbox',
        'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
      );
      iframeRef.current = iframe;

      // Clear container and add iframe
      containerNode.innerHTML = '';
      containerNode.appendChild(iframe);

      // Add initialization message listener
      window.addEventListener('message', initMessageHandler);

      // Set iframe src to about:blank and wait for load
      iframe.src = 'about:blank';
      iframe.onload = () => {
        const win = iframe.contentWindow;
        if (!win) return;

        // Construct query string following Microsoft docs
        const queryString = new URLSearchParams({
          filePicker: JSON.stringify(pickerOptions),
          locale: langcode || 'en-US',
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
    } catch (error) {
      console.error('SharePoint file picker error:', error);
      showToast({
        message: 'Failed to open SharePoint file picker.',
        status: 'error',
      });
    }
  };
  const cleanup = useCallback(() => {
    // Remove message listener
    window.removeEventListener('message', initMessageHandler);

    // Close MessagePort if it exists
    if (portRef.current) {
      portRef.current.removeEventListener('message', portMessageHandler);
      portRef.current.close();
      portRef.current = null;
    }

    // Clear container
    if (containerNode) {
      containerNode.innerHTML = '';
    }
    console.log('SharePoint picker cleanup completed');
  }, [containerNode, initMessageHandler, portMessageHandler]);

  const handleDialogClose = useCallback(() => {
    // Remove message listener
    cleanup();
  }, [cleanup]);

  // Check if SharePoint is enabled and user is authenticated
  const isAvailable = startupConfig?.sharePointFilePickerEnabled && isEntraIdUser && !tokenError;

  return {
    openSharePointPicker: isAvailable ? openSharePointPicker : () => {},
    closeSharePointPicker: handleDialogClose,
    error: tokenError ? 'Failed to authenticate with SharePoint' : null,
    cleanup,
    isTokenLoading,
  };
}
