/**
 * ShareAgentEnhanced Component - Enhanced Agent Sharing with Granular Permissions
 * 
 * Provides comprehensive sharing functionality including user/group search,
 * role assignment, and public sharing options.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Share2Icon, Users, Loader } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { ACCESS_ROLE_IDS, Permissions } from 'librechat-data-provider';
import type { 
  TStartupConfig, 
  TPrincipal,
  TSelectedPrincipal,
} from 'librechat-data-provider';
import {
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogClose,
  OGDialogContent,
  OGDialogTrigger,
} from '~/components/ui';
import { useUpdateAgentMutation, useGetStartupConfig } from '~/data-provider';
import { cn, removeFocusOutlines } from '~/utils';
import { useToastContext } from '~/Providers';
import { useLocalize } from '~/hooks';

// Import modular components
import PeoplePicker from './PeoplePicker';
import SelectedPrincipalsList from './SelectedPrincipalsList';
import PublicSharingToggle from './PublicSharingToggle';
import { MOCK_CURRENT_SHARES } from './mockData';

type FormValues = {
  [Permissions.SHARED_GLOBAL]: boolean;
  [Permissions.UPDATE]: boolean;
};

export default function ShareAgentEnhanced({
  agent_id = '',
  agentName,
  projectIds = [],
  isCollaborative = false,
}: {
  agent_id?: string;
  agentName?: string;
  projectIds?: string[];
  isCollaborative?: boolean;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: startupConfig = {} as TStartupConfig } = useGetStartupConfig();
  const { instanceProjectId } = startupConfig;
  
  // Enhanced state for granular permissions
  const [selectedShares, setSelectedShares] = useState<TSelectedPrincipal[]>(MOCK_CURRENT_SHARES);
  const [isPublic, setIsPublic] = useState(false);
  const [publicRole, setPublicRole] = useState<string>(ACCESS_ROLE_IDS.AGENT_VIEWER);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const agentIsGlobal = useMemo(
    () => !!projectIds.includes(instanceProjectId),
    [projectIds, instanceProjectId],
  );

  const {
    formState: { isSubmitting },
  } = useForm<FormValues>({
    mode: 'onChange',
    defaultValues: {
      [Permissions.SHARED_GLOBAL]: agentIsGlobal,
      [Permissions.UPDATE]: isCollaborative,
    },
  });

  // Sync public state with legacy global sharing
  useEffect(() => {
    setIsPublic(agentIsGlobal);
  }, [agentIsGlobal]);

  const updateAgent = useUpdateAgentMutation({
    onSuccess: (data) => {
      showToast({
        message: `${localize('com_assistants_update_success')} ${
          data.name ?? localize('com_ui_agent')
        }`,
        status: 'success',
      });
    },
    onError: (err) => {
      const error = err as Error;
      showToast({
        message: `${localize('com_agents_update_error')}${
          error.message ? ` ${localize('com_ui_error')}: ${error.message}` : ''
        }`,
        status: 'error',
      });
    },
  });

  if (!agent_id || !instanceProjectId) {
    return null;
  }

  const handleSelectPrincipal = (principal: TPrincipal) => {
    // Reason: Default new shares to viewer role for security
    const newShare: TSelectedPrincipal = {
      ...principal,
      accessRoleId: ACCESS_ROLE_IDS.AGENT_VIEWER,
      tempId: `temp-${Date.now()}`,
    };
    
    setSelectedShares([...selectedShares, newShare]);
  };

  const handleRemoveShare = (tempId: string) => {
    setSelectedShares(selectedShares.filter(s => s.tempId !== tempId));
  };

  const handleRoleChange = (tempId: string, newRole: string) => {
    setSelectedShares(selectedShares.map(s => 
      s.tempId === tempId ? { ...s, accessRoleId: newRole } : s
    ));
  };

  const handleSave = () => {
    // TODO: Replace with real API calls when backend is ready
    console.log('Saving agent permissions:', {
      agentId: agent_id,
      shares: selectedShares,
      isPublic,
      publicRole,
    });
    
    showToast({
      message: 'Agent permissions updated successfully!',
      status: 'success',
    });
    
    setIsModalOpen(false);
  };

  // Calculate total share count for badge display
  const shareCount = selectedShares.length + (isPublic ? 1 : 0);

  return (
    <OGDialog open={isModalOpen} onOpenChange={setIsModalOpen}>
      <OGDialogTrigger asChild>
        <button
          className={cn(
            'btn btn-neutral border-token-border-light relative h-9 rounded-lg font-medium',
            removeFocusOutlines,
          )}
          aria-label={localize(
            'com_ui_share_var',
            { 0: agentName != null && agentName !== '' ? `"${agentName}"` : localize('com_ui_agent') },
          )}
          type="button"
        >
          <div className="flex items-center justify-center gap-2 text-blue-500">
            <Share2Icon className="icon-md h-4 w-4" />
            {/* Show share count indicator */}
            {shareCount > 0 && (
              <span className="bg-blue-100 text-blue-800 text-xs font-medium px-1.5 py-0.5 rounded-full dark:bg-blue-900 dark:text-blue-300">
                {shareCount}
              </span>
            )}
          </div>
        </button>
      </OGDialogTrigger>
      
      <OGDialogContent className="w-11/12 md:max-w-3xl max-h-[90vh] overflow-y-auto">
        <OGDialogTitle>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {localize(
              'com_ui_share_var',
              { 0: agentName != null && agentName !== '' ? `"${agentName}"` : localize('com_ui_agent') },
            )}
          </div>
        </OGDialogTitle>
        
        <div className="space-y-6 p-2">
          {/* People Picker Section */}
          <PeoplePicker
            selectedShares={selectedShares}
            onSelectPrincipal={handleSelectPrincipal}
          />

          {/* Selected Principals List */}
          <SelectedPrincipalsList
            selectedShares={selectedShares}
            onRemoveShare={handleRemoveShare}
            onRoleChange={handleRoleChange}
          />

          {/* Public Sharing Toggle */}
          <PublicSharingToggle
            isPublic={isPublic}
            publicRole={publicRole}
            onPublicToggle={setIsPublic}
            onPublicRoleChange={setPublicRole}
          />

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <OGDialogClose asChild>
              <Button variant="outline">
                Cancel
              </Button>
            </OGDialogClose>
            <Button 
              onClick={handleSave}
              disabled={isSubmitting}
              className="min-w-[80px]"
            >
              {isSubmitting ? (
                <div className="flex items-center gap-2">
                  <Loader className="h-4 w-4 animate-spin" />
                  Saving...
                </div>
              ) : (
                'Save Changes'
              )}
            </Button>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}