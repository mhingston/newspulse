/** Search matches are untrusted discovery metadata, not verified article content. */
export interface SearchResult {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: number;
  observedAt?: number;
}

export interface SearchPage {
  results: SearchResult[];
  nextCursor?: string;
  /** The provider may have omitted additional results. */
  truncated: boolean;
}

export interface SearchProvider {
  readonly name: string;
  readonly version: string;
  search(input: {
    query: string;
    limit: number;
    cursor?: string;
  }): Promise<SearchPage>;
}
