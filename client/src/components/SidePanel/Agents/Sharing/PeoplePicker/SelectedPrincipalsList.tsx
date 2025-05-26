import React, { useState, useId } from 'react';
import { Users, X, Eye, Edit, ExternalLink, ChevronDown } from 'lucide-react';
import * as Menu from '@ariakit/react/menu';
import type { TPrincipal, TAccessRole } from 'librechat-data-provider';
import { Button, DropdownPopup } from '~/components/ui';
import { MOCK_ACCESS_ROLES } from '../mockData';
import PrincipalAvatar from '../PrincipalAvatar';

interface SelectedPrincipalsListProps {
  principles: TPrincipal[];
  onRemoveHandler: (id: string) => void;
  className?: string;
}

export default function SelectedPrincipalsList({
  principles,
  onRemoveHandler,
  className = '',
}: SelectedPrincipalsListProps) {

  const getPrincipalDisplayInfo = (principal: TPrincipal) => {
    // Reason: Standardized display logic used across multiple components
    const displayName = principal.name || 'Unknown';
    const subtitle = principal.email || `${principal.type} (${principal.source || 'local'})`;

    return { displayName, subtitle };
  };

  const getRoleIcon = (roleId: string) => {
    // Reason: Visual indicator helps users quickly identify permission levels
    return roleId.includes('editor') ? <Edit className="h-3 w-3" /> : <Eye className="h-3 w-3" />;
  };

  const getRoleDisplayName = (accessRoleId: string) => {
    const role = MOCK_ACCESS_ROLES.find((r) => r.accessRoleId === accessRoleId);
    return role?.name || 'Unknown Role';
  };

  if (principles.length === 0) {
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-muted-foreground">
          <Users className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p className="mt-1 text-xs">Search above to add users or groups</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="space-y-2">
        {principles.map((share) => {
          const { displayName, subtitle } = getPrincipalDisplayInfo(share);
          return (
            <div
              key={share.id}
              className="bg-surface flex items-center justify-between rounded-lg border border-border p-3"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <PrincipalAvatar principal={share} size="md" />

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{displayName}</div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
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

              <div className="flex flex-shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemoveHandler(share.id!)}
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

// // RoleSelector component using DropdownPopup pattern
// interface RoleSelectorProps {
//   currentRole: string;
//   onRoleChange: (newRole: string) => void;
// }

// function RoleSelector({ currentRole, onRoleChange }: RoleSelectorProps) {
//   const menuId = useId();
//   const [isMenuOpen, setIsMenuOpen] = useState(false);

//   const currentRoleData = MOCK_ACCESS_ROLES.find((r) => r.accessRoleId === currentRole);
//   const currentRoleIcon = currentRole.includes('editor') ? (
//     <Edit className="h-4 w-4 text-green-500" />
//   ) : (
//     <Eye className="h-4 w-4 text-blue-500" />
//   );

//   return (
//     <DropdownPopup
//       portal={true}
//       mountByState={true}
//       unmountOnHide={true}
//       preserveTabOrder={true}
//       isOpen={isMenuOpen}
//       setIsOpen={setIsMenuOpen}
//       trigger={
//         <Menu.MenuButton className="flex h-8 items-center gap-2 rounded-md border border-border-medium bg-surface-secondary px-2 py-1 text-sm font-medium transition-colors duration-200 hover:bg-surface-tertiary">
//           {currentRoleIcon}
//           <span className="hidden sm:inline">{currentRoleData?.name}</span>
//           <ChevronDown className="h-3 w-3" />
//         </Menu.MenuButton>
//       }
//       items={MOCK_ACCESS_ROLES.map((role) => ({
//         id: role.accessRoleId,
//         label: role.name,
//         icon: role.accessRoleId.includes('editor') ? (
//           <Edit className="h-4 w-4 text-green-500" />
//         ) : (
//           <Eye className="h-4 w-4 text-blue-500" />
//         ),
//         onClick: () => onRoleChange(role.accessRoleId),
//       }))}
//       menuId={menuId}
//       className="z-30"
//     />
//   );
// }
