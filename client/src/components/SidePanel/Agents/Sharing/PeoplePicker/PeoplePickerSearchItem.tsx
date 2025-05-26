/**
 * PeoplePickerSearchItem Component - Display user/group choice with avatar
 *
 * Renders a principal (user or group) with avatar when available,
 * or fallback to user/group icons.
 */

import React, { forwardRef } from 'react';
import type { TPrincipal } from 'librechat-data-provider';
import { cn } from '~/utils';
import PrincipalAvatar from '../PrincipalAvatar';

interface PeoplePickerSearchItemProps extends React.HTMLAttributes<HTMLDivElement> {
  principal: TPrincipal;
}

const PeoplePickerSearchItem = forwardRef<HTMLDivElement, PeoplePickerSearchItemProps>(
  function PeoplePickerSearchItem(
    { principal, className, style, onClick, ...props },
    forwardedRef,
  ) {
    const { name, email, type } = principal;

    // Display name with fallback
    const displayName = name || 'Unknown';
    const subtitle = email || `${type} (${principal.source || 'local'})`;

    return (
      <div
        {...props}
        ref={forwardedRef}
        className={cn('flex items-center gap-3 p-2', className)}
        style={style}
        onClick={(event) => {
          onClick?.(event);
          // Additional custom logic can go here if needed
        }}
      >
        {/* Avatar or Icon */}
        <PrincipalAvatar principal={principal} size="md" />

        {/* Principal Info */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary">{displayName}</div>
          <div className="truncate text-xs text-text-secondary">{subtitle}</div>
        </div>

        {/* Type Badge */}
        <div className="flex-shrink-0">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium',
              type === 'user'
                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300'
                : 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
            )}
          >
            {type === 'user' ? 'User' : 'Group'}
          </span>
        </div>
      </div>
    );
  },
);

export default PeoplePickerSearchItem;
