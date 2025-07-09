// SharePoint Search API Types and Utilities

export interface ISearchResult {
  Rank?: number;
  DocId?: number;
  WorkId?: number;
  Title?: string;
  Author?: string;
  Size?: number;
  Path?: string;
  Description?: string;
  Write?: Date;
  LastModifiedTime?: Date;
  CollapsingStatus?: number;
  HitHighlightedSummary?: string;
  HitHighlightedProperties?: string;
  contentclass?: string;
  PictureThumbnailURL?: string;
  ServerRedirectedURL?: string;
  ServerRedirectedEmbedURL?: string;
  ServerRedirectedPreviewURL?: string;
  FileExtension?: string;
  ContentTypeId?: string;
  ParentLink?: string;
  ViewsLifeTime?: string;
  ViewsRecent?: number;
  SectionNames?: string;
  SectionIndexes?: string;
  SiteLogo?: string;
  SiteDescription?: string;
  importance?: number;
  SiteName?: string;
  IsDocument?: boolean;
  FileType?: string;
  IsContainer?: boolean;
  WebTemplate?: string;
  SPWebUrl?: string;
  UniqueId?: string;
  ProgId?: string;
  OriginalPath?: string;
  RenderTemplateId?: string;
  PartitionId?: string;
  UrlZone?: number;
  Culture?: string;
  GeoLocationSource?: string;
  SiteId?: string;
  WebId?: string;
  ListId?: string;
  IsExternalContent?: boolean;
  DocumentSignature?: string;
  LinkingUrl?: string;
  ResultTypeId?: string;
  ResultTypeIdList?: string;
}

export interface ISearchResponse {
  ElapsedTime: number;
  Properties?: { Key: string; Value: any; ValueType: string }[];
  PrimaryQueryResult?: IResultTableCollection;
  SecondaryQueryResults?: IResultTableCollection;
  SpellingSuggestion?: string;
  TriggeredRules?: any[];
}

export interface IResultTableCollection {
  QueryErrors?: Map<string, any>;
  QueryId?: string;
  QueryRuleId?: string;
  CustomResults?: IResultTable;
  RefinementResults?: IResultTable;
  RelevantResults?: IResultTable;
  SpecialTermResults?: IResultTable;
}

export interface IRefiner {
  Name: string;
  Entries: {
    RefinementCount: string;
    RefinementName: string;
    RefinementToken: string;
    RefinementValue: string;
  }[];
}

export interface IResultTable {
  GroupTemplateId?: string;
  ItemTemplateId?: string;
  Properties?: { Key: string; Value: any; ValueType: string }[];
  Table?: { Rows: { Cells: { Key: string; Value: any; ValueType: string }[] }[] };
  Refiners?: IRefiner[];
  ResultTitle?: string;
  ResultTitleUrl?: string;
  RowCount?: number;
  TableType?: string;
  TotalRows?: number;
  TotalRowsIncludingDuplicates?: number;
}

export interface ISort {
  Property: string;
  Direction: SortDirection;
}

export interface ISearchProperty {
  Name: string;
  Value: ISearchPropertyValue;
}

export interface ISearchPropertyValue {
  StrVal?: string;
  BoolVal?: boolean;
  IntVal?: number;
  StrArray?: string[];
  QueryPropertyValueTypeIndex: QueryPropertyValueType;
}

export enum SortDirection {
  Ascending = 0,
  Descending = 1,
  FQLFormula = 2,
}

export interface IReorderingRule {
  MatchValue: string;
  Boost: number;
  MatchType: ReorderingRuleMatchType;
}

export enum ReorderingRuleMatchType {
  ResultContainsKeyword = 0,
  TitleContainsKeyword = 1,
  TitleMatchesKeyword = 2,
  UrlStartsWith = 3,
  UrlExactlyMatches = 4,
  ContentTypeIs = 5,
  FileExtensionMatches = 6,
  ResultHasTag = 7,
  ManualCondition = 8,
}

export enum QueryPropertyValueType {
  None = 0,
  StringType = 1,
  Int32Type = 2,
  BooleanType = 3,
  StringArrayType = 4,
  UnSupportedType = 5,
}

// SharePoint Site Interface
export interface SharePointSite {
  id: string;
  title: string;
  description?: string;
  webUrl: string;
  siteType: 'TeamSite' | 'CommunicationSite' | 'OneDrive';
  initials: string;
}

/**
 * Generate initials from site title
 */
export function generateInitials(title: string): string {
  if (!title) return 'SP';

  return (
    title
      .split(' ')
      .filter((word) => word.length > 0)
      .map((word) => word.charAt(0).toUpperCase())
      .slice(0, 2) // Max 2 characters
      .join('') || 'SP'
  );
}

/**
 * Determine site type from WebTemplate and contentclass
 */
export function determineSiteType(
  webTemplate?: string,
  contentClass?: string,
): 'TeamSite' | 'CommunicationSite' | 'OneDrive' {
  if (contentClass?.includes('STS_Site')) {
    if (webTemplate === 'SITEPAGEPUBLISHING') return 'CommunicationSite';
    if (webTemplate === 'GROUP') return 'TeamSite';
  }
  if (contentClass?.includes('PersonalSpace')) return 'OneDrive';
  return 'TeamSite'; // Default fallback
}

/**
 * Parse SharePoint REST API search response into SharePointSite objects
 */
export function parseSearchResponse(response: any): SharePointSite[] {
  // Handle the actual response structure from SharePoint API
  const rawResults = response?.d?.query?.PrimaryQueryResult?.RelevantResults?.Table?.Rows;
  const results = rawResults?.results ? rawResults.results : rawResults || [];

  return results
    .map((row: any) => {
      // Handle both .results and direct array structures
      const cells = row.Cells?.results ? row.Cells.results : row.Cells || [];

      // Convert cells array to a key-value object like PnP does
      const cellData = cells.reduce((res: any, cell: any) => {
        res[cell.Key] = cell.Value;
        return res;
      }, {});

      const title = cellData.Title || cellData.SiteName || 'Untitled Site';
      const webUrl = cellData.SPWebUrl || cellData.Path;
      const description = cellData.SiteDescription || cellData.Description;
      const webTemplate = cellData.WebTemplate;
      const contentClass = cellData.contentclass;

      return {
        id: cellData.SiteId || cellData.UniqueId || webUrl || '',
        title: String(title),
        description: description ? String(description) : undefined,
        webUrl: String(webUrl || ''),
        siteType: determineSiteType(webTemplate, contentClass),
        initials: generateInitials(String(title)),
      };
    })
    .filter((site) => site.webUrl && site.webUrl.length > 0); // Only include sites with valid URLs
}

/**
 * Get site type display name
 */
export function getSiteTypeDisplayName(siteType: SharePointSite['siteType']): string {
  switch (siteType) {
    case 'TeamSite':
      return 'Team Site';
    case 'CommunicationSite':
      return 'Communication Site';
    case 'OneDrive':
      return 'OneDrive';
    default:
      return 'Site';
  }
}

/**
 * Get site type icon name (Fluent UI icons)
 */
export function getSiteTypeIcon(siteType: SharePointSite['siteType']): string {
  switch (siteType) {
    case 'TeamSite':
      return 'SharepointAppIcon16';
    case 'CommunicationSite':
      return 'SharepointAppIcon16';
    case 'OneDrive':
      return 'OneDriveIcon';
    default:
      return 'SharepointAppIcon16';
  }
}
