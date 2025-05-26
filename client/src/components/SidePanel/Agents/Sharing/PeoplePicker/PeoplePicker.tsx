import React, { useState, useEffect, useId, useMemo } from 'react';
import { Users, User, ExternalLink, Filter } from 'lucide-react';
import * as Menu from '@ariakit/react/menu';
import type { TPrincipal } from 'librechat-data-provider';

import { Dropdown, DropdownPopup } from '~/components/ui';
import { simulateSearchDelay } from '../mockData';
import { SearchPicker } from '~/components/ui/SearchPicker';
import PeoplePickerSearchItem from './PeoplePickerSearchItem';
import SelectedPrincipalsList from './SelectedPrincipalsList';

interface PeoplePickerProps {
  onSelectionChange: (principals: TPrincipal[]) => void;
  placeholder?: string;
  className?: string;
  debounceMs?: number;
}

type SearchType = 'all' | 'user' | 'group';

export default function PeoplePicker({
  onSelectionChange,
  placeholder = 'Search by name or email (min 2 chars)',
  className = '',
  debounceMs = 300,
}: PeoplePickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('all');
  const [searchResults, setSearchResults] = useState<TPrincipal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedShares, setSelectedShares] = useState<TPrincipal[]>([]);
  // Perform search with realistic delay simulation
  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([]);
      setIsLoading(false);
      return;
    }

    // Set loading immediately when user types a valid query
    setIsLoading(true);

    const timeoutId = setTimeout(() => {
      const performSearch = async () => {
        try {
          const results = await simulateSearchDelay(searchQuery, searchType, selectedShares);
          setSearchResults(results);
        } catch (error) {
          console.error('Search failed:', error);
          setSearchResults([]);
        } finally {
          setIsLoading(false);
        }
      };

      performSearch();
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [searchQuery, searchType, selectedShares, debounceMs]);

  // Filter results that aren't already selected
  const selectableResults = searchResults.filter(
    (result) => !selectedShares.some((share) => share.id === result.id),
  );
  console.log('Selectable Results:', selectedShares);

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="items-bottom flex gap-2">
        <div className="relative flex-1">
          <SearchPicker<TPrincipal & { key: string; value: string }>
            options={selectableResults.map((s) => ({ ...s, key: s.email!, value: s.name! }))}
            renderOptions={(o) => <PeoplePickerSearchItem principal={o} />}
            placeholder={placeholder}
            query={searchQuery}
            onQueryChange={function (query: string): void {
              setSearchQuery(query);
            }}
            onPick={(principal) => {
              console.log('Selected Principal:', principal);
              setSelectedShares((prev) => {
                const newArray = [...prev, principal];
                onSelectionChange([...newArray]);
                return newArray;
              });
            }}
            label={'Search Users and Groups'}
            isLoading={isLoading}
          />
        </div>
      </div>

      {/* Selected Principals List */}
      <SelectedPrincipalsList
        principles={selectedShares}
        onRemoveHandler={function (id: string): void {
          setSelectedShares((prev) => {
            const newArray = prev.filter((share) => share.id !== id);
            onSelectionChange(newArray);
            return newArray;
          });
        }}
      />
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
