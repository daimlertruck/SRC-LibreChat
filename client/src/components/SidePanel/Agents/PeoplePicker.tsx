/**
 * PeoplePicker Component for Agent Sharing
 * 
 * Allows searching and selecting users/groups to share agents with.
 * Supports both local LibreChat users and Entra ID integration.
 */

import React, { useState, useEffect, useMemo, useId, useRef } from 'react';
import { Search, Users, User, ExternalLink, Filter, X } from 'lucide-react';
import * as Menu from '@ariakit/react/menu';
import type { TPrincipal, TSelectedPrincipal } from 'librechat-data-provider';
import { DropdownPopup } from '~/components/ui';
import Spinner from '~/components/svg/Spinner';
import { cn } from '~/utils';
import { simulateSearchDelay } from './mockData';

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
  placeholder = "Search by name or email (min 2 chars)",
  className = "",
}: PeoplePickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [showClearIcon, setShowClearIcon] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // State for search results
  const [searchResults, setSearchResults] = useState<TPrincipal[]>([]);

  // Perform search with realistic delay simulation
  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    
    const performSearch = async () => {
      try {
        const results = await simulateSearchDelay(searchQuery, searchType, selectedShares);
        setSearchResults(results);
      } catch (error) {
        console.error('Search failed:', error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
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

  const handleSelectPrincipal = (principal: TPrincipal) => {
    onSelectPrincipal(principal);
    setSearchQuery(''); // Clear search after selection
    setShowResults(false);
    setHighlightedIndex(-1);
    setShowClearIcon(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!showResults && searchQuery.length >= 2) {
          setShowResults(true);
          setHighlightedIndex(0);
        } else if (searchResults.length > 0) {
          setHighlightedIndex((prevIndex) =>
            prevIndex < searchResults.length - 1 ? prevIndex + 1 : prevIndex,
          );
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (showResults && highlightedIndex > 0) {
          setHighlightedIndex((prevIndex) => prevIndex - 1);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (showResults && highlightedIndex !== -1 && searchResults[highlightedIndex]) {
          handleSelectPrincipal(searchResults[highlightedIndex]);
        }
        break;
      case 'Escape':
        setShowResults(false);
        setHighlightedIndex(-1);
        break;
    }
  };

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowResults(false);
        setHighlightedIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Reset highlighted index when search results change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchResults]);

  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <label className="block text-sm font-medium mb-2">
          Search Users and Groups
        </label>
        <div className="flex gap-2">
          <div className="flex-1 relative" ref={containerRef}>
            {/* SearchBar-like input */}
            <div className={cn(
              "group relative flex h-10 cursor-pointer items-center gap-3 rounded-lg border border-border-medium px-3 py-2 text-text-primary transition-colors duration-200 focus-within:bg-surface-hover hover:bg-surface-hover"
            )}>
              <Search className="h-4 w-4 text-text-secondary group-focus-within:text-text-primary group-hover:text-text-primary" />
              <input
                ref={inputRef}
                type="text"
                className="m-0 mr-0 w-full border-none bg-transparent p-0 text-sm leading-tight placeholder-text-secondary placeholder-opacity-100 focus-visible:outline-none group-focus-within:placeholder-text-primary group-hover:placeholder-text-primary"
                value={searchQuery}
                onChange={(e) => {
                  const value = e.target.value;
                  setSearchQuery(value);
                  setShowClearIcon(value.length > 0);
                  setShowResults(value.length >= 2);
                  setHighlightedIndex(-1);
                }}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  if (searchQuery.length >= 2) {
                    setShowResults(true);
                  }
                }}
                placeholder={placeholder}
                autoComplete="off"
                aria-haspopup="listbox"
                aria-controls="search-results-list"
                aria-expanded={showResults}
                aria-activedescendant={highlightedIndex !== -1 ? `result-${highlightedIndex}` : undefined}
              />
              {isSearching && (
                <Spinner className="h-4 w-4" size={16} />
              )}
              <button
                type="button"
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border-none bg-transparent p-0 transition-opacity duration-200",
                  showClearIcon ? "opacity-100" : "opacity-0"
                )}
                onClick={() => {
                  setSearchQuery('');
                  setShowClearIcon(false);
                  setShowResults(false);
                  setHighlightedIndex(-1);
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                tabIndex={showClearIcon ? 0 : -1}
                disabled={!showClearIcon}
              >
                <X className="h-4 w-4 cursor-pointer" />
              </button>
            </div>
            
            {/* Dropdown Results with keyboard navigation */}
            {showResults && searchResults.length > 0 && (
              <ul
                id="search-results-list"
                role="listbox"
                className="absolute top-full left-0 right-0 z-50 mt-1 border border-border rounded-lg bg-surface-primary shadow-lg max-h-48 overflow-y-auto"
              >
                {searchResults.map((result, index) => {
                  const { displayName, subtitle } = getPrincipalDisplayInfo(result);
                  const isHighlighted = index === highlightedIndex;
                  return (
                    <li
                      key={result.id}
                      id={`result-${index}`}
                      role="option"
                      aria-selected={isHighlighted}
                      className={cn(
                        "p-3 cursor-pointer flex items-center gap-3 transition-colors",
                        isHighlighted 
                          ? "bg-surface-active" 
                          : "hover:bg-surface-hover"
                      )}
                      onClick={() => handleSelectPrincipal(result)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                    >
                      <div className="flex-shrink-0">
                        {getPrincipalIcon(result)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">
                          {displayName}
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <span>{subtitle}</span>
                          {result.source === 'entra' && (
                            <>
                              <ExternalLink className="h-3 w-3" />
                              <span>Azure AD</span>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            
            {/* No results message */}
            {showResults && searchQuery.length >= 2 && searchResults.length === 0 && !isSearching && (
              <div className="absolute top-full left-0 right-0 z-50 mt-1 border border-border rounded-lg bg-surface-primary shadow-lg">
                <div className="p-4 text-center text-sm text-muted-foreground">
                  No results found
                </div>
              </div>
            )}
          </div>
          <SearchTypeFilter 
            searchType={searchType}
            onSearchTypeChange={setSearchType}
          />
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

  const currentOption = searchTypeOptions.find(opt => opt.value === searchType) || searchTypeOptions[0];

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