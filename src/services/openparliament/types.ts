/**
 * @fileoverview Parsed OpenParliament records and bounded source requests.
 * @module services/openparliament/types
 */
import type { BilingualText, Source } from '@/domain/schemas.js';

/** An upstream page, with a validated continuation rather than a fetchable URL. */
export interface SourcePage<T> {
  nextOffset: number | null;
  objects: T[];
  provenance: Source[];
}
/** Public politician index row; current attributes are not historical affiliations. */
export interface Politician {
  imageUrl: string | null;
  name: string;
  party: string | null;
  province: string | null;
  riding: string | null;
  slug: string;
  url: string;
}
/** Historical membership, not a projection of the current roster. */
export interface Membership {
  endDate: string | null;
  label: string | null;
  party: { name: string | null; shortName: string | null };
  politicianUrl: string | null;
  province: string | null;
  riding: string | null;
  startDate: string | null;
  url: string;
}
/** Profile fields needed for verified identity and historical attribution. */
export interface PoliticianProfile extends Politician {
  alternateNames: string[];
  familyName: string | null;
  gender: string | null;
  givenName: string | null;
  links: { url: string; note: string | null }[];
  memberships: Membership[] | null;
  personIds: string[] | null;
}
/** Bill identity and source-specific wording. */
export interface Bill {
  billCode: string;
  legisinfoId: string | null;
  session: string;
  status: string | null;
  title: BilingualText;
  url: string;
}
/** OpenParliament ballot vocabulary stays distinct from official Yea/Nay. */
export type BallotValue = 'Yes' | 'No' | 'Paired' | "Didn't vote";
/** One member's ballot; the vote endpoint supplies its subject and date. */
export interface Ballot {
  ballot: BallotValue;
  membershipUrl: string | null;
  politicianUrl: string;
  voteUrl: string;
}
/** Source vote detail. */
export interface Vote {
  date: string | null;
  number: number;
  result: string | null;
  session: string;
  subject: string | null;
  url: string;
}
/**
 * Candidate speech with its attribution, headings, and complete plain text in both languages, and a
 * historical membership reference. A language without text is null there, never the other's text.
 */
export interface Speech {
  content: BilingualText;
  debateUrl: string | null;
  h1: BilingualText;
  h2: BilingualText;
  id: string;
  membershipUrl: string | null;
  politician: string | null;
  procedural: boolean | null;
  speaker: BilingualText;
  time: string;
  url: string;
}
/** Pagination fields shared by source list requests. */
export interface PageInput {
  limit: number;
  offset: number;
}
/** Politician index filters supported by the upstream. */
export interface PoliticianInput extends PageInput {
  familyName?: string;
  include: 'all' | 'current';
  name?: string;
}
/** Sponsor index filters. */
export interface BillInput extends PageInput {
  session?: string;
  sponsor: string;
}
/** Canonical bill reference for speech relationships. */
export interface BillReference {
  code: string;
  session: string;
}
/** Speech scope; contains is intentionally a tool-level scan filter. */
export interface SpeechInput extends PageInput {
  billDebated?: BillReference;
  dateFrom?: string;
  dateTo?: string;
  mentionedBill?: BillReference;
  politician?: string;
  substantiveOnly: boolean;
}
