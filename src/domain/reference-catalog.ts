/**
 * @fileoverview Bundled source-specific vocabulary, supplemented by observed feeds.
 * @module domain/reference-catalog
 */
import { vocabularyKey } from './normalization.js';
/** Documented official bill types. */
export const BILL_TYPES = [
  'House Government Bill',
  'Private Member’s Bill',
  'Senate Government Bill',
  'Senate Private Bill',
  'Senate Public Bill',
] as const;
/** Initial official bill statuses; observations may extend this list. */
export const BILL_STATUSES = [
  'Outside the Order of Precedence',
  'Royal assent received',
  'At second reading in the House of Commons',
  'At consideration in committee in the House of Commons',
  'At consideration in committee in the Senate',
  'At second reading in the Senate',
  'At report stage in the House of Commons',
  'Bill defeated',
  'At third reading in the House of Commons',
  'At third reading in the Senate',
  'Senate bill awaiting first reading in the House of Commons',
  'House of Commons bill awaiting first reading in the Senate',
  'Introduced as pro forma bill',
] as const;
/** Official division result vocabulary. */
export const VOTE_RESULTS = ['Agreed To', 'Negatived', 'Tie'] as const;
/** Certain OpenParliament-to-official result aliases, only at filter boundaries. */
export const VOTE_RESULT_ALIASES: Readonly<Record<string, string>> = {
  Passed: 'Agreed To',
  Failed: 'Negatived',
};
/** Official House division document categories. */
export const VOTE_DOCUMENT_TYPES = [
  'Legislative Process',
  'Supply',
  'Report Stage',
  'Other',
  'Government Business',
  'Routine Proceedings',
  'Ways and means',
  'Address in Reply',
  "Private Members' Motions",
] as const;
/** Initial official caucuses, not an exhaustive historical list. */
export const PARTIES = ['Liberal', 'Conservative', 'Bloc Québécois', 'NDP', 'Green Party'] as const;
/** Certain OpenParliament-to-official caucus aliases, only at filter boundaries. */
export const OFFICIAL_PARTY_ALIASES: Readonly<Record<string, string>> = {
  Bloc: 'Bloc Québécois',
  Green: 'Green Party',
};
/** Official recorded House ballot vocabulary; nonvoters have no ballot. */
export const BALLOTS = ['Yea', 'Nay', 'Paired'] as const;
/** Certain OpenParliament-to-official ballot aliases, only at filter boundaries. */
export const OFFICIAL_BALLOT_ALIASES: Readonly<Record<string, string>> = {
  Yes: 'Yea',
  No: 'Nay',
};
/** Extend catalog labels with distinct nonblank upstream observations. */
export function extendVocabulary(
  catalog: readonly string[],
  observed: readonly (string | null)[],
): string[] {
  const values = new Map(catalog.map((value) => [vocabularyKey(value), value]));
  for (const value of observed)
    if (value?.trim() && !values.has(vocabularyKey(value)))
      values.set(vocabularyKey(value), value.trim());
  return [...values.values()];
}
