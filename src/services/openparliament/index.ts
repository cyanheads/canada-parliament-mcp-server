/**
 * @fileoverview OpenParliament source service public API.
 * @module services/openparliament
 */
export {
  disposeOpenParliamentService,
  getOpenParliamentService,
  initOpenParliamentService,
  OpenParliamentService,
} from './openparliament-service.js';
export type {
  Ballot,
  BallotValue,
  Bill,
  BillInput,
  BillReference,
  Membership,
  PageInput,
  Politician,
  PoliticianInput,
  PoliticianProfile,
  SourcePage,
  SourceResult,
  Speech,
  SpeechInput,
  Vote,
} from './types.js';
