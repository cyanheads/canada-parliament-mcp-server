/** @fileoverview Strict House source parsing contracts. @module tests/services/ourcommons/parsing.test */
import { describe, expect, it } from 'vitest';
import {
  parseMembers,
  parseMemberVotes,
  parseRoster,
  parseRosterParliaments,
  parseVoteParticipants,
  parseVoteSessions,
  parseVotes,
} from '@/services/ourcommons/parsing.js';
import { realMemberVotes, realRoster } from '../../fixtures/member-tools/harness.js';

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
  it('preserves the legacy picker selector, handles --!> and excludes all', () => {
    expect(
      parseVoteSessions(
        '<!-- comment --!><a data-input="parlSession" data-value="all">All</a><a data-input="parlsession" data-value="99-9">Wrong selector</a><a data-input="parlSession" data-value="45-1">  Example\n Session </a>',
      ),
    ).toEqual([{ session: '45-1', parliament: 45, sessionNumber: 1, label: 'Example Session' }]);
  });
  it('reads current House session choices without admitting other filters', () => {
    expect(
      parseVoteSessions(
        '<a data-input="s" data-value="all">All</a><a role="option" data-value="45-1" data-input="s">45th Parliament, 1st Session</a><a role="option" data-value="44-1" data-input="s">44th Parliament, 1st Session</a><a data-input="S" data-value="99-1">Other filter</a>',
      ),
    ).toEqual([
      { session: '45-1', parliament: 45, sessionNumber: 1, label: '45th Parliament, 1st Session' },
      { session: '44-1', parliament: 44, sessionNumber: 1, label: '44th Parliament, 1st Session' },
    ]);
  });
  it.each([
    '',
    '<a data-input="parlSession" data-value="45-0">Bad</a>',
    '<a data-input="parlSession" data-value="045-1">Bad</a>',
    '<a data-input="parlSession" data-value="45-1">One</a><a data-input="parlSession" data-value="45-1">Duplicate</a>',
    '<a data-input="s" data-value="45-0">Bad</a>',
    '<a data-input="s" data-value="045-1">Bad</a>',
    '<a data-input="s" data-value="45-1">One</a><a data-input="parlSession" data-value="45-1">Duplicate</a>',
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
      from: null,
      to: null,
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
  it.each([
    '<CaucusShortName />',
    '<CaucusShortName></CaucusShortName>',
    '<CaucusShortName> </CaucusShortName>',
  ])('reads a blank caucus %s on the current roster as no caucus', (caucus) =>
    expect(parseMembers(members(`${person}${caucus}`))[0]?.party).toBeNull(),
  );
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
  it('maps real Parliament roster rows with their membership span as published', () => {
    const rows = parseRoster(realRoster('p38'));
    expect(rows.map((row) => row.personId)).toEqual([
      '1463',
      '25469',
      '13',
      '192',
      '18',
      '29612',
      '25458',
    ]);
    expect(rows.find((row) => row.personId === '18')).toEqual({
      personId: '18',
      firstName: 'Lawrence',
      lastName: "O'Brien",
      name: "Lawrence O'Brien",
      party: 'Liberal',
      riding: 'Labrador',
      province: 'Newfoundland and Labrador',
      from: '2004-06-28T00:00:00',
      to: '2004-12-16T23:59:59',
      url: 'https://www.ourcommons.ca/Members/en/18',
    });
    expect(rows.find((row) => row.personId === '29612')).toMatchObject({
      riding: 'Labrador',
      from: '2005-05-24T00:00:00',
      to: '2006-01-22T23:59:00',
    });
    expect(parseRoster(realRoster('p36')).find((row) => row.personId === '1463')?.party).toBe(
      'Canadian Alliance',
    );
  });
  it.each<[string, string]>([
    ['p41', '71465'],
    ['p36', '880'],
  ])('reads the real blank caucus in %s row %s as no caucus', (name, personId) => {
    const row = parseRoster(realRoster(name as 'p41' | 'p36')).find(
      (entry) => entry.personId === personId,
    );
    expect(row).toMatchObject({ party: null, from: expect.any(String), to: expect.any(String) });
  });
  it('reads a sitting member nil ToDateTime and omitted optional fields as null', () => {
    const current = parseMembers(realRoster('current'));
    expect(current.map(({ personId, from, to }) => ({ personId, from, to }))).toEqual([
      { personId: '89156', from: '2025-04-28T00:00:00', to: null },
      { personId: '72029', from: '2025-04-28T00:00:00', to: null },
    ]);
    const sparse = realRoster('p45')
      .replace('<ConstituencyName>Scarborough Southwest</ConstituencyName>', '')
      .replace('<CaucusShortName>Liberal</CaucusShortName>', '')
      .replace(
        '<FromDateTime>2025-04-28T00:00:00</FromDateTime><ToDateTime>2026',
        '<ToDateTime>2026',
      );
    expect(parseRoster(sparse).find((row) => row.personId === '88961')).toEqual({
      personId: '88961',
      firstName: 'Bill',
      lastName: 'Blair',
      name: 'Bill Blair',
      party: null,
      riding: null,
      province: 'Ontario',
      from: null,
      to: '2026-02-02T16:00:00',
      url: 'https://www.ourcommons.ca/Members/en/88961',
    });
  });
  it('reads the real empty roster of an unlisted Parliament as no rows', () =>
    expect(parseRoster(realRoster('empty'))).toEqual([]));
  it('rejects a duplicate person in a Parliament roster as malformed', () => {
    const xml = realRoster('p38');
    const first = xml.slice(
      xml.indexOf('<MemberOfParliament>'),
      xml.indexOf('</MemberOfParliament>') + 21,
    );
    expect(() =>
      parseRoster(
        xml.replace('</ArrayOfMemberOfParliament>', `${first}</ArrayOfMemberOfParliament>`),
      ),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'upstream_response_invalid',
          field: 'duplicate identity',
        }),
      }),
    );
  });
  it('reads the real roster Parliament picker, ignoring All, Current Members, and other dropdowns', () => {
    expect(parseRosterParliaments(realRoster('picker'))).toEqual([
      45, 44, 43, 42, 41, 40, 39, 38, 37, 36,
    ]);
    expect(
      parseRosterParliaments(
        '<!-- comment --!><a data-input="p" data-value="*">All</a><a data-input="P" data-value="99">Other</a><a data-input="p" data-value="7">7th</a>',
      ),
    ).toEqual([7]);
  });
  it.each([
    '',
    realRoster('picker').replaceAll('data-input="p"', 'data-input="q"'),
    '<a data-input="p" data-value="*">All</a><a data-input="p" data-value="cr">Current</a>',
    ...['045', '0', '-1', '4.5', '1e2', ' 45', 'abc', '', '9007199254740992'].map(
      (value) =>
        `<a data-input="p" data-value="45">45</a><a data-input="p" data-value="${value}">x</a>`,
    ),
    '<a data-input="p" data-value="45">45</a><a data-input="p" data-value="45">again</a>',
  ])('rejects an invalid roster picker %#', (html) =>
    expect(() => parseRosterParliaments(html)).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
      }),
    ),
  );
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
  it.each(['C-15A', 'C-23B', 'S-1001'])('reads split-bill or plain bill code %s', (code) =>
    expect(
      parseVotes(votes(`${identity}<BillNumberCode>${code}</BillNumberCode>`), '45-1')[0]?.billCode,
    ).toBe(code),
  );
  it.each(['C-15AB', 'C-15A1', 'C-15a', 'C-015', 'C-A'])('rejects malformed bill code %s', (code) =>
    expect(() =>
      parseVotes(votes(`${identity}<BillNumberCode>${code}</BillNumberCode>`), '45-1'),
    ).toThrow(),
  );
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

