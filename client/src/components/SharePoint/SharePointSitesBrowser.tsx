import React, { useState, useCallback, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { SharePointSite, getSiteTypeDisplayName } from '~/utils/sharepoint';
import { cn } from '~/utils';
import { useDebounce } from '~/hooks';
import { useSharePointSitesInfiniteQuery } from '~/data-provider';

interface SharePointSitesBrowserProps {
  onSiteSelected: (siteUrl: string) => void;
  sharePointBaseUrl: string;
  accessToken: string;
}

interface SiteCardProps {
  site: SharePointSite;
  onClick: (siteUrl: string) => void;
}

const SiteCard: React.FC<SiteCardProps> = ({ site, onClick }) => {
  const handleClick = () => {
    onClick(site.webUrl);
  };

  return (
    <div
      className="cursor-pointer rounded-lg border border-gray-200 bg-white p-4 transition-all duration-200 hover:border-gray-300 hover:shadow-md"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      <div className="flex items-start space-x-3">
        {/* Site Initials  */}
        <div className="flex-shrink-0">
          <div className="flex h-12 w-12 items-center justify-center rounded-sm bg-blue-500 text-lg font-semibold text-white">
            {site.initials}
          </div>
        </div>

        {/* Site Information */}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center space-x-2">
            <h3 className="truncate text-sm font-medium text-gray-900">{site.title}</h3>
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-800">
              {getSiteTypeDisplayName(site.siteType)}
            </span>
          </div>

          {site.description && (
            <p className="mb-2 line-clamp-2 text-sm text-gray-500">{site.description}</p>
          )}

          <p className="truncate text-xs text-gray-400">{site.webUrl}</p>
        </div>
      </div>
    </div>
  );
};

const SiteCardSkeleton: React.FC = () => {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start space-x-3">
        {/* Skeleton circle */}
        <div className="flex-shrink-0">
          <div className="h-12 w-12 animate-pulse rounded-sm bg-gray-200"></div>
        </div>

        {/* Skeleton content */}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center space-x-2">
            <div className="h-4 w-32 animate-pulse rounded bg-gray-200"></div>
            <div className="h-5 w-16 animate-pulse rounded-full bg-gray-200"></div>
          </div>
          <div className="h-3 w-48 animate-pulse rounded bg-gray-200"></div>
          <div className="h-3 w-36 animate-pulse rounded bg-gray-200"></div>
        </div>
      </div>
    </div>
  );
};

