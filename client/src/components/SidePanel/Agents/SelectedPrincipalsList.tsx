/**
 * SelectedPrincipalsList Component for Agent Sharing
 * 
 * Displays and manages the list of users/groups that an agent is shared with,
 * including role assignment and removal functionality.
 */

import React from 'react';
import { Users, User, X, Eye, Edit, ExternalLink } from 'lucide-react';
import type { TSelectedPrincipal, TAccessRole } from 'librechat-data-provider';
import { Button } from '~/components/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/Select';
import { MOCK_ACCESS_ROLES } from './mockData';

interface SelectedPrincipalsListProps {
  selectedShares: TSelectedPrincipal[];
  onRemoveShare: (tempId: string) => void;
  onRoleChange: (tempId: string, newRole: string) => void;
  className?: string;
}

export default function SelectedPrincipalsList({
  selectedShares,
  onRemoveShare,
  onRoleChange,
  className = "",
}: SelectedPrincipalsListProps) {
  
  const getPrincipalIcon = (principal: TSelectedPrincipal) => {
    // Reason: Consistent visual representation across all sharing components
    return principal.type === 'user' ? (
      <User className="h-5 w-5 text-blue-500" />
    ) : (
      <Users className="h-5 w-5 text-green-500" />
    );
  };

  const getPrincipalDisplayInfo = (principal: TSelectedPrincipal) => {
    // Reason: Standardized display logic used across multiple components
    const displayName = principal.name || 'Unknown';
    const subtitle = principal.email || `${principal.type} (${principal.source || 'local'})`;
    
    return { displayName, subtitle };
  };

  const getRoleIcon = (roleId: string) => {
    // Reason: Visual indicator helps users quickly identify permission levels
    return roleId.includes('editor') ? <Edit className="h-3 w-3" /> : <Eye className="h-3 w-3" />;
  };

  if (selectedShares.length === 0) {
    return (
      <div className={`space-y-3 ${className}`}>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Users className="h-4 w-4" />
          Shared With (0)
        </h3>
        <div className="text-center py-8 text-muted-foreground border border-dashed border-border rounded-lg">
          <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">Not shared with anyone yet</p>
          <p className="text-xs mt-1">Search above to add users or groups</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <h3 className="text-sm font-medium flex items-center gap-2">
        <Users className="h-4 w-4" />
        Shared With ({selectedShares.length})
      </h3>
      
      <div className="space-y-2">
        {selectedShares.map((share) => {
          const { displayName, subtitle } = getPrincipalDisplayInfo(share);
          return (
            <div
              key={share.tempId}
              className="flex items-center justify-between p-3 bg-surface border border-border rounded-lg"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="flex-shrink-0">
                  {getPrincipalIcon(share)}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">
                    {displayName}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <span>{subtitle}</span>
                    {share.source === 'entra' && (
                      <>
                        <ExternalLink className="h-3 w-3" />
                        <span>Azure AD</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="flex items-center gap-2 flex-shrink-0">
                <Select
                  value={share.accessRoleId}
                  onValueChange={(value) => onRoleChange(share.tempId!, value)}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MOCK_ACCESS_ROLES.map(role => (
                      <SelectItem key={role.accessRoleId} value={role.accessRoleId}>
                        <div className="flex items-center gap-2">
                          {getRoleIcon(role.accessRoleId)}
                          {role.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemoveShare(share.tempId!)}
                  className="h-8 w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Remove ${displayName}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}