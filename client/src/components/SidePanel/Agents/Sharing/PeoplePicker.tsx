/**
 * PeoplePicker Component for Agent Sharing
 *
 * Allows searching and selecting users/groups to share agents with.
 * Supports both local LibreChat users and Entra ID integration.
 */

import React, { useState, useEffect, useId } from 'react';
import { Users, User, ExternalLink, Filter } from 'lucide-react';
import * as Menu from '@ariakit/react/menu';
import type { TPrincipal, TSelectedPrincipal } from 'librechat-data-provider';

import { DropdownPopup } from '~/components/ui';
import { simulateSearchDelay } from '../mockData';
import { SearchPicker } from '~/components/ui/SearchPicker';

interface PeoplePickerProps {
  selectedShares: TSelectedPrincipal[];
  onSelectPrincipal: (principal: TPrincipal) => void;
  placeholder?: string;
  className?: string;
}

type SearchType = 'all' | 'user' | 'group';

export default function PeoplePicker({
  selectedShares,
  onSelectPrincipal,
  placeholder = 'Search by name or email (min 2 chars)',
  className = '',
}: PeoplePickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('all');
  const [searchResults, setSearchResults] = useState<TPrincipal[]>([]);

  // Perform search with realistic delay simulation
  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    const performSearch = async () => {
      try {
        const results = await simulateSearchDelay(searchQuery, searchType, selectedShares);
        setSearchResults(results);
      } catch (error) {
        console.error('Search failed:', error);
        setSearchResults([]);
      }
    };

    performSearch();
  }, [searchQuery, searchType, selectedShares]);

  const getPrincipalIcon = (principal: TPrincipal) => {
    // Reason: Visual distinction between users and groups improves UX
    return principal.type === 'user' ? (
      <User className="h-5 w-5 text-blue-500" />
    ) : (
      <Users className="h-5 w-5 text-green-500" />
    );
  };

  const getPrincipalDisplayInfo = (principal: TPrincipal) => {
    // Reason: Consistent display format across components
    const displayName = principal.name || 'Unknown';
    const subtitle = principal.email || `${principal.type} (${principal.source || 'local'})`;

    return { displayName, subtitle };
  };

  // Filter results that aren't already selected
  const selectableResults = searchResults.filter(
    (result) => !selectedShares.some((share) => share.id === result.id),
  );

  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <label className="mb-2 block text-sm font-medium">Search Users and Groups</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchPicker<TPrincipal & { key: string; value: string }>
              options={selectableResults.map((s) => ({ ...s, key: s.email!, value: s.name! }))}
              renderOptions={(o) => (
                <div>
                  {o.name} - {o.email}
                </div>
              )}
              placeholder={placeholder}
              query={searchQuery}
              onQueryChange={function (query: string): void {
                setSearchQuery(query);
              }}
              onPick={onSelectPrincipal}
              label={'Search Users and Groups'}
            />
          </div>
          <SearchTypeFilter searchType={searchType} onSearchTypeChange={setSearchType} />
        </div>
      </div>
    </div>
  );
}

// SearchTypeFilter component using DropdownPopup pattern
interface SearchTypeFilterProps {
  searchType: SearchType;
  onSearchTypeChange: (type: SearchType) => void;
}

function SearchTypeFilter({ searchType, onSearchTypeChange }: SearchTypeFilterProps) {
  const menuId = useId();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const searchTypeOptions = [
    { value: 'all', label: 'All', icon: <Filter className="h-4 w-4" /> },
    { value: 'user', label: 'Users', icon: <User className="h-4 w-4" /> },
    { value: 'group', label: 'Groups', icon: <Users className="h-4 w-4" /> },
  ] as const;

  const currentOption =
    searchTypeOptions.find((opt) => opt.value === searchType) || searchTypeOptions[0];

  return (
    <DropdownPopup
      portal={true}
      mountByState={true}
      unmountOnHide={true}
      preserveTabOrder={true}
      isOpen={isMenuOpen}
      setIsOpen={setIsMenuOpen}
      trigger={
        <Menu.MenuButton className="flex h-10 items-center gap-2 rounded-lg border border-border-medium bg-surface-secondary px-3 py-2 text-sm font-medium transition-colors duration-200 hover:bg-surface-tertiary">
          {currentOption.icon}
          <span className="hidden sm:inline">{currentOption.label}</span>
        </Menu.MenuButton>
      }
      items={searchTypeOptions.map((option) => ({
        id: option.value,
        label: option.label,
        icon: option.icon,
        onClick: () => onSearchTypeChange(option.value as SearchType),
      }))}
      menuId={menuId}
      className="z-30"
    />
  );
}