export default function SharePointSitesBrowser({
  onSiteSelected,
  sharePointBaseUrl,
  accessToken,
}: SharePointSitesBrowserProps) {
  const localize = useLocalize();
  const [searchQuery, setSearchQuery] = useState('');
  const [showClearIcon, setShowClearIcon] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedSearchQuery = useDebounce(searchQuery, 500);

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useSharePointSitesInfiniteQuery({
    baseUrl: sharePointBaseUrl,
    accessToken,
    searchQuery: debouncedSearchQuery,
    rowsPerPage: 10,
    enabled: Boolean(sharePointBaseUrl && accessToken),
  });

  // Clear search function
  const clearSearch = useCallback(() => {
    setShowClearIcon(false);
    setSearchQuery('');
    inputRef.current?.focus();
  }, []);

  // Handle search input change
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setShowClearIcon(value.length > 0);
    setSearchQuery(value);
  }, []);

  // Handle keyboard events
  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const { value } = e.target as HTMLInputElement;
    if (e.key === 'Backspace' && value === '') {
      clearSearch();
    }
  }, [clearSearch]);

  const handleSiteSelected = useCallback(
    (siteUrl: string) => {
      onSiteSelected(siteUrl);
    },
    [onSiteSelected],
  );

  const allSites = data?.pages.flatMap((page) => page.sites) || [];
  const totalSites = data?.pages[0]?.total || 0;

  return (
    <div className={cn('absolute flex h-full w-full flex-col gap-4 rounded-lg bg-white p-6')}>
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          {localize('com_files_sharepoint_sites_browser_title') || 'Browse SharePoint Sites'}
        </h2>
      </div>
      {/* Search Input */}
      <div
        className={cn(
          'group relative flex h-10 cursor-pointer items-center gap-3 rounded-lg border-border-medium px-3 py-2 text-text-primary transition-colors duration-200 focus-within:bg-surface-hover hover:bg-surface-hover'
        )}
      >
        <Search className="absolute left-3 h-4 w-4 text-text-secondary group-focus-within:text-text-primary group-hover:text-text-primary" />
        <input
          type="text"
          ref={inputRef}
          className="m-0 mr-0 w-full border-none bg-transparent p-0 pl-7 text-sm leading-tight placeholder-text-secondary placeholder-opacity-100 focus-visible:outline-none group-focus-within:placeholder-text-primary group-hover:placeholder-text-primary"
          value={searchQuery}
          onChange={handleSearchChange}
          onKeyDown={(e) => {
            e.code === 'Space' ? e.stopPropagation() : null;
          }}
          onKeyUp={handleKeyUp}
          aria-label={localize('com_files_sharepoint_search_sites') || 'Search sites...'}
          placeholder={localize('com_files_sharepoint_search_sites') || 'Search sites...'}
          autoComplete="off"
          dir="auto"
        />
        <button
          type="button"
          aria-label={`${localize('com_ui_clear') || 'Clear'} ${localize('com_ui_search') || 'Search'}`}
          className={cn(
            'absolute right-[7px] flex h-5 w-5 items-center justify-center rounded-full border-none bg-transparent p-0 transition-opacity duration-200',
            showClearIcon ? 'opacity-100' : 'opacity-0'
          )}
          onClick={clearSearch}
          tabIndex={showClearIcon ? 0 : -1}
          disabled={!showClearIcon}
        >
          <X className="h-5 w-5 cursor-pointer" />
        </button>
      </div>

      {/* Results Header */}
      {!isLoading && !error && totalSites > 0 && (
        <div className="text-sm text-gray-600">
          {localize('com_files_sharepoint_sites_found', { count: totalSites }) ||
            `${totalSites} sites found`}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">
            {error instanceof Error ? error.message : 'Failed to search SharePoint sites'}
          </p>
          <button
            onClick={() => refetch()}
            className="mt-2 text-sm text-red-600 underline hover:text-red-800"
          >
            {localize('com_ui_retry') || 'Retry'}
          </button>
        </div>
      )}

      {/* Sites Grid */}
      <div className="mb-10 overflow-y-auto">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-1">
          {/* Render actual sites */}
          {allSites.map((site) => (
            <SiteCard key={site.id} site={site} onClick={handleSiteSelected} />
          ))}

          {/* Render shimmer skeletons while loading */}
          {(isLoading || isFetching) &&
            Array.from({ length: isLoading ? 6 : 3 }).map((_, index) => (
              <SiteCardSkeleton key={`skeleton-${index}`} />
            ))}
        </div>

        {/* Load More Button */}
        {hasNextPage && (
          <div className="flex justify-center pt-4">
            <button
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="inline-flex h-10 min-w-[160px] items-center justify-center gap-2 whitespace-nowrap rounded-lg border-2 border-gray-300 bg-white px-6 py-3 text-sm font-medium text-gray-700 shadow-sm ring-offset-background transition-all duration-200 hover:border-gray-400 hover:bg-gray-50 hover:text-accent-foreground hover:shadow-md focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-gray-500 dark:hover:bg-gray-700 dark:focus:ring-blue-400"
            >
              {isFetchingNextPage ? (
                <>
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-b-2 border-white"></div>
                  {localize('com_ui_loading') || 'Loading...'}
                </>
              ) : (
                localize('com_files_sharepoint_load_more') || 'Load More'
              )}
            </button>
          </div>
        )}
      </div>

      {/* Empty State */}
      {!isLoading && !error && allSites.length === 0 && (
        <div className="py-8 text-center">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            {localize('com_files_sharepoint_no_sites') || 'No sites found'}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {localize('com_files_sharepoint_no_sites_description') ||
              'Try adjusting your search terms.'}
          </p>
        </div>
      )}
    </div>
  );
}
