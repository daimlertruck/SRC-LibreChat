import type { InfiniteData } from '@tanstack/react-query';
import type * as a from '../types/agents';
import type * as s from '../schemas';
import type * as t from '../types';

export type Conversation = {
  id: string;
  createdAt: number;
  participants: string[];
  lastMessage: string;
  conversations: s.TConversation[];
};

export type ConversationListParams = {
  cursor?: string;
  isArchived?: boolean;
  sortBy?: 'title' | 'createdAt' | 'updatedAt';
  sortDirection?: 'asc' | 'desc';
  tags?: string[];
  search?: string;
};

export type MinimalConversation = Pick<
  s.TConversation,
  'conversationId' | 'endpoint' | 'title' | 'createdAt' | 'updatedAt' | 'user'
>;

export type ConversationListResponse = {
  conversations: MinimalConversation[];
  nextCursor: string | null;
};

export type ConversationData = InfiniteData<ConversationListResponse>;
export type ConversationUpdater = (
  data: ConversationData,
  conversation: s.TConversation,
) => ConversationData;

/* Messages */
export type MessagesListParams = {
  cursor?: string | null;
  sortBy?: 'endpoint' | 'createdAt' | 'updatedAt';
  sortDirection?: 'asc' | 'desc';
  pageSize?: number;
  conversationId?: string;
  messageId?: string;
  search?: string;
};

export type MessagesListResponse = {
  messages: s.TMessage[];
  nextCursor: string | null;
};

/* Shared Links */
export type SharedMessagesResponse = Omit<s.TSharedLink, 'messages'> & {
  messages: s.TMessage[];
};

export interface SharedLinksListParams {
  pageSize: number;
  isPublic: boolean;
  sortBy: 'title' | 'createdAt';
  sortDirection: 'asc' | 'desc';
  search?: string;
  cursor?: string;
}

export type SharedLinkItem = {
  shareId: string;
  title: string;
  isPublic: boolean;
  createdAt: Date;
  conversationId: string;
};

export interface SharedLinksResponse {
  links: SharedLinkItem[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface SharedLinkQueryData {
  pages: SharedLinksResponse[];
  pageParams: (string | null)[];
}

export type AllPromptGroupsFilterRequest = {
  category: string;
  pageNumber: string;
  pageSize: string | number;
  before?: string | null;
  after?: string | null;
  order?: 'asc' | 'desc';
  name?: string;
  author?: string;
};

export type AllPromptGroupsResponse = t.TPromptGroup[];

export type ConversationTagsResponse = s.TConversationTag[];

export type VerifyToolAuthParams = { toolId: string };
export type VerifyToolAuthResponse = { authenticated: boolean; message?: string | s.AuthType };

export type GetToolCallParams = { conversationId: string };
export type ToolCallResults = a.ToolCallResult[];

/* Principal Search */
export type PrincipalSearchParams = {
  q: string; // search query (required)
  limit?: number; // max results (1-50, default 10)
  type?: 'user' | 'group'; // filter by type (optional)
};

export type PrincipalSearchResult = {
  id: string | null; // null for Entra ID principals that don't exist locally yet
  type: 'user' | 'group';
  name: string;
  email?: string; // for users and groups
  username?: string; // for users
  avatar?: string; // for users and groups
  provider?: string; // for users
  source: 'local' | 'entra';
  memberCount?: number; // for groups
  description?: string; // for groups
  idOnTheSource?: string; // Entra ID for users (maps to openidId) and groups (maps to idOnTheSource)
};

export type PrincipalSearchResponse = {
  query: string;
  limit: number;
  type?: 'user' | 'group';
  results: PrincipalSearchResult[];
  count: number;
  sources: {
    local: number;
    entra: number;
  };
};
