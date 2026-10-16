// Optional LinkedIn profile suggestions via the Brave Search API (an allowed, documented search API).
// No LinkedIn login, no scraping of LinkedIn pages, no guessed profile URLs. Results are candidates only;
// a person must confirm one before it is stored on the contact.
import type { LinkedInCandidate } from '../shared/types.ts';

export const linkedinProvider = () => (process.env.BRAVE_SEARCH_API_KEY ? 'Brave Search API' : null);

export function manualSearchUrls(name: string, company: string) {
  const q = [name, company].filter(Boolean).join(' ');
  return {
    linkedin: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`,
    web: `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in ${q}`)}`,
  };
}

export class SearchError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export async function searchLinkedIn(name: string, company: string): Promise<LinkedInCandidate[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new SearchError('Automatic LinkedIn search is not configured (no BRAVE_SEARCH_API_KEY). Use the manual search links.', 501);
  if (!name.trim()) throw new SearchError('Add the person’s name first.', 400);
  const q = `site:linkedin.com/in "${name.trim()}" ${company.trim()}`.trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(q)}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new SearchError(
      (e as Error).name === 'AbortError'
        ? 'The search provider did not answer within 10 seconds. Try again later.'
        : 'Could not reach the search provider (offline?).',
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new SearchError('The search API key was rejected. Check BRAVE_SEARCH_API_KEY in your .env file.', 502);
  if (res.status === 429) throw new SearchError('Search quota or rate limit reached. Try again later.', 429);
  if (!res.ok) throw new SearchError(`The search provider returned an error (${res.status}).`);
  const data = (await res.json()) as { web?: { results?: { url: string; title: string; description?: string }[] } };
  const now = new Date().toISOString();
  return (data.web?.results ?? [])
    .filter((r) => /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#]+\/?$/i.test(r.url.split('?')[0]))
    .slice(0, 6)
    .map((r) => ({
      url: r.url.split('?')[0].replace(/\/$/, ''),
      title: r.title.replace(/<[^>]+>/g, ''),
      snippet: (r.description ?? '').replace(/<[^>]+>/g, ''),
      source: 'Brave Search',
      foundAt: now,
    }));
}
