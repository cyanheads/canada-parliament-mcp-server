/**
 * @fileoverview Public official bills service API.
 * @module services/legisinfo
 */
export {
  disposeLegisinfoService,
  getLegisinfoService,
  initLegisinfoService,
  LegisinfoService,
} from './legisinfo-service.js';
export type {
  BilingualText,
  BillDivision,
  BillDossier,
  BillSummary,
  LegisinfoReason,
  LegisinfoSession,
  Publication,
  SourceResult,
  Stage,
} from './types.js';
