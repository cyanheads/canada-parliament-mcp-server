/** @fileoverview Parsed official House records. @module services/ourcommons/types */

/** A session advertised by the House divisions picker. */
export interface VoteSession {
  label: string;
  parliament: number;
  session: string;
  sessionNumber: number;
}
/** Current official member, with source names retained for stable ordering. */
export interface OurCommonsMember {
  current: true;
  detailLookup: { personId: string };
  firstName: string;
  lastName: string;
  name: string;
  party: string | null;
  personId: string;
  province: string | null;
  riding: string | null;
  slug: null;
  url: string;
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
