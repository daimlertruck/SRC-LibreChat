import React, { useState, useEffect } from 'react';
import { Share2Icon, Users, Loader, UserPlus, ChevronDown, Shield } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { ACCESS_ROLE_IDS } from 'librechat-data-provider';
import type { TPrincipal } from 'librechat-data-provider';
import {
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogClose,
  OGDialogContent,
  OGDialogTrigger,
} from '~/components/ui';
import { cn, removeFocusOutlines } from '~/utils';
import { useToastContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import {
  useGetResourcePermissionsQuery,
  useUpdateResourcePermissionsMutation,
} from 'librechat-data-provider/react-query';

import PeoplePicker from './PeoplePicker/PeoplePicker';
import PublicSharingToggle from './PublicSharingToggle';
import ManagePermissionsDialog from './ManagePermissionsDialog';
import AccessRolesPicker from './AccessRolesPicker';

export default function GrantAccessDialog({
  agentName,
  onGrantAccess,
  resourceType = 'agent',
  agentDbId,
}: {
  agentDbId?: string | null;
  agentName?: string;
  onGrantAccess?: (shares: TPrincipal[], isPublic: boolean, publicRole: string) => void;
  resourceType?: string;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  // Fetch current permissions from API
  const {
    data: permissionsData,
    isLoading: isLoadingPermissions,
    error: permissionsError,
  } = useGetResourcePermissionsQuery(resourceType, agentDbId!, {
    enabled: !!agentDbId,
  });

  // Update permissions mutation
  const updatePermissionsMutation = useUpdateResourcePermissionsMutation();

  // State for new shares being added
  const [newShares, setNewShares] = useState<TPrincipal[]>([]);
  const [defaultPermissionId, setDefaultPermissionId] = useState<string>(
    ACCESS_ROLE_IDS.AGENT_VIEWER,
  );
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Convert API response to TPrincipal format
  const currentShares: TPrincipal[] =
    permissionsData?.principals?.map((principal) => ({
      type: principal.type,
      id: principal.id,
      name: principal.name,
      email: principal.email,
      source: principal.source,
      avatar: principal.avatar,
      description: principal.description,
      accessRoleId: principal.accessRoleId,
    })) || [];

  const currentIsPublic = permissionsData?.public ?? false;
  const currentPublicRole = permissionsData?.publicAccessRoleId || ACCESS_ROLE_IDS.AGENT_VIEWER;

  // Form state - defaults
  const [isPublic, setIsPublic] = useState(false);
  const [publicRole, setPublicRole] = useState<string>(ACCESS_ROLE_IDS.AGENT_VIEWER);

  // Sync local state with server state when data loads or modal opens
  useEffect(() => {
    if (permissionsData && isModalOpen) {
      setIsPublic(currentIsPublic ?? false);
      setPublicRole(currentPublicRole);
    }
  }, [permissionsData, isModalOpen, currentIsPublic, currentPublicRole]);

  if (!agentDbId) {
    return null;
  }

  const handleGrantAccess = async () => {
    // if (newShares.length === 0 && !isPublic) {
    //   showToast({
    //     message: 'Please select at least one user/group or enable public sharing',
    //     status: 'warning',
    //   });
    //   return;
    // }

    try {
      // Assign the default permission level to all new shares
      const sharesToAdd = newShares.map((share) => ({
        ...share,
        accessRoleId: defaultPermissionId,
      }));

      // Prepare the updated shares (existing + new)
      const allShares = [...currentShares, ...sharesToAdd];

      // Determine final public settings

      await updatePermissionsMutation.mutateAsync({
        resourceType,
        resourceId: agentDbId,
        data: {
          updated: sharesToAdd, // Only send the new shares as updated
          removed: [],
          public: isPublic,
          publicAccessRoleId: isPublic ? publicRole : undefined,
        },
      });

      // Call parent callback if provided
      if (onGrantAccess) {
        onGrantAccess(allShares, isPublic, publicRole);
      }

      showToast({
        message: `Access granted successfully to ${newShares.length} ${newShares.length === 1 ? 'person' : 'people'}${isPublic ? ' and made public' : ''}`,
        status: 'success',
      });

      // Reset form and close
      setNewShares([]);
      setDefaultPermissionId(ACCESS_ROLE_IDS.AGENT_VIEWER);
      setIsPublic(false);
      setPublicRole(ACCESS_ROLE_IDS.AGENT_VIEWER);
      setIsModalOpen(false);
    } catch (error) {
      console.error('Error granting access:', error);
      showToast({
        message: 'Failed to grant access. Please try again.',
        status: 'error',
      });
    }
  };

  const handleCancel = () => {
    setNewShares([]);
    setDefaultPermissionId(ACCESS_ROLE_IDS.AGENT_VIEWER);
    setIsPublic(false);
    setPublicRole(ACCESS_ROLE_IDS.AGENT_VIEWER);
    setIsModalOpen(false);
  };

  // Combine existing shares with new shares for the people picker to filter
  const allExistingShares = [...currentShares, ...newShares];

  // Calculate total share count for badge display
  const totalCurrentShares = currentShares.length + (currentIsPublic ? 1 : 0);
  const submitButtonActive = newShares.length > 0 || isPublic !== currentIsPublic;
  return (
    <OGDialog open={isModalOpen} onOpenChange={setIsModalOpen} modal>
      <OGDialogTrigger asChild>
        <button
          className={cn(
            'btn btn-neutral border-token-border-light relative h-9 rounded-lg font-medium',
            removeFocusOutlines,
          )}
          aria-label={localize('com_ui_share_var', {
            0: agentName != null && agentName !== '' ? `"${agentName}"` : localize('com_ui_agent'),
          })}
          type="button"
        >
          <div className="flex items-center justify-center gap-2 text-blue-500">
            <Share2Icon className="icon-md h-4 w-4" />
            {/* Show share count indicator */}
            {totalCurrentShares > 0 && (
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-300">
                {totalCurrentShares}
              </span>
            )}
          </div>
        </button>
      </OGDialogTrigger>

      <OGDialogContent className="max-h-[90vh] w-11/12 overflow-y-auto md:max-w-3xl">
        <OGDialogTitle>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {localize('com_ui_share_var', {
              0:
                agentName != null && agentName !== '' ? `"${agentName}"` : localize('com_ui_agent'),
            })}
          </div>
        </OGDialogTitle>

        <div className="space-y-6 p-2">
          {/* People Picker Section */}
          <PeoplePicker
            onSelectionChange={setNewShares}
            placeholder="Search for people or groups by name or email"
          />

          {/* Default Permission Level */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-text-secondary" />
                <label className="text-sm font-medium text-text-primary">Permission Level</label>
              </div>
            </div>
            <AccessRolesPicker
              resourceType={resourceType}
              selectedRoleId={defaultPermissionId}
              onRoleChange={setDefaultPermissionId}
            />
          </div>
          <PublicSharingToggle
            isPublic={isPublic}
            publicRole={publicRole}
            onPublicToggle={setIsPublic}
            onPublicRoleChange={setPublicRole}
            resourceType={resourceType}
          />
          <div className="flex justify-between border-t pt-4">
            <ManagePermissionsDialog
              agentDbId={agentDbId}
              agentName={agentName}
              resourceType={resourceType}
            />
            <div className="flex gap-3">
              <OGDialogClose asChild>
                <Button variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </OGDialogClose>
              <Button
                onClick={handleGrantAccess}
                disabled={updatePermissionsMutation.isLoading || !submitButtonActive}
                className="min-w-[120px]"
              >
                {updatePermissionsMutation.isLoading ? (
                  <div className="flex items-center gap-2">
                    <Loader className="h-4 w-4 animate-spin" />
                    Granting...
                  </div>
                ) : (
                  'Grant Access'
                )}
              </Button>
            </div>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
