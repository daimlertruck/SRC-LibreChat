import React, { useState, useMemo } from 'react';
import type { TPrincipal, PrincipalSearchParams } from 'librechat-data-provider';
import { useSearchPrincipalsQuery } from 'librechat-data-provider/react-query';

import { SearchPicker } from '~/components/ui/SearchPicker';
import PeoplePickerSearchItem from './PeoplePickerSearchItem';
import SelectedPrincipalsList from './SelectedPrincipalsList';

interface PeoplePickerProps {
  onSelectionChange: (principals: TPrincipal[]) => void;
  placeholder?: string;
  className?: string;
}

export default function PeoplePicker({
  onSelectionChange,
  placeholder = 'Search by name or email (min 2 chars)',
  className = '',
}: PeoplePickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedShares, setSelectedShares] = useState<TPrincipal[]>([]);

  // Search parameters for the API
  const searchParams: PrincipalSearchParams = useMemo(
    () => ({
      q: searchQuery,
      limit: 10,
      // type: undefined // search both users and groups
    }),
    [searchQuery],
  );

  // Use the real API to search for principals
  const {
    data: searchResponse,
    isLoading: queryIsLoading,
    error,
  } = useSearchPrincipalsQuery(searchParams, {
    enabled: searchQuery.length >= 2, // Only search when query is long enough
  });

  // Calculate actual loading state: only show loading when query is valid and actually loading
  const isLoading = searchQuery.length >= 2 && queryIsLoading;

  // Extract results from API response, convert to TPrincipal format, and filter out already selected
  const selectableResults = useMemo(() => {
    const results = searchResponse?.results || [];
    // Convert PrincipalSearchResult to TPrincipal format with guaranteed non-undefined id
    const convertedResults: TPrincipal[] = results.map((result) => ({
      id: result.id || result.idOnTheSource, // This is guaranteed to be a string from the API
      type: result.type,
      name: result.name,
      email: result.email,
      source: result.source,
      avatar: result.avatar,
    }));

    return convertedResults.filter(
      (result) => !selectedShares.some((share) => share.id === result.id),
    );
  }, [searchResponse?.results, selectedShares]);
  // Handle error display (optional)
  if (error) {
    console.error('Principal search error:', error);
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="relative">
        <SearchPicker<TPrincipal & { key: string; value: string }>
          options={selectableResults.map((s) => {
            // API search results always have id and name, email for users
            const key = s.email || s.id || 'unknown';
            const value = s.name || s.email || s.id || 'Unknown';
            return {
              ...s,
              key,
              value,
            };
          })}
          renderOptions={(o) => <PeoplePickerSearchItem principal={o} />}
          placeholder={placeholder}
          query={searchQuery}
          onQueryChange={(query: string) => {
            setSearchQuery(query);
          }}
          onPick={(principal) => {
            console.log('Selected Principal:', principal);
            setSelectedShares((prev) => {
              const newArray = [...prev, principal];
              onSelectionChange([...newArray]);
              return newArray;
            });
            // Clear search after selection
            setSearchQuery('');
          }}
          label={'Search Users and Groups'}
          isLoading={isLoading}
        />
      </div>

      {/* Selected Principals List */}
      <SelectedPrincipalsList
        principles={selectedShares}
        onRemoveHandler={(id: string) => {
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
