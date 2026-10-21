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
  BillDivision,
  BillDossier,
  BillSummary,
  LegisinfoSession,
  Publication,
  Stage,
} from './types.js';
