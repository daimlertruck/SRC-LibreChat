/**
 * Sorts page numbers by their relevance scores in descending order (highest first)
 * @param pages - Array of page numbers to sort
 * @param pageRelevance - Object mapping page numbers to relevance scores
 * @returns Sorted array of page numbers
 */
export function sortPagesByRelevance(
  pages: number[],
  pageRelevance?: Record<number, number>,
): number[] {
  if (!pageRelevance || Object.keys(pageRelevance).length === 0) {
    return pages; // Return original order if no relevance data
  }

  return [...pages].sort((a, b) => {
    const relevanceA = pageRelevance[a] || 0;
    const relevanceB = pageRelevance[b] || 0;
    return relevanceB - relevanceA; // Highest relevance first
  });
}
