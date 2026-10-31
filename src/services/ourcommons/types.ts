/** @fileoverview Parsed official House records. @module services/ourcommons/types */

/** A session advertised by the House divisions picker. */
export interface VoteSession {
  label: string;
  parliament: number;
  session: string;
  sessionNumber: number;
}
/**
 * One person's row in an official House roster, with source names retained for stable ordering.
 * A roster holds one row per person: for a Parliament, the caucus and riding last held there and
 * the span of that membership; in the all-Parliaments roster, the person's latest Parliament.
 */
export interface RosterMember {
  firstName: string;
  /** Membership start, `FromDateTime` as published; null when nil or blank. */
  from: string | null;
  lastName: string;
  name: string;
  /** Caucus; a blank source value is null. */
  party: string | null;
  personId: string;
  province: string | null;
  riding: string | null;
  /** Membership end, `ToDateTime` as published; null while sitting, or when nil or blank. */
  to: string | null;
  url: string;
}
/** Current official member. */
export interface OurCommonsMember extends RosterMember {
  current: true;
  detailLookup: { personId: string };
  slug: null;
}
/** Official division metadata; counts remain independent of participant filtering. */
export interface Division {
  billCode: string | null;
  dateTime: string | null;
  documentType: string | null;
  nays: number | null;
  number: number;
  paired: number | null;
  result: string | null;
  session: string;
  subject: string | null;
  url: string;
  yeas: number | null;
}
/** Official recorded ballot vocabulary; nonvoters have no ballot. */
export type RecordedBallot = 'Yea' | 'Nay' | 'Paired';
/** One recorded ballot; nonvoters are not inferred. */
export interface VoteParticipant {
  ballot: RecordedBallot;
  firstName: string;
  lastName: string;
  name: string;
  party: string | null;
  personId: string;
  province: string | null;
  riding: string | null;
  url: string;
}
/** One member's recorded ballot in a division, from that member's official votes feed. */
export interface MemberVote {
  ballot: RecordedBallot;
  billCode: string | null;
  dateTime: string | null;
  number: number;
  result: string | null;
  session: string;
  subject: string | null;
  url: string;
}
