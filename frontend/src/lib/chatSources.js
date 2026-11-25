import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Ask MEDIS source chips (step 11). The AI service attaches the DOM id of the
 * record each chip cites (backend/llm.py chat_context), and these helpers take
 * the patient to it: the page that renders that record, then a scroll and a
 * short highlight so it is obvious which card answered the question.
 */

// Where each anchor lives. The patient dashboard is the fallback, because the
// profile card, health summary, medications and appointments are all on it.
const PAGES = [
  [/^visit-|^visits$/, '/patient/visits'],
  [/^rx-|^prescriptions$/, '/patient/prescriptions'],
  [/^documents$/, '/patient/documents'],
];
const DEFAULT_PAGE = '/patient';

export function pageForAnchor(anchor) {
  return PAGES.find(([pattern]) => pattern.test(anchor))?.[1] ?? DEFAULT_PAGE;
}

const HIGHLIGHT_MS = 2200;

/** Scrolls to an anchor and highlights it. Returns false when it isn't on the page. */
export function scrollToAnchor(anchor) {
  const target = anchor && document.getElementById(anchor);
  if (!target) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('source-highlight');
  window.setTimeout(() => target.classList.remove('source-highlight'), HIGHLIGHT_MS);
  // Lists are long: make the cited row the next thing a keyboard or screen
  // reader user lands on, without stealing focus from the page scroll.
  if (target.tabIndex < 0) target.tabIndex = -1;
  target.focus?.({ preventScroll: true });
  return true;
}

// A cited record can be below a list that is still loading, so retry briefly.
const RETRY_MS = 120;
const RETRIES = 25;

export function revealAnchor(anchor) {
  if (!anchor) return;
  let left = RETRIES;
  const attempt = () => {
    if (scrollToAnchor(anchor) || left-- <= 0) return;
    window.setTimeout(attempt, RETRY_MS);
  };
  attempt();
}

/**
 * Reveals `#anchor` from the URL after a chip navigated to this page. Mounted
 * once for all patient pages (PatientLayout), so every page gets it.
 */
export function useRevealHash() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash.length > 1) revealAnchor(hash.slice(1));
  }, [pathname, hash]);
}
