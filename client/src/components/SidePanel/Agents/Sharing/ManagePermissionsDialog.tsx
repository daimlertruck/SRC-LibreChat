/**
 * ManagePermissionsDialog Component - Manage Current Agent Shares
 *
 * Focused component for viewing and managing existing permissions for shared agents.
 * This dialog handles the permission management flow.
 */

import React, { useState, useEffect } from 'react';
import { Settings, Users, Loader, UserCheck, Trash2, Shield } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { ACCESS_ROLE_IDS } from 'librechat-data-provider';
import type { TSelectedPrincipal } from 'librechat-data-provider';
import {
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogClose,
  OGDialogContent,
  OGDialogTrigger,
  Badge,
} from '~/components/ui';
import { cn, removeFocusOutlines } from '~/utils';
import { useToastContext } from '~/Providers';
import { useLocalize } from '~/hooks';

// Import modular components
import SelectedPrincipalsList from '../SelectedPrincipalsList';
import PublicSharingToggle from './PublicSharingToggle';
import { MOCK_CURRENT_SHARES } from '../mockData';

export default function ManagePermissionsDialog({
  agent_id = '',
  agentName,
  currentShares = MOCK_CURRENT_SHARES,
  isPublic = false,
  publicRole = ACCESS_ROLE_IDS.AGENT_VIEWER,
  onUpdatePermissions,
}: {
  agent_id?: string;
  agentName?: string;
  currentShares?: TSelectedPrincipal[];
  isPublic?: boolean;
  publicRole?: string;
  onUpdatePermissions?: (shares: TSelectedPrincipal[], isPublic: boolean, publicRole: string) => void;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  // State for managing current permissions
  const [managedShares, setManagedShares] = useState<TSelectedPrincipal[]>(currentShares);
  const [managedIsPublic, setManagedIsPublic] = useState(isPublic);
  const [managedPublicRole, setManagedPublicRole] = useState<string>(publicRole);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const {
    formState: { isValid },
  } = useForm({
    mode: 'onChange',
  });

  // Update internal state when props change
  useEffect(() => {
    setManagedShares(currentShares);
    setManagedIsPublic(isPublic);
    setManagedPublicRole(publicRole);
    setHasChanges(false);
  }, [currentShares, isPublic, publicRole, isModalOpen]);

  // Track changes to enable/disable save button
  useEffect(() => {
    const sharesChanged = JSON.stringify(managedShares) !== JSON.stringify(currentShares);
    const publicChanged = managedIsPublic !== isPublic;
    const publicRoleChanged = managedPublicRole !== publicRole;
    
    setHasChanges(sharesChanged || publicChanged || publicRoleChanged);
  }, [managedShares, managedIsPublic, managedPublicRole, currentShares, isPublic, publicRole]);

  if (!agent_id) {
    return null;
  }

  const handleRemoveShare = (tempId: string) => {
    setManagedShares(managedShares.filter((s) => s.tempId !== tempId));
  };

  const handleRoleChange = (tempId: string, newRole: string) => {
    setManagedShares(
      managedShares.map((s) => (s.tempId === tempId ? { ...s, accessRoleId: newRole } : s)),
    );
  };

  const handleSaveChanges = async () => {
    setIsSubmitting(true);
    
    try {
      // TODO: Replace with real API calls when backend is ready
      console.log('Updating agent permissions:', {
        agentId: agent_id,
        updatedShares: managedShares,
        isPublic: managedIsPublic,
        publicRole: managedPublicRole,
      });

      // Call parent callback if provided
      if (onUpdatePermissions) {
        onUpdatePermissions(managedShares, managedIsPublic, managedPublicRole);
      }

      showToast({
        message: 'Permissions updated successfully',
        status: 'success',
      });

      setIsModalOpen(false);
    } catch (error) {
      showToast({
        message: 'Failed to update permissions. Please try again.',
        status: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    // Reset to original values
    setManagedShares(currentShares);
    setManagedIsPublic(isPublic);
    setManagedPublicRole(publicRole);
    setIsModalOpen(false);
  };

  const handleRevokeAll = () => {
    if (window.confirm('Are you sure you want to revoke access for all users and groups? This action cannot be undone.')) {
      setManagedShares([]);
      setManagedIsPublic(false);
    }
  };

  // Calculate total share count for badge display
  const totalShares = managedShares.length + (managedIsPublic ? 1 : 0);
  const originalTotalShares = currentShares.length + (isPublic ? 1 : 0);

  return (
    <OGDialog open={isModalOpen} onOpenChange={setIsModalOpen}>
      <OGDialogTrigger asChild>
        <button
          className={cn(
            'btn btn-neutral border-token-border-light relative h-9 rounded-lg font-medium',
            removeFocusOutlines,
          )}
          aria-label={`Manage permissions for ${agentName != null && agentName !== '' ? `"${agentName}"` : 'agent'}`}
          type="button"
        >
          <div className="flex items-center justify-center gap-2 text-blue-500">
            <Settings className="icon-md h-4 w-4" />
            <span className="hidden sm:inline">Manage</span>
            {/* Show share count indicator */}
            {originalTotalShares > 0 && (
              <Badge variant="secondary" className="text-xs">
                {originalTotalShares}
              </Badge>
            )}
          </div>
        </button>
      </OGDialogTrigger>

      <OGDialogContent className="max-h-[90vh] w-11/12 overflow-y-auto md:max-w-3xl">
        <OGDialogTitle>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-blue-500" />
            Manage Permissions for{' '}
            {agentName != null && agentName !== '' ? `"${agentName}"` : 'Agent'}
          </div>
        </OGDialogTitle>

        <div className="space-y-6 p-2">
          {/* Current Shares Overview */}
          <div className="rounded-lg bg-surface-tertiary p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-text-primary">Current Access</h3>
                <p className="text-xs text-text-secondary">
                  {totalShares === 0 ? 'No users or groups have access' : 
                   `Shared with ${managedShares.length} ${managedShares.length === 1 ? 'person' : 'people'}${managedIsPublic ? ' and public' : ''}`}
                </p>
              </div>
              {managedShares.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRevokeAll}
                  className="text-red-600 hover:text-red-700"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Revoke All
                </Button>
              )}
            </div>
          </div>

          {/* User/Group Permissions List */}
          {managedShares.length > 0 ? (
            <div>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-text-primary">
                <UserCheck className="h-4 w-4" />
                User & Group Permissions ({managedShares.length})
              </h3>
              <SelectedPrincipalsList
                selectedShares={managedShares}
                onRemoveShare={handleRemoveShare}
                onRoleChange={handleRoleChange}
                showRemoveButton={true}
              />
            </div>
          ) : (
            <div className="rounded-lg border-2 border-dashed border-border-light p-8 text-center">
              <Users className="mx-auto h-8 w-8 text-text-secondary" />
              <p className="mt-2 text-sm text-text-secondary">
                No individual users or groups have access to this agent
              </p>
            </div>
          )}

          {/* Public Sharing Toggle */}
          <div>
            <h3 className="mb-3 text-sm font-medium text-text-primary">Public Access</h3>
            <PublicSharingToggle
              isPublic={managedIsPublic}
              publicRole={managedPublicRole}
              onPublicToggle={setManagedIsPublic}
              onPublicRoleChange={setManagedPublicRole}
            />
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 border-t pt-4">
            <OGDialogClose asChild>
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
            </OGDialogClose>
            <Button 
              onClick={handleSaveChanges} 
              disabled={isSubmitting || !hasChanges} 
              className="min-w-[120px]"
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

          {/* Changes indicator */}
          {hasChanges && (
            <div className="text-xs text-orange-600 dark:text-orange-400">
              * You have unsaved changes
            </div>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}