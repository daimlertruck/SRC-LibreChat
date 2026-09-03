import '@testing-library/jest-dom/extend-expect';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import StatisticsToggle from './Toggle';

let mockStatisticsAvailable = true;
jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ agentsConfig: { statistics: mockStatisticsAvailable } }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

function Value() {
  return (
    <span data-testid="value">{String(useWatch<AgentForm>({ name: 'statistics_enabled' }))}</span>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const methods = useForm<AgentForm>({ defaultValues: { statistics_enabled: false } });
  return (
    <FormProvider {...methods}>
      {children}
      <Value />
    </FormProvider>
  );
}

describe('StatisticsToggle', () => {
  beforeEach(() => {
    mockStatisticsAvailable = true;
  });

  it('is hidden when the deployment feature is disabled', () => {
    mockStatisticsAvailable = false;
    render(<StatisticsToggle />, { wrapper: Wrapper });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('updates the persisted form field', () => {
    render(<StatisticsToggle />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByTestId('value')).toHaveTextContent('true');
  });
});
