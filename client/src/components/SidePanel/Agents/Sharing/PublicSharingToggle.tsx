/**
 * PublicSharingToggle Component for Agent Sharing
 *
 * Handles the toggle for making an agent available to all LibreChat users
 * with configurable access level (viewer/editor).
 */

import React from 'react';
import { Globe, Eye, Edit } from 'lucide-react';
import { ACCESS_ROLE_IDS } from 'librechat-data-provider';
import { Switch } from '~/components/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/Select';
import { MOCK_ACCESS_ROLES } from './mockData';

interface PublicSharingToggleProps {
  isPublic: boolean;
  publicRole: string;
  onPublicToggle: (isPublic: boolean) => void;
  onPublicRoleChange: (role: string) => void;
  className?: string;
}

export default function PublicSharingToggle({
  isPublic,
  publicRole,
  onPublicToggle,
  onPublicRoleChange,
  className = '',
}: PublicSharingToggleProps) {
  const getRoleIcon = (roleId: string) => {
    // Reason: Consistent role visualization across all sharing components
    return roleId.includes('editor') ? <Edit className="h-3 w-3" /> : <Eye className="h-3 w-3" />;
  };

  return (
    <div className={`space-y-3 border-t pt-4 ${className}`}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Globe className="h-4 w-4" />
            Share with everyone
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Make this agent available to all LibreChat users
          </p>
        </div>
        <Switch
          checked={isPublic}
          onCheckedChange={onPublicToggle}
          aria-label="Share with everyone"
        />
      </div>

      {isPublic && (
        <div>
          <label className="mb-2 block text-sm font-medium">Public access level</label>
          <Select value={publicRole} onValueChange={onPublicRoleChange}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MOCK_ACCESS_ROLES.map((role) => (
                <SelectItem key={role.accessRoleId} value={role.accessRoleId}>
                  <div className="flex items-center gap-2">
                    {getRoleIcon(role.accessRoleId)}
                    <div>
                      <div>{role.name}</div>
                      <div className="text-xs text-muted-foreground">{role.description}</div>
                    </div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
