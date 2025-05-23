/**
 * PeoplePicker Component for Agent Sharing
 * 
 * Allows searching and selecting users/groups to share agents with.
 * Supports both local LibreChat users and Entra ID integration.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Search, Users, User, ExternalLink, Loader } from 'lucide-react';
import type { TPrincipal, TSelectedPrincipal } from 'librechat-data-provider';
import { Input } from '~/components/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/Select';
import { getAllMockPrincipals } from './mockData';

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

  // Filter search results based on query and type
  const searchResults = useMemo(() => {
    if (!searchQuery || searchQuery.length < 2) return [];
    
    const allPrincipals = getAllMockPrincipals();
    const query = searchQuery.toLowerCase();
    
    let filtered = allPrincipals.filter(p => 
      p.name?.toLowerCase().includes(query) || 
      (p.email && p.email.toLowerCase().includes(query))
    );
    
    // Filter by type if not 'all'
    if (searchType !== 'all') {
      filtered = filtered.filter(p => p.type === searchType);
    }
    
    // Filter out already selected principals
    const selectedIds = selectedShares.map(s => s.id);
    filtered = filtered.filter(p => !selectedIds.includes(p.id));
    
    return filtered.slice(0, 10); // Limit results for performance
  }, [searchQuery, searchType, selectedShares]);

  // Simulate search delay for better UX
  useEffect(() => {
    if (searchQuery.length >= 2) {
      setIsSearching(true);
      const timer = setTimeout(() => setIsSearching(false), 300);
      return () => clearTimeout(timer);
    }
  }, [searchQuery]);

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
  };

  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <label className="block text-sm font-medium mb-2">
          Search Users and Groups
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={placeholder}
              className="pl-10"
            />
            {isSearching && (
              <Loader className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 animate-spin" />
            )}
          </div>
          <Select value={searchType} onValueChange={(value: SearchType) => setSearchType(value)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="user">Users</SelectItem>
              <SelectItem value="group">Groups</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      
      {/* Search Results */}
      {searchQuery.length >= 2 && (
        <div className="border border-border rounded-lg max-h-48 overflow-y-auto">
          {isSearching ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              <Loader className="h-4 w-4 animate-spin mx-auto mb-2" />
              Searching...
            </div>
          ) : searchResults.length > 0 ? (
            <div className="divide-y divide-border">
              {searchResults.map((result) => {
                const { displayName, subtitle } = getPrincipalDisplayInfo(result);
                return (
                  <div
                    key={result.id}
                    className="p-3 hover:bg-surface-hover cursor-pointer flex items-center gap-3 transition-colors"
                    onClick={() => handleSelectPrincipal(result)}
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
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No results found
            </div>
          )}
        </div>
      )}
    </div>
  );
}