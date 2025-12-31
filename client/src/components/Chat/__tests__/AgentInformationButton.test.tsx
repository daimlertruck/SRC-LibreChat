import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentInformationButton } from '../AgentInformationButton';

const mockShowToast = jest.fn();
let mockConversation: any = { agent_id: 'agent-1' };
const mockUseGetAgentByIdQuery = jest.fn();
const mockUpdateMutation = jest.fn();

jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({ render }: any) => render,
  useToastContext: () => ({ showToast: mockShowToast }),
  GearIcon: () => <svg data-testid="gear-icon" />,
  InformationIcon: () => <svg data-testid="info-icon" />,
  useMediaQuery: () => false,
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: (...args: any[]) => mockUseGetAgentByIdQuery(...args),
  useUpdateAgentMutation: (options?: any) => ({
    mutate: mockUpdateMutation.mockImplementation((vars) => {
      options?.onSuccess?.({ id: vars.agent_id, ...vars.data }, vars, undefined);
    }),
    isLoading: false,
  }),
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('AgentInformationButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversation = { agent_id: 'agent-1' };
    mockUseGetAgentByIdQuery.mockReset();
  });

  it('does not render when no agent is active', () => {
    mockConversation = { agent_id: '' };
    mockUseGetAgentByIdQuery.mockReturnValue({ data: null });

    const Wrapper = createWrapper();
    const { container } = render(<AgentInformationButton />, { wrapper: Wrapper });

    expect(container.firstChild).toBeNull();
  });

  it('prefills agent data when opened', async () => {
    mockUseGetAgentByIdQuery.mockReturnValue({
      data: { id: 'agent-1', name: 'Agent One', description: 'First agent' },
    });

    const Wrapper = createWrapper();
    render(<AgentInformationButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Agent Settings' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Agent Name')).toHaveValue('Agent One');
      expect(screen.getByLabelText('Agent Description')).toHaveValue('First agent');
    });
  });

  it('calls update mutation with edited values and shows toast on success', async () => {
    mockUseGetAgentByIdQuery.mockReturnValue({
      data: { id: 'agent-1', name: 'Agent One', description: 'First agent' },
    });

    const Wrapper = createWrapper();
    render(<AgentInformationButton />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Agent Settings' }));

    const nameInput = await screen.findByLabelText('Agent Name');
    const descInput = screen.getByLabelText('Agent Description');

    fireEvent.change(nameInput, { target: { value: 'Updated Name' } });
    fireEvent.change(descInput, { target: { value: 'Updated Description' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(mockUpdateMutation).toHaveBeenCalledWith({
        agent_id: 'agent-1',
        data: { name: 'Updated Name', description: 'Updated Description' },
      });
      expect(mockShowToast).toHaveBeenCalledWith({ message: 'Agent settings saved' });
    });
  });
});
