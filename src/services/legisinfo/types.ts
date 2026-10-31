/**
 * @fileoverview Parsed official LEGISinfo bill and session contracts.
 * @module services/legisinfo/types
 */
import type { BilingualText, JsonRecord } from '@/domain/schemas.js';

/** Canonical chamber; `House of Commons` and organization ID 1 are House, ID 2 is Senate. */
export type Chamber = 'House' | 'Senate';
/** A session advertised by the official picker. */
export interface LegisinfoSession {
  coverage: 'basic' | 'full';
  parliament: number;
  session: string;
  sessionNumber: number;
}
/** Official bill summary, independent of third-party indexing. */
export interface BillSummary {
  billCode: string;
  billType: string | null;
  latestMajorStage: { name: string | null; chamber: Chamber | null } | null;
  longTitle: BilingualText;
  originatingChamber: Chamber | null;
  royalAssentDate: string | null;
  session: string;
  shortTitle: BilingualText;
  status: string | null;
  url: string;
}
/** Official stage, retaining variable decisions and events verbatim. */
export interface Stage {
  chamber: Chamber | null;
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
/** Related document, press release, or costing note; URL values are relayed, never fetched. */
export interface WebReference {
  title: BilingualText;
  type: BilingualText;
  typeId: number | null;
  url: BilingualText;
}
/**
 * Reading date-times as the UTC instants of LEGISinfo's Ottawa wall clocks; royal assent is
 * `BillSummary.royalAssentDate`.
 */
export interface BillMilestones {
  houseFirstReading: string | null;
  houseSecondReading: string | null;
  houseThirdReading: string | null;
  senateFirstReading: string | null;
  senateSecondReading: string | null;
  senateThirdReading: string | null;
}
/** Complete normalized official dossier. */
export interface BillDossier {
  bill: BillSummary;
  divisions: BillDivision[] | null;
  milestones: BillMilestones;
  /** Plain text; each link keeps its target as `text (href)`. */
  notes: BilingualText;
  publications: Publication[] | null;
  senateVoteDetails: JsonRecord[] | null;
  sponsor: {
    name: string | null;
    personId: string | null;
    riding: string | null;
    title: BilingualText;
  };
  stages: { house: Stage[] | null; senate: Stage[] | null; royalAssent: Stage[] | null };
  statute: { year: number; chapter: string; citation: string } | null;
  /** Library of Parliament legislative summary as plain text. */
  summary: BilingualText;
  webReferences: WebReference[] | null;
}
