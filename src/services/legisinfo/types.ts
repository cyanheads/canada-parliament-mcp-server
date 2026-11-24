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
/** A message or amendment exchange between the chambers, from `BillStages.InterChamberMessages`. */
export interface InterChamberMessage {
  /** Chamber that recorded the event. */
  chamber: Chamber | null;
  /** Ottawa wall-clock date-time as published, without an offset. */
  dateTime: string | null;
  name: BilingualText;
  /** That chamber's sitting number as published. */
  sittingNumber: string | null;
}
/**
 * The bill a reinstated bill came from or became. `session` is the same Parliament's previous or
 * next session when the official session index lists it; `billCode` is null when the dossier
 * flags the reinstatement without naming the bill.
 */
export interface ReinstatementLink {
  billCode: string | null;
  session: string | null;
}
/** LEGISinfo's reinstatement flags; a bill reinstated by government motion carries neither. */
export interface Reinstatement {
  as: ReinstatementLink | null;
  from: ReinstatementLink | null;
}
/** Complete normalized official dossier. */
export interface BillDossier {
  bill: BillSummary;
  divisions: BillDivision[] | null;
  interChamberMessages: InterChamberMessage[] | null;
  milestones: BillMilestones;
  /** Plain text; each link keeps its target as `text (href)`. */
  notes: BilingualText;
  publications: Publication[] | null;
  reinstatement: Reinstatement;
  senateVoteDetails: JsonRecord[] | null;
  /** Earlier or related versions, newest session first, then by bill code. */
  similarBills: BillSummary[] | null;
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
/** Language of a bill version's text: the DocumentViewer page and its `_E.xml` or `_F.xml`. */
export type BillTextLanguage = 'en' | 'fr';
/**
 * Every text field below is plain text: one line per block, a label opening its line, table cells
 * joined by ` | `, inline markup as its text. Explanatory notes (existing-text annotations, never
 * enacted text) are kept apart from `text`.
 */
export interface BillTextIntroduction {
  /** Enacting clause (`Enacts`). */
  enactingClause: string | null;
  explanatoryNotes: string | null;
  preamble: string | null;
  /** Royal recommendation. */
  recommendation: string | null;
  summary: string | null;
}
/** A top-level body heading and the run of body sections it spans. */
export interface BillTextHeading {
  /** Sum of the `text` lengths (UTF-16 code units) of the spanned sections. */
  characters: number;
  /** The heading's `MarginalNote` (its `HistoricalNote` citation). */
  citation: string | null;
  /** Body-section count from `offset` up to the next heading of the same or a higher level. */
  count: number;
  firstLabel: string | null;
  /** Position in the headings list. */
  index: number;
  label: string | null;
  lastLabel: string | null;
  /** Positive heading depth; 1 is outermost. */
  level: number;
  /** Index of the first body section after this heading. */
  offset: number;
  title: string | null;
}
/** One top-level body section, never split. */
export interface BillTextSection {
  explanatoryNotes: string | null;
  /** Enclosing heading path, outermost first; each entry is the heading's label and title. */
  headings: string[];
  label: string | null;
  marginalNote: string | null;
  text: string | null;
}
/** One top-level schedule; a nested schedule is part of its text. */
export interface BillTextSchedule {
  explanatoryNotes: string | null;
  label: string | null;
  originatingRef: string | null;
  text: string | null;
}
/** A bill version's text as read from its official XML, verified against the request. */
export interface BillTextDocument {
  billCode: string;
  body: BillTextSection[];
  headings: BillTextHeading[];
  introduction: BillTextIntroduction;
  language: BillTextLanguage;
  longTitle: string | null;
  schedules: BillTextSchedule[];
  session: string;
  shortTitle: string | null;
  /** `BillSponsor` as printed; absent on Royal Assent versions. */
  sponsor: string | null;
  /** `Stages@stage` as published, such as `first-reading-senate` or `assented-to`. */
  stage: string | null;
  /** The stage date, `YYYY-MM-DD`. */
  stageDate: string | null;
}
/** A publication's text with the official references it was read from. */
export interface BillText extends BillTextDocument {
  publicationId: number;
  /** DocumentViewer page in the text's language. */
  url: string;
  xmlUrl: string;
}
