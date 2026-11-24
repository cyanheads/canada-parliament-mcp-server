/**
 * @fileoverview Captured DocumentViewer pages, redirects, and bill XML (www.parl.ca, 2026-11-23)
 * for bill-text tests. Bodies are verbatim; page files are each page's head, cut after the line
 * holding its first `publication-container` marker, past the XML export options.
 * @module tests/fixtures/bill-tools/bill-text
 */
import { readFileSync } from 'node:fs';

/**
 * - `S-2_1_E.xml` / `S-2_1_F.xml`: 45-1 S-2 at first reading (publication 13542656), whole.
 * - `C-202_4_E.xml`: 45-1 C-202 at Royal Assent (13577949), whole, pretty-printed.
 * - `C-15_1_E.xml`: 45-1 C-15 at first reading (13752361), trimmed by element: every body heading
 *   and section kept (196 and 606) with their labels and marginal notes; sections 1–3 whole;
 *   sections 125, 126, 190, 191, 223, 225, and 606 keep their first text line; section 224 keeps
 *   its first six enacted-Act children; the summary keeps its first provision (with `SR&amp;ED`);
 *   the table of provisions its first six entries; all six schedules whole.
 */
export type BillTextXml = 'S-2_1_E.xml' | 'S-2_1_F.xml' | 'C-202_4_E.xml' | 'C-15_1_E.xml';
/** DocumentViewer page heads: the export link, the 41-2 TOC export, and a PDF-only page. */
export type ViewerPage =
  | 'viewer-S-2-first-reading.html'
  | 'viewer-S-2-premiere-lecture.html'
  | 'viewer-C-202-royal-assent.html'
  | 'viewer-41-2-C-8-toc.html'
  | 'viewer-37-1-C-15A-pdf-only.html';

export const billTextFixture = (name: BillTextXml | ViewerPage): string =>
  readFileSync(new URL(`./text/${name}`, import.meta.url), 'utf8');

/** Captured `Location` values of the source's 302 responses. */
export const capturedRedirects = {
  /** `/DocumentViewer/en/13542656` */
  s2FirstReading: '/documentviewer/en/45-1/bill/S-2/first-reading',
  /** `/DocumentViewer/fr/13542656` */
  s2PremiereLecture: '/documentviewer/fr/45-1/projet-loi/S-2/premiere-lecture',
  /** `/DocumentViewer/en/13577949` */
  c202RoyalAssent: '/documentviewer/en/45-1/bill/C-202/royal-assent',
  /** `/DocumentViewer/en/6270288` */
  c8TocFirstReading: '/documentviewer/en/41-2/bill/C-8/first-reading',
  /** `/DocumentViewer/en/2336876` */
  c15aRoyalAssent: '/documentviewer/en/37-1/bill/C-15A/royal-assent',
  /** A publication ID the viewer does not know: no `StatusCode`. */
  viewerError:
    '/ErrorPage/Default.aspx?Url=https%3a%2f%2fwww.parl.ca%2fDocumentViewer%2fen%2f99999999',
  /** A `/Content/Bills/` path that does not exist. */
  xmlError:
    '/ErrorPage/Default.aspx?Url=https%3a%2f%2fwww.parl.ca%2fContent%2fBills%2f451%2fGovernment%2fS-2%2fS-2_9%2fS-2_E.xml&StatusCode=404',
} as const;

/** XML export targets the captured pages link. */
export const capturedXml = {
  s2En: 'https://www.parl.ca/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml',
  s2Fr: 'https://www.parl.ca/Content/Bills/451/Government/S-2/S-2_1/S-2_F.xml',
  c202En: 'https://www.parl.ca/Content/Bills/451/Private/C-202/C-202_4/C-202_E.xml',
} as const;
