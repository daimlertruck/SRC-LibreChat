import { useAuthContext } from '~/hooks/AuthContext';
import { useGraphTokenQuery, useGetStartupConfig } from '~/data-provider';

interface UseSharePointTokenProps {
  enabled?: boolean;
}

interface UseSharePointTokenReturn {
  token: any;
  isLoading: boolean;
  error: any;
  refetch: () => Promise<any>;
}

export default function useSharePointToken({
  enabled = true,
}: UseSharePointTokenProps): UseSharePointTokenReturn {
  const { user } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();

  const sharePointBaseUrl = startupConfig?.sharePointBaseUrl;
  const sharePointPickerSharePointScope = startupConfig?.sharePointPickerSharePointScope;

  const isEntraIdUser = user?.provider === 'openid';
  const {
    data: token,
    isLoading,
    error,
    refetch,
  } = useGraphTokenQuery({
    scopes: sharePointPickerSharePointScope,
    enabled: enabled && isEntraIdUser && !!sharePointBaseUrl,
  });

  return {
    token,
    isLoading,
    error,
    refetch,
  };
}
