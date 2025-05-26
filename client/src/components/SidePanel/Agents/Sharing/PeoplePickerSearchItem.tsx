/**
 * PeoplePickerSearchItem Component - Display user/group choice with avatar
 *
 * Renders a principal (user or group) with avatar when available,
 * or fallback to user/group icons.
 */

import React, { forwardRef } from 'react';
import { Users, User } from 'lucide-react';
import type { TPrincipal } from 'librechat-data-provider';
import { cn } from '~/utils';

interface PeoplePickerSearchItemProps extends React.HTMLAttributes<HTMLDivElement> {
  principal: TPrincipal;
}

const PeoplePickerSearchItem = forwardRef<HTMLDivElement, PeoplePickerSearchItemProps>(
  function PeoplePickerSearchItem(
    { principal, className, style, onClick, ...props },
    forwardedRef,
  ) {
    const { name, email, type, avatar } = principal;

    // Display name with fallback
    const displayName = name || 'Unknown';
    const subtitle = email || `${type} (${principal.source || 'local'})`;

    // Avatar or icon logic
    const renderAvatar = () => {
      if (avatar) {
        return (
          <img
            src={avatar}
            alt={`${displayName} avatar`}
            className="h-8 w-8 rounded-full object-cover"
            onError={(e) => {
              // Fallback to icon if image fails to load
              const target = e.target as HTMLImageElement;
              target.style.display = 'none';
              target.nextElementSibling?.classList.remove('hidden');
            }}
          />
        );
      }

      // Fallback icon based on type
      return type === 'user' ? (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
          <User className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </div>
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
          <Users className="h-4 w-4 text-green-600 dark:text-green-400" />
        </div>
      );
    };

    return (
      <div
        {...props}
        ref={forwardedRef}
        className={cn('flex items-center gap-3 p-2', className)}
        style={style}
        onClick={(event) => {
          console.log('clicked');
          onClick?.(event);
          // Additional custom logic can go here if needed
        }}
      >
        {/* Avatar or Icon */}
        <div className="flex-shrink-0">
          {renderAvatar()}
          {/* Hidden fallback icon that shows if image fails */}
          {avatar && (
            <div className="hidden h-8 w-8">
              {type === 'user' ? (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
                  <User className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                </div>
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
                  <Users className="h-4 w-4 text-green-600 dark:text-green-400" />
                </div>
              )}
            </div>
          )}
        </div>

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
