/**
 * @fileoverview Parsed official LEGISinfo bill and session contracts.
 * @module services/legisinfo/types
 */
import type { JsonRecord, Source } from '@/domain/schemas.js';

/** Source-preserving bilingual text. */
export interface BilingualText {
  en: string | null;
  fr: string | null;
}
/** A session advertised by the official picker. */
export interface LegisinfoSession {
  coverage: 'basic' | 'full';
  parliament: number;
  session: string;
  sessionNumber: number;
}
/** Parsed result with retrieval provenance. */
export interface SourceResult<T> {
  data: T;
  provenance: Source[];
}
/** Official bill summary, independent of third-party indexing. */
export interface BillSummary {
  billCode: string;
  billType: string | null;
  latestMajorStage: { name: string | null; chamber: string | null } | null;
  longTitle: BilingualText;
  originatingChamber: 'House' | 'Senate' | null;
  royalAssentDate: string | null;
  session: string;
  shortTitle: BilingualText;
  status: string | null;
  url: string;
}
/** Official stage, retaining variable decisions and events verbatim. */
export interface Stage {
  chamber: 'House' | 'Senate' | null;
  committee: { id: number | null; acronym: string | null; name: BilingualText } | null;
  committeeMeetings:
    | {
        number: string | null;
        date: string | null;
        committeeId: number | null;
        acronym: string | null;
        name: BilingualText;
      }[]
    | null;
  decisions: JsonRecord[] | null;
  endOfStageEvent: JsonRecord | null;
  id: number;
  name: BilingualText;
  significantEvents: JsonRecord[] | null;
  sittings:
    | {
        number: string | null;
        date: string | null;
        name: BilingualText;
        published: boolean | null;
      }[]
    | null;
  state: { id: number | null; en: string | null; fr: string | null };
  stateAsOf: string | null;
}
/** House division linked from a verified bill. */
export interface BillDivision {
  dateTime: string | null;
  nays: number | null;
  number: number;
  paired: number | null;
  result: string | null;
  session: string;
  subject: BilingualText;
  total: number | null;
  url: string;
  yeas: number | null;
}
/** Official document viewer reference. */
export interface Publication {
  id: number;
  type: BilingualText;
  typeId: number | null;
  url: string;
}
/** Complete normalized official dossier. */
export interface BillDossier {
  bill: BillSummary;
  divisions: BillDivision[] | null;
  publications: Publication[] | null;
  senateVoteDetails: JsonRecord[] | null;
  sponsor: { name: string | null; personId: string | null; riding: string | null };
  stages: { house: Stage[] | null; senate: Stage[] | null; royalAssent: Stage[] | null };
  statute: { year: number; chapter: string; citation: string } | null;
}
/** Domain failures consumed by tool error contracts. */
export type LegisinfoReason =
  | 'unknown_session'
  | 'invalid_bill_code'
  | 'bill_not_found'
  | 'upstream_response_invalid';
