import { useEffect, useState } from 'react';

/**
 * React hook that tracks a CSS media query and returns whether it currently matches.
 * Falls back to a conservative `false` when window/matchMedia are unavailable
 * (e.g. prerender). Also debounces rapid changes by relying on the media query
 * listener instead of manual resize events.
 */
export function useMediaQuery(query: string): boolean {
  const getMatch = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  };

  const [matches, setMatches] = useState<boolean>(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => {};
    }

    const mq = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);

    // Update immediately in case the query result changed since the initial render.
    setMatches(mq.matches);

    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

