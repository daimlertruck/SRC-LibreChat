import React, { useState } from 'react';
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
  Dropdown,
} from '~/components/ui';
import { cn, removeFocusOutlines } from '~/utils';
import { useToastContext } from '~/Providers';
import { useLocalize } from '~/hooks';

import PeoplePicker from './PeoplePicker/PeoplePicker';
import PublicSharingToggle from './PublicSharingToggle';
import ManagePermissionsDialog from './ManagePermissionsDialog';
import { MOCK_ACCESS_ROLES } from './mockData';

export default function GrantAccessDialog({
  agent_id = '',
  agentName,
  onGrantAccess,
  existingShares = [],
  currentShares = [],
  isPublic: currentIsPublic = false,
  publicRole: currentPublicRole = ACCESS_ROLE_IDS.AGENT_VIEWER,
}: {
  agent_id?: string;
  agentName?: string;
  onGrantAccess?: (shares: TPrincipal[], isPublic: boolean, publicRole: string) => void;
  existingShares?: TPrincipal[];
  currentShares?: TPrincipal[];
  isPublic?: boolean;
  publicRole?: string;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  // State for new shares being added
  const [newShares, setNewShares] = useState<TPrincipal[]>([]);
  const [defaultPermission, setDefaultPermission] = useState<string>(ACCESS_ROLE_IDS.AGENT_VIEWER);
  const [isPublic, setIsPublic] = useState(false);
  const [publicRole, setPublicRole] = useState<string>(ACCESS_ROLE_IDS.AGENT_VIEWER);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    formState: { isValid },
  } = useForm({
    mode: 'onChange',
  });

  if (!agent_id) {
    return null;
  }

  const handleSelectPrincipal = (principal: TPrincipal) => {
    // Add the selected principal with the current default permission
    const principalWithRole = { ...principal, accessRoleId: defaultPermission };
    setNewShares([...newShares, principalWithRole]);
  };

  const handleRemoveShare = (id: string) => {
    setNewShares(newShares.filter((s) => s.id !== id));
  };

  const handleRoleChange = (id: string, newRole: string) => {
    setNewShares(newShares.map((s) => (s.id === id ? { ...s, accessRoleId: newRole } : s)));
  };

  const handleGrantAccess = async () => {
    if (newShares.length === 0 && !isPublic) {
      showToast({
        message: 'Please select at least one user/group or enable public sharing',
        status: 'warning',
      });
      return;
    }

    setIsSubmitting(true);

    try {
      // TODO: Replace with real API calls when backend is ready
      console.log('Granting agent access:', {
        agentId: agent_id,
        newShares,
        isPublic,
        publicRole,
      });

      // Call parent callback if provided
      if (onGrantAccess) {
        onGrantAccess(newShares, isPublic, publicRole);
      }

      showToast({
        message: `Access granted successfully to ${newShares.length} ${newShares.length === 1 ? 'person' : 'people'}${isPublic ? ' and made public' : ''}`,
        status: 'success',
      });

      // Reset form and close
      setNewShares([]);
      setDefaultPermission(ACCESS_ROLE_IDS.AGENT_VIEWER);
      setIsPublic(false);
      setPublicRole(ACCESS_ROLE_IDS.AGENT_VIEWER);
      setIsModalOpen(false);
    } catch (error) {
      showToast({
        message: 'Failed to grant access. Please try again.',
        status: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setNewShares([]);
    setDefaultPermission(ACCESS_ROLE_IDS.AGENT_VIEWER);
    setIsPublic(false);
    setPublicRole(ACCESS_ROLE_IDS.AGENT_VIEWER);
    setIsModalOpen(false);
  };

  // Combine existing shares with new shares for the people picker to filter
  const allExistingShares = [...existingShares, ...currentShares, ...newShares];

  // Calculate total share count for badge display
  const totalCurrentShares = currentShares.length + (currentIsPublic ? 1 : 0);

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
            <Dropdown
              value={defaultPermission}
              onChange={setDefaultPermission}
              options={MOCK_ACCESS_ROLES.map((role) => ({
                value: role.accessRoleId,
                label: role.name,
                icon: role.accessRoleId.includes('editor') ? (
                  <div className="h-2 w-2 rounded-full bg-green-500" />
                ) : (
                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                ),
              }))}
              sizeClasses="w-[180px]"
              testId="DefaultPermissionDropdown"
              className="z-50"
            />
          </div>

          {/* Public Sharing Toggle */}
          <PublicSharingToggle
            isPublic={isPublic}
            publicRole={publicRole}
            onPublicToggle={setIsPublic}
            onPublicRoleChange={setPublicRole}
          />

          {/* Action Buttons */}
          <div className="flex justify-between border-t pt-4">
            {/* Manage Permissions Button - Bottom Left */}
            <ManagePermissionsDialog
              agent_id={agent_id}
              agentName={agentName}
              currentShares={currentShares}
              isPublic={currentIsPublic}
              publicRole={currentPublicRole}
            />

            {/* Main Action Buttons - Bottom Right */}
            <div className="flex gap-3">
              <OGDialogClose asChild>
                <Button variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </OGDialogClose>
              <Button
                onClick={handleGrantAccess}
                disabled={isSubmitting || (newShares.length === 0 && !isPublic)}
                className="min-w-[120px]"
              >
                {isSubmitting ? (
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
