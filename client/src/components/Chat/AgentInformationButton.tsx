import React, { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { TooltipAnchor, useToastContext, GearIcon, useMediaQuery } from '@librechat/client';
import { useChatContext } from '~/Providers';
import { cn } from '~/utils';
import { useGetAgentByIdQuery, useUpdateAgentMutation } from '~/data-provider';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { InformationIcon } from '@librechat/client';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-2xl translate-x-[-50%] translate-y-[-50%] gap-4 border border-gray-200 bg-white p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] dark:border-gray-700 dark:bg-gray-800 sm:rounded-lg',
        className,
      )}
      {...props}
    />
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function GeneralTab({
  agentName,
  setAgentName,
  agentDescription,
  setAgentDescription,
}: {
  agentName: string;
  setAgentName: (value: string) => void;
  agentDescription: string;
  setAgentDescription: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="agent-name" className="block text-sm font-medium text-text-primary">
          Agent Name
        </label>
        <input
          id="agent-name"
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="Enter agent name"
          className="mt-1 w-full rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-text-primary placeholder-text-secondary focus:border-border-heavy focus:outline-none focus:ring-2 focus:ring-border-xheavy"
        />
      </div>

      <div>
        <label htmlFor="agent-description" className="block text-sm font-medium text-text-primary">
          Agent Description
        </label>
        <textarea
          id="agent-description"
          value={agentDescription}
          onChange={(e) => setAgentDescription(e.target.value)}
          placeholder="Enter agent description"
          rows={4}
          className="mt-1 w-full rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-text-primary placeholder-text-secondary focus:border-border-heavy focus:outline-none focus:ring-2 focus:ring-border-xheavy"
        />
      </div>
    </div>
  );
}

export function AgentInformationButton() {
  const isSmallScreen = useMediaQuery('(max-width: 767px)');
  const { conversation } = useChatContext();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('general');
  const [agentName, setAgentName] = useState('');
  const [agentDescription, setAgentDescription] = useState('');

  const isAgentActive = conversation?.agent_id && conversation.agent_id !== '';

  const { data: agentData } = useGetAgentByIdQuery(conversation?.agent_id);
  const { showToast } = useToastContext();

  const updateAgentMutation = useUpdateAgentMutation({
    onSuccess: () => {
      showToast({ message: 'Agent settings saved' });
      setIsOpen(false);
    },
    onError: () => {
      showToast({ message: 'Failed to save agent settings' });
    },
  });

  useEffect(() => {
    if (isOpen && agentData) {
      setAgentName(agentData.name ?? '');
      setAgentDescription(agentData.description ?? '');
    }
  }, [isOpen, agentData?.name, agentData?.description]);

  const handleSave = () => {
    if (!conversation?.agent_id) return;
    updateAgentMutation.mutate({
      agent_id: conversation.agent_id,
      data: { name: agentName, description: agentDescription },
    });
  };

  if (!isAgentActive) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <TooltipAnchor
        description="Agent Settings"
        render={
          <DialogTrigger asChild>
            <button
              aria-label="Agent Settings"
              className={cn(
                'inline-flex size-10 flex-shrink-0 items-center justify-center rounded-xl border border-border-light text-text-primary transition-all ease-in-out hover:bg-surface-tertiary',
                'bg-transparent shadow-sm hover:bg-surface-hover hover:shadow-md',
                'active:shadow-inner',
              )}
            >
              <InformationIcon />
            </button>
          </DialogTrigger>
        }
      />

      <DialogContent className="min-h-[500px] w-full max-w-2xl overflow-hidden rounded-xl bg-background pb-6 shadow-2xl md:min-h-[400px] md:w-[680px]">
        <div className="mb-1 flex items-center justify-between border-b border-border-medium pb-5">
          <h2 className="text-lg font-medium leading-6 text-text-primary">Agent Settings</h2>
          <button
            type="button"
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-border-xheavy focus:ring-offset-2 disabled:pointer-events-none"
            onClick={() => setIsOpen(false)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5 text-text-primary"
            >
              <line x1="18" x2="6" y1="6" y2="18"></line>
              <line x1="6" x2="18" y1="6" y2="18"></line>
            </svg>
            <span className="sr-only">Close</span>
          </button>
        </div>

        <div className="max-h-[400px] overflow-visible md:min-h-[300px]">
          <Tabs.Root
            value={activeTab}
            onValueChange={setActiveTab}
            className="flex flex-col gap-10 md:flex-row"
            orientation="vertical"
          >
            <Tabs.List
              aria-label="Agent Settings"
              className={cn(
                'min-w-auto max-w-auto relative flex flex-shrink-0 flex-col flex-nowrap sm:max-w-none',
                isSmallScreen
                  ? 'flex-row rounded-xl bg-surface-secondary p-1'
                  : 'sticky top-0 h-full p-1',
              )}
            >
              <Tabs.Trigger
                value="general"
                className={cn(
                  'group relative z-10 flex items-center justify-start gap-2 rounded-xl px-2 py-1.5 transition-all duration-200 ease-in-out',
                  isSmallScreen
                    ? 'flex-1 justify-center text-nowrap p-1 px-3 text-sm text-text-secondary radix-state-active:bg-surface-hover radix-state-active:text-text-primary'
                    : 'bg-transparent text-text-secondary radix-state-active:bg-surface-tertiary radix-state-active:text-text-primary',
                )}
              >
                <GearIcon />
                General
              </Tabs.Trigger>
            </Tabs.List>

            <div className="overflow-auto sm:w-full sm:max-w-none md:pr-0.5 md:pt-0.5">
              <Tabs.Content value="general" tabIndex={-1}>
                <GeneralTab
                  agentName={agentName}
                  setAgentName={setAgentName}
                  agentDescription={agentDescription}
                  setAgentDescription={setAgentDescription}
                />
              </Tabs.Content>
            </div>
          </Tabs.Root>
        </div>

        <div className="flex justify-end gap-2 border-t border-border-medium pt-4">
          <button
            onClick={() => setIsOpen(false)}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border-medium bg-surface-primary px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={updateAgentMutation.isLoading || !agentName.trim()}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save Changes
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