describe('member votes feed parsing', () => {
  const may = realMemberVotes('2897-45-1');
  /** The real feed with its first occurrence of `from` replaced. */
  const edit = (from: string, to: string) => may.replace(from, to);
  const firstRow = may.slice(may.indexOf('<MemberVote>'), may.indexOf('</MemberVote>') + 13);
  it('maps every real 2897 45-1 row in feed order with its division metadata', () => {
    const rows = parseMemberVotes(may, '2897');
    expect(rows).toHaveLength(25);
    expect(rows.map((row) => row.number).slice(0, 12)).toEqual([
      179, 178, 177, 176, 175, 174, 173, 172, 171, 170, 169, 159,
    ]);
    expect(rows[0]).toEqual({
      session: '45-1',
      number: 179,
      dateTime: '2026-10-20T15:15:00',
      subject: 'Opposition Motion (Affordability crisis)',
      result: 'Negatived',
      billCode: null,
      ballot: 'Yea',
      url: 'https://www.ourcommons.ca/Members/en/votes/45/1/179',
    });
    expect(rows[1]).toMatchObject({
      number: 178,
      billCode: 'C-39',
      ballot: 'Nay',
      result: 'Agreed To',
    });
    expect(rows.filter((row) => row.billCode === 'C-15').map((row) => row.number)).toEqual([
      82, 81, 80, 79, 78, 77, 75, 53,
    ]);
    expect(new Set(rows.map((row) => row.session))).toEqual(new Set(['45-1']));
    expect(parseMemberVotes(may, '2897', '45-1')).toEqual(rows);
  });
  it('reads the session the feed chooses when none is requested', () => {
    const rows = parseMemberVotes(realMemberVotes('35933-latest'), '35933');
    expect(rows.map(({ session, number, billCode }) => ({ session, number, billCode }))).toEqual([
      { session: '41-2', number: 467, billCode: 'S-2' },
      { session: '41-2', number: 466, billCode: 'S-4' },
      { session: '41-2', number: 465, billCode: 'S-4' },
    ]);
  });
  it('reads real Paired ballots with consistent flags', () => {
    expect(
      parseMemberVotes(realMemberVotes('88721-45-1'), '88721', '45-1').map((row) => row.ballot),
    ).toEqual(['Paired', 'Paired', 'Yea']);
  });
  it('reads the real empty body for a session the member did not sit in', () => {
    expect(parseMemberVotes(realMemberVotes('empty'), '2897', '39-1')).toEqual([]);
  });
  it('keeps a nil date-time and an absent subject as null', () => {
    const sparse = edit(
      '<DecisionEventDateTime>2026-10-20T15:15:00</DecisionEventDateTime>',
      '<DecisionEventDateTime xsi:nil="true" />',
    ).replace(
      '<DecisionDivisionSubject>Opposition Motion (Affordability crisis)</DecisionDivisionSubject>',
      '',
    );
    expect(parseMemberVotes(sparse, '2897')[0]).toMatchObject({
      number: 179,
      dateTime: null,
      subject: null,
    });
  });
  it.each<[string, string, string, string | undefined]>([
    ['another person', may, '2898', undefined],
    ['a different requested session', may, '2897', '44-1'],
    ['two sessions in one feed', edit('<SessionNumber>1<', '<SessionNumber>2<'), '2897', undefined],
    ['an unknown ballot', edit('>Yea</VoteValueName>', '>Yes</VoteValueName>'), '2897', undefined],
    ['a conflicting flag', edit('<IsVoteNay>false<', '<IsVoteNay>true<'), '2897', undefined],
    [
      'a duplicate division',
      edit('</ArrayOfMemberVote>', `${firstRow}</ArrayOfMemberVote>`),
      '2897',
      undefined,
    ],
    [
      'a malformed bill code',
      edit('>C-39</BillNumberCode>', '>C-039</BillNumberCode>'),
      '2897',
      undefined,
    ],
    ['a malformed date-time', edit('2026-10-20T15:15:00', '20 Oct 2026 15:15'), '2897', undefined],
    [
      'a missing division number',
      edit('<DecisionDivisionNumber>179</DecisionDivisionNumber>', ''),
      '2897',
      undefined,
    ],
  ])('rejects %s as a malformed response without retry', (_name, xml, personId, session) => {
    expect(() => parseMemberVotes(xml, personId, session)).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'upstream_response_invalid', retryable: false }),
      }),
    );
  });
});
