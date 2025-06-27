import { useAuthContext } from '~/hooks/AuthContext';
import { useGraphTokenQuery, useGetStartupConfig } from '~/data-provider';

interface UseSharePointTokenProps {
  enabled?: boolean;
  purpose: 'Pick' | 'Download';
}

interface UseSharePointTokenReturn {
  token: any;
  isLoading: boolean;
  error: any;
  refetch: () => Promise<any>;
}

export default function useSharePointToken({
  enabled = true,
  purpose, // 'Pick' or 'Download'
}: UseSharePointTokenProps): UseSharePointTokenReturn {
  const { user } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();

  const sharePointBaseUrl = startupConfig?.sharePointBaseUrl;
  const sharePointPickerGraphScope = startupConfig?.sharePointPickerGraphScope;
  const sharePointPickerSharePointScope = startupConfig?.sharePointPickerSharePointScope;

  // Check if user is authenticated via Entra ID (OpenID)
  const isEntraIdUser = user?.provider === 'openid';

  // Get Graph API token for SharePoint access with same scopes as picker
  const graphScopes =
    purpose === 'Pick' ? sharePointPickerSharePointScope : sharePointPickerGraphScope;

  const {
    data: token,
    isLoading,
    error,
    refetch,
  } = useGraphTokenQuery({
    scopes: graphScopes,
    enabled: enabled && isEntraIdUser && !!sharePointBaseUrl,
  });

  return {
    token,
    isLoading,
    error,
    refetch,
  };
}
