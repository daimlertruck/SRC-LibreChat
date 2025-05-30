import React from 'react';
import { ACCESS_ROLE_IDS } from 'librechat-data-provider';
import type { AccessRole } from 'librechat-data-provider';
import { SelectDropDownPop } from '~/components/ui';
import { useGetAccessRolesQuery } from 'librechat-data-provider/react-query';

interface AccessRolesPickerProps {
  resourceType?: string;
  selectedRoleId?: string;
  onRoleChange: (roleId: string) => void;
  className?: string;
}

export default function AccessRolesPicker({
  resourceType = 'agent',
  selectedRoleId = ACCESS_ROLE_IDS.AGENT_VIEWER,
  onRoleChange,
  className = '',
}: AccessRolesPickerProps) {
  // Fetch access roles from API
  const { data: accessRoles, isLoading: rolesLoading } = useGetAccessRolesQuery(resourceType);

  // Find the currently selected role
  const selectedRole = accessRoles?.find((role) => role.accessRoleId === selectedRoleId);

  if (rolesLoading || !accessRoles) {
    return (
      <div className={className}>
        <div className="flex items-center justify-center py-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600"></div>
          <span className="ml-2 text-sm text-gray-500">Loading roles...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <SelectDropDownPop
        availableValues={accessRoles.map((role: AccessRole) => ({
          value: role.accessRoleId,
          label: role.name,
          description: role.description,
        }))}
        showLabel={false}
        value={
          selectedRole
            ? {
                value: selectedRole.accessRoleId,
                label: selectedRole.name,
                description: selectedRole.description,
              }
            : null
        }
        setValue={onRoleChange}
      />
    </div>
  );
}
