import {
  QueryKeys,
  dataService,
  EModelEndpoint,
  defaultOrderQuery,
  request,
} from 'librechat-data-provider';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  QueryObserverResult,
  UseQueryOptions,
  UseMutationResult,
} from '@tanstack/react-query';
import type t from 'librechat-data-provider';

/**
 * AGENTS
 */

/**
 * Hook for getting all available tools for A
 */
export const useAvailableAgentToolsQuery = (): QueryObserverResult<t.TPlugin[]> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);

  const enabled = !!endpointsConfig?.[EModelEndpoint.agents];
  return useQuery<t.TPlugin[]>([QueryKeys.tools], () => dataService.getAvailableAgentTools(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    enabled,
  });
};

/**
 * Hook for listing all Agents, with optional parameters provided for pagination and sorting
 */
export const useListAgentsQuery = <TData = t.AgentListResponse>(
  params: t.AgentListParams = defaultOrderQuery,
  config?: UseQueryOptions<t.AgentListResponse, unknown, TData>,
): QueryObserverResult<TData> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);

  const enabled = !!endpointsConfig?.[EModelEndpoint.agents];
  return useQuery<t.AgentListResponse, unknown, TData>(
    [QueryKeys.agents, params],
    () => dataService.listAgents(params),
    {
      // Example selector to sort them by created_at
      // select: (res) => {
      //   return res.data.sort((a, b) => a.created_at - b.created_at);
      // },
      staleTime: 1000 * 5,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled && enabled : enabled,
    },
  );
};

/**
 * Hook for retrieving details about a single agent
 */
export const useGetAgentByIdQuery = (
  agent_id: string,
  config?: UseQueryOptions<t.Agent>,
): QueryObserverResult<t.Agent> => {
  return useQuery<t.Agent>(
    [QueryKeys.agent, agent_id],
    () =>
      dataService.getAgentById({
        agent_id,
      }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
    },
  );
};

export const getAgentSourceDownload = async ({
  fileId,
  messageId,
  conversationId,
}: {
  fileId: string;
  messageId: string;
  conversationId: string;
}): Promise<{ downloadUrl: string; fileName?: string; mimeType?: string }> => {
  return request.post('/api/files/agent-source-url', {
    fileId,
    messageId,
    conversationId,
  });
};

export const useAgentSourceDownload = (): UseMutationResult<
  { downloadUrl: string; fileName?: string; mimeType?: string },
  Error,
  { fileId: string; messageId: string; conversationId: string }
> => {
  return useMutation((params: { fileId: string; messageId: string; conversationId: string }) =>
    getAgentSourceDownload(params),
  );
};
