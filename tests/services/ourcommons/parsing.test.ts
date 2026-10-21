/** @fileoverview Strict House source parsing contracts. @module tests/services/ourcommons/parsing.test */
import { describe, expect, it } from 'vitest';
import {
  parseMembers,
  parseVoteParticipants,
  parseVoteSessions,
  parseVotes,
} from '@/services/ourcommons/parsing.js';

const person =
  '<PersonId>9001</PersonId><PersonOfficialFirstName>River</PersonOfficialFirstName><PersonOfficialLastName>Example</PersonOfficialLastName>';
const identity =
  '<ParliamentNumber>45</ParliamentNumber><SessionNumber>1</SessionNumber><DecisionDivisionNumber>901</DecisionDivisionNumber>';
const members = (row = person) =>
  `<ArrayOfMemberOfParliament><MemberOfParliament>${row}</MemberOfParliament></ArrayOfMemberOfParliament>`;
const votes = (row = identity) => `<ArrayOfVote><Vote>${row}</Vote></ArrayOfVote>`;
const ballots = (extra = '<VoteValueName>Yea</VoteValueName>') =>
  `<ArrayOfVoteParticipant><VoteParticipant>${person}${identity}${extra}</VoteParticipant></ArrayOfVoteParticipant>`;

describe('House source parsing', () => {
  it('uses the case-sensitive live picker selector, handles --!> and excludes all', () => {
    expect(
      parseVoteSessions(
        '<!-- comment --!><a data-input="parlSession" data-value="all">All</a><a data-input="parlsession" data-value="99-9">Wrong selector</a><a data-input="parlSession" data-value="45-1">  Example\n Session </a>',
      ),
    ).toEqual([{ session: '45-1', parliament: 45, sessionNumber: 1, label: 'Example Session' }]);
  });
  it.each([
    '',
    '<a data-input="parlSession" data-value="45-0">Bad</a>',
    '<a data-input="parlSession" data-value="045-1">Bad</a>',
    '<a data-input="parlSession" data-value="45-1">One</a><a data-input="parlSession" data-value="45-1">Duplicate</a>',
  ])('rejects invalid picker %s', (html) => {
    expect(() => parseVoteSessions(html)).toThrow();
  });
  it('normalizes singleton member records without inventing optional facts', () => {
    expect(parseMembers(members())[0]).toEqual({
      personId: '9001',
      firstName: 'River',
      lastName: 'Example',
      name: 'River Example',
      party: null,
      riding: null,
      province: null,
      url: 'https://www.ourcommons.ca/Members/en/9001',
      current: true,
      slug: null,
      detailLookup: { personId: '9001' },
    });
    expect(
      parseMembers(
        members(`${person}<CaucusShortName xsi:nil="true"/><ConstituencyName xsi:nil="1"/>`),
      )[0]?.party,
    ).toBeNull();
  });
  it('decodes predefined and numeric references exactly once', () => {
    const xml = members(
      person.replace(
        'River',
        'A &amp;lt; B &lt; C &gt; D &quot;Q&quot; &apos;P&apos; &#65; &#x1F331;',
      ),
    );
    expect(parseMembers(xml)[0]?.firstName).toBe('A &lt; B < C > D "Q" \'P\' A 🌱');
  });
  it.each([
    '<ArrayOfMemberOfParliament/>',
    '<ArrayOfMemberOfParliament></ArrayOfMemberOfParliament>',
    '<ArrayOfMemberOfParliament xmlns:xsi="urn:synthetic"/>',
  ])('accepts empty roster %s', (xml) => expect(parseMembers(xml)).toEqual([]));
  it.each([
    '<!DOCTYPE ArrayOfMemberOfParliament [<!ENTITY x "expanded">]>',
    '<!DOCTYPE ArrayOfMemberOfParliament SYSTEM "file:///synthetic">',
  ])('rejects DTD/entity declarations without resolving them', (prefix) =>
    expect(() => parseMembers(prefix + members())).toThrow(),
  );
  it('rejects undeclared custom entities', () =>
    expect(() => parseMembers(members(person.replace('River', '&custom;')))).toThrow());
  it.each(['', '0', '-1', '1.5', 'NaN', '9007199254740992'])(
    'rejects malformed person identity %s',
    (value) => expect(() => parseMembers(members(person.replace('9001', value)))).toThrow(),
  );
  it.each([
    members(person.replace('<PersonOfficialFirstName>River</PersonOfficialFirstName>', '')),
    '<ArrayOfMemberOfParliament xsi:nil="true"/>',
    '<ArrayOfMemberOfParliament><Unexpected/></ArrayOfMemberOfParliament>',
    members().replace('</ArrayOfMemberOfParliament>', ''),
  ])('rejects missing identities and malformed XML', (xml) =>
    expect(() => parseMembers(xml)).toThrow(),
  );
  it('rejects duplicate member identities', () =>
    expect(() =>
      parseMembers(
        `<ArrayOfMemberOfParliament><MemberOfParliament>${person}</MemberOfParliament><MemberOfParliament>${person}</MemberOfParliament></ArrayOfMemberOfParliament>`,
      ),
    ).toThrow());
  it('retains sparse tallies as null and a real zero as zero', () => {
    expect(
      parseVotes(
        votes(
          `${identity}<DecisionDivisionNumberOfYeas>0</DecisionDivisionNumberOfYeas><DecisionDivisionNumberOfNays xsi:nil="true"/><BillNumberCode/>`,
        ),
        '45-1',
      )[0],
    ).toEqual({
      session: '45-1',
      number: 901,
      dateTime: null,
      subject: null,
      result: null,
      yeas: 0,
      nays: null,
      paired: null,
      documentType: null,
      billCode: null,
      url: 'https://www.ourcommons.ca/Members/en/votes/45/1/901',
    });
    expect(parseVotes('<ArrayOfVote/>', '45-1')).toEqual([]);
  });
  it.each(['', '-1', '2.3', 'true'])('rejects malformed optional tally %s', (value) =>
    expect(() =>
      parseVotes(
        votes(`${identity}<DecisionDivisionNumberOfYeas>${value}</DecisionDivisionNumberOfYeas>`),
        '45-1',
      ),
    ).toThrow(),
  );
  it('rejects wrong sessions and duplicate division numbers', () => {
    expect(() => parseVotes(votes(), '44-1')).toThrow();
    expect(() =>
      parseVotes(
        `<ArrayOfVote><Vote>${identity}</Vote><Vote>${identity}</Vote></ArrayOfVote>`,
        '45-1',
      ),
    ).toThrow();
  });
  it.each(['Yea', 'Nay', 'Paired'])('maps %s ballots and consistent boolean scalars', (ballot) => {
    const flags = ['Yea', 'Nay', 'Paired']
      .map((value) => `<IsVote${value}>${value === ballot ? '1' : 'false'}</IsVote${value}>`)
      .join('');
    expect(
      parseVoteParticipants(
        ballots(`<VoteValueName>${ballot}</VoteValueName>${flags}`),
        '45-1',
        901,
      )[0]?.ballot,
    ).toBe(ballot);
  });
  it.each([
    '<VoteValueName>Yes</VoteValueName>',
    '<VoteValueName>Yea</VoteValueName><IsVoteNay>true</IsVoteNay>',
    '<VoteValueName>Yea</VoteValueName><IsVoteYea>yes</IsVoteYea>',
  ])('rejects invalid or conflicting ballot flags', (extra) =>
    expect(() => parseVoteParticipants(ballots(extra), '45-1', 901)).toThrow(),
  );
  it('rejects wrong ballot session, number, and duplicate people', () => {
    expect(() => parseVoteParticipants(ballots(), '44-1', 901)).toThrow();
    expect(() => parseVoteParticipants(ballots(), '45-1', 902)).toThrow();
    expect(() =>
      parseVoteParticipants(
        ballots().replace(
          '</ArrayOfVoteParticipant>',
          `<VoteParticipant>${person}${identity}<VoteValueName>Nay</VoteValueName></VoteParticipant></ArrayOfVoteParticipant>`,
        ),
        '45-1',
        901,
      ),
    ).toThrow();
    expect(parseVoteParticipants('<ArrayOfVoteParticipant/>', '45-1', 901)).toEqual([]);
  });
});
