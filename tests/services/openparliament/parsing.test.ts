/**
 * @fileoverview Synthetic OpenParliament sparse records and continuation contracts.
 * @module tests/services/openparliament/parsing.test
 */
import { describe, expect, it } from 'vitest';
import { htmlToText } from '@/domain/html-to-text.js';
import {
  parseBallot,
  parseBill,
  parseJson,
  parseMembership,
  parsePage,
  parsePolitician,
  parsePoliticianProfile,
  parseSpeech,
  parseVote,
} from '@/services/openparliament/parsing.js';
import { lawrenceCannon } from '../../fixtures/member-tools/harness.js';
import { hansard } from '../../fixtures/speech-tools/harness.js';

const actor = { name: 'Synthetic Member', url: '/politicians/synthetic-member/' };
const membership = {
  url: '/politicians/memberships/901/',
  party: { name: { en: 'Historical Party' }, short_name: { en: 'HP' } },
  riding: { name: { en: 'Old Riding' }, province: 'QC' },
  start_date: '2001-01-01',
  end_date: '2005-01-01',
  politician_url: actor.url,
};
const bill = { url: '/bills/45-1/C-901/', session: '45-1', number: 'C-901' };
const vote = { url: '/votes/45-1/901/', session: '45-1', number: 901 };
const ballot = { vote_url: vote.url, politician_url: actor.url, ballot: 'Yes' };
const speech = { url: '/debates/2026/10/20/1/', time: '2026-10-20 12:30:00' };

describe('OpenParliament source records', () => {
  it('retains only usable published alias strings as identity evidence', () => {
    expect(
      parsePoliticianProfile({
        ...actor,
        other_info: {
          alternate_name: ['Judy A. Sgro', 'judy sgro', null, 12, {}, ''],
        },
      }),
    ).toMatchObject({ alternateNames: ['Judy A. Sgro', 'judy sgro'] });
  });
  it.each([42, {}, [null, 12, { name: 'irrelevant' }]])(
    'accepts otherwise valid profiles with irrelevant optional alias data %j',
    (alternate_name) => {
      expect(parsePoliticianProfile({ ...actor, other_info: { alternate_name } })).toMatchObject({
        name: actor.name,
        slug: 'synthetic-member',
      });
    },
  );
  it('preserves sparse historical index and profile uncertainty', () => {
    expect(parsePolitician(actor)).toEqual({
      slug: 'synthetic-member',
      name: actor.name,
      url: `https://openparliament.ca${actor.url}`,
      party: null,
      riding: null,
      province: null,
      imageUrl: null,
    });
    expect(parsePoliticianProfile(actor)).toMatchObject({
      personIds: null,
      memberships: null,
      links: [],
      givenName: null,
      familyName: null,
      gender: null,
    });
  });
  it('retains nested historical memberships without projecting current affiliation or contact data', () => {
    const result = parsePoliticianProfile({
      ...actor,
      current_party: { short_name: { en: 'Now' } },
      other_info: { parl_mp_id: ['901', '902'], email: ['private@example.test'] },
      memberships: [membership, { url: '/politicians/memberships/902/' }],
      links: [{ url: 'https://example.test/profile', note: 'Website' }],
      email: 'private@example.test',
    });
    expect(result.personIds).toEqual(['901', '902']);
    expect(result.memberships?.[0]).toMatchObject({
      party: { name: 'Historical Party', shortName: 'HP' },
      riding: 'Old Riding',
      province: 'Quebec',
      startDate: '2001-01-01',
      endDate: '2005-01-01',
    });
    expect(result.memberships?.[1]).toMatchObject({
      party: { name: null, shortName: null },
      riding: null,
      startDate: null,
    });
    expect(result.links).toEqual([{ url: 'https://example.test/profile', note: 'Website' }]);
    expect(JSON.stringify(result)).not.toContain('private@example.test');
  });
  it('relays an http profile link as published in the real Lawrence Cannon profile', () => {
    expect(parsePoliticianProfile(lawrenceCannon())).toMatchObject({
      slug: 'lawrence-cannon',
      personIds: null,
      imageUrl: 'https://openparliament.ca/media/polpics/414.jpg',
      links: [{ url: 'http://www.lawrencecannon.com/', note: 'Official site' }],
    });
  });
  it('relays every absolute HTTP(S) profile link exactly as published, never normalized', () => {
    const links = [
      'http://www.cannan.ca',
      'https://www.ourcommons.ca/members/en/ron-cannan(35933)',
      'HTTP://Example.TEST/Path',
    ];
    expect(
      parsePoliticianProfile({ ...actor, links: links.map((url) => ({ url })) }).links,
    ).toEqual(links.map((url) => ({ url, note: null })));
  });
  it.each([
    ['/members/relative-link/', 'https://openparliament.ca/members/relative-link/'],
    ['/politicians/synthetic-member/', 'https://openparliament.ca/politicians/synthetic-member/'],
    ['//example-mp.test/profile', 'https://example-mp.test/profile'],
    ['Official site', 'https://openparliament.ca/Official%20site'],
    ['   ', 'https://openparliament.ca/'],
  ])(
    'resolves non-absolute profile link %j against OpenParliament as 0.1.1 did',
    (url, expected) => {
      expect(parsePoliticianProfile({ ...actor, links: [{ url }] }).links).toEqual([
        { url: expected, note: null },
      ]);
    },
  );
  it.each([
    '',
    'https://user:secret@example.test/',
    'http://user@example.test/',
    '//user:secret@example-mp.test/profile',
    'javascript:alert(1)',
    'mailto:member@example.test',
    'data:text/plain,profile',
    'ftp://example.test/profile',
  ])('rejects unusable profile link %j as malformed without retry', (url) => {
    expect(() => parsePoliticianProfile({ ...actor, links: [{ url }] })).toThrow(
      expect.objectContaining({ data: { field: 'link', retryable: false } }),
    );
  });
  it.each([
    ['/media/polpics/414.jpg', 'https://openparliament.ca/media/polpics/414.jpg'],
    ['https://images.example.test/portrait.png', 'https://images.example.test/portrait.png'],
  ])('keeps the HTTPS image rule for %s', (image, expected) => {
    expect(parsePolitician({ ...actor, image }).imageUrl).toBe(expected);
  });
  it.each([
    'http://images.example.test/portrait.png',
    'https://user:secret@images.example.test/portrait.png',
  ])('rejects image %s as malformed', (image) => {
    expect(() => parsePolitician({ ...actor, image })).toThrow(
      expect.objectContaining({ data: { field: 'link', retryable: false } }),
    );
  });
  it('preserves bill/vote nulls and bilingual titles without inventing translations', () => {
    expect(parseBill(bill)).toMatchObject({
      legisinfoId: null,
      title: { en: null, fr: null },
      status: null,
    });
    expect(
      parseBill({
        ...bill,
        legisinfo_id: 901,
        name: { fr: 'Titre' },
        status: { en: 'At second reading' },
      }),
    ).toMatchObject({
      legisinfoId: '901',
      title: { en: null, fr: 'Titre' },
      status: 'At second reading',
    });
    expect(parseVote(vote)).toMatchObject({ date: null, subject: null, result: null });
  });
  it.each(['C-15A', 'C-333A', 'S-1001'])('reads split-bill or plain bill path %s', (code) => {
    expect(parseBill({ url: `/bills/37-1/${code}/`, session: '37-1', number: code })).toMatchObject(
      { session: '37-1', billCode: code, url: `https://openparliament.ca/bills/37-1/${code}/` },
    );
  });
  it.each(['C-15AB', 'C-15A1', 'C-15a', 'C-015', 'C-A'])(
    'rejects malformed bill path %s without retry',
    (code) => {
      expect(() =>
        parseBill({ url: `/bills/37-1/${code}/`, session: '37-1', number: code }),
      ).toThrow(expect.objectContaining({ data: expect.objectContaining({ retryable: false }) }));
    },
  );
  it.each(['Yes', 'No', 'Paired', "Didn't vote"])('preserves ballot vocabulary %s', (value) => {
    expect(parseBallot({ ...ballot, ballot: value })).toMatchObject({
      ballot: value,
      membershipUrl: null,
    });
  });
  it.each([
    () => parseBill({ ...bill, number: 'C-902' }),
    () => parseVote({ ...vote, number: 902 }),
    () => parseBill({ ...bill, legisinfo_id: 0 }),
    () => parseBallot({ ...ballot, ballot: 'Yea' }),
    () => parsePoliticianProfile({ ...actor, other_info: { parl_mp_id: [901] } }),
    () => parseMembership({ ...membership, start_date: '2026-02-30' }),
    () => parsePolitician({ ...actor, current_party: [] }),
    () => parsePolitician({ ...actor, url: 'https://evil.test/politicians/synthetic-member/' }),
  ])('rejects malformed identities and nested types without retry', (run) => {
    expect(run).toThrow();
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ data: { retryable: false } });
    }
  });
  it('retains complete decoded speech text with paragraphs and hard breaks', () => {
    const long = 'Complete prose & more. '.repeat(3000);
    expect(
      htmlToText('<p>One &amp; <em>two</em><br>three&nbsp;four</p>\n<p>Five &#xE9;.</p>'),
    ).toBe('One & two\nthree\u00a0four\n\nFive é.');
    expect(
      parseSpeech({
        ...speech,
        content: { en: `<p>${long}</p>`, fr: `<p>${long}</p>` },
        attribution: { en: 'The Speaker' },
      }).content,
    ).toEqual({ en: long, fr: long });
  });
  it('renders each table row in Hansard speech content as one paragraph of cells joined by " | "', () => {
    const { content } = parseSpeech({
      ...hansard().sgro,
      content: {
        en: '<p data-HoCid="8857143" data-originallang="en">Mr. Speaker, the funding by year is as follows:</p>\n<table>\n  <tr><th>Year</th><th>Program</th><th>Amount</th></tr>\n  <tr><td>2025</td><td></td><td>100</td></tr>\n</table>\n<p data-HoCid="8857144" data-originallang="en">Those are the figures.</p>',
        fr: '<p data-HoCid="8857143" data-originallang="en">Monsieur le Président, voici le financement par année :</p><table><tbody><tr><th>Année</th><th>Montant</th></tr><tr><td>2025</td><td>100</td></tr></tbody></table>',
      },
    });
    expect(content.en).toBe(
      'Mr. Speaker, the funding by year is as follows:\n\nYear | Program | Amount\n\n2025 |  | 100\n\nThose are the figures.',
    );
    expect(content.fr?.trimEnd()).toBe(
      'Monsieur le Président, voici le financement par année :\n\nAnnée | Montant\n\n2025 | 100',
    );
    /** The captured 2006-05-12 Stockwell Day row; each language's text is a verbatim slice. */
    const table =
      '<table><tr><td>Province / Territory<br> </td><td>Number of ATCs issued for protection against wildlife<br> </td><td> Number of ATCs issued to armoured vehicle industry<br> </td></tr><tr><td>British Columbia/Yukon<br> </td><td> 434<br> </td><td> 2,160<br> </td></tr><tr><td>Alberta/Northwest Territories<br> </td><td>116<br> </td><td>1,489<br> </td></tr><tr><td> Saskatchewan<br> </td><td>19<br> </td><td> 619<br> </td></tr><tr><td>Manitoba/Nunavut<br> </td><td>9<br> </td><td> 645<br> </td></tr><tr><td> Ontario<br> </td><td> 235<br> </td><td>4,712<br> </td></tr><tr><td> Quebec<br> </td><td>73<br> </td><td>2,566<br> </td></tr><tr><td>New Brunswick<br> </td><td>0<br> </td><td>346<br> </td></tr><tr><td>Nova Scotia <br> </td><td>0<br> </td><td>569<br> </td></tr><tr><td>Newfoundland and Labrador<br> </td><td> 0<br> </td><td>133<br> </td></tr><tr><td> Prince Edward Island<br> </td><td>0<br> </td><td>56<br> </td></tr><tr><td> Total <br> </td><td>886<br> </td><td>13,295<br> </td></tr></table>';
    const intro = {
      en: 'a) Nationally consistent standards for reporting authorizations to carry, ATC, issued and the centralized system to record the information were introduced for September 2004. ATCs have been issued as indicated in the following table between September 1, 2004, and April 20, 2006: ',
      fr: 'a) C’est en septembre 2004 qu’ont été introduites les normes uniformes nationales pour la présentation de rapports sur les autorisations de port, AP, délivrées et qu’a été mis en place le système pour consigner l’information. Les AP ont été délivrées entre le 1er septembre 2004 et le 20 avril 2006 conformément au tableau suivant: ',
    };
    const stockwellDay = parseSpeech({
      time: '2006-05-12 12:05:00',
      attribution: { en: 'Hon. Stockwell Day (Minister of Public Safety, CPC)', fr: '' },
      content: {
        en: `<p data-HoCid="13614">${intro.en}</p>\n${table}`,
        fr: `<p data-HoCid="13614">${intro.fr}</p>\n${table}`,
      },
      url: '/debates/2006/5/12/stockwell-day-1/',
      politician_url: '/politicians/stockwell-day/',
      politician_membership_url: '/politicians/memberships/1282/',
      procedural: false,
      source_id: 'p13613',
      h1: { en: 'Routine Proceedings', fr: '' },
      h2: { en: 'Questions on the Order Paper', fr: '' },
      document_url: '/debates/2006/5/12/',
    });
    const rows = [
      'Province / Territory | Number of ATCs issued for protection against wildlife | Number of ATCs issued to armoured vehicle industry',
      'British Columbia/Yukon | 434 | 2,160',
      'Alberta/Northwest Territories | 116 | 1,489',
      'Saskatchewan | 19 | 619',
      'Manitoba/Nunavut | 9 | 645',
      'Ontario | 235 | 4,712',
      'Quebec | 73 | 2,566',
      'New Brunswick | 0 | 346',
      'Nova Scotia | 0 | 569',
      'Newfoundland and Labrador | 0 | 133',
      'Prince Edward Island | 0 | 56',
      'Total | 886 | 13,295',
    ];
    expect(stockwellDay.content).toEqual({
      en: `${intro.en}\n\n${rows.join('\n\n')}\n\n`,
      fr: `${intro.fr}\n\n${rows.join('\n\n')}\n\n`,
    });
    expect(stockwellDay.speaker).toEqual({
      en: 'Hon. Stockwell Day (Minister of Public Safety, CPC)',
      fr: null,
    });
  });
  it('retains institutional and committee raw candidates and missing English text', () => {
    expect(parseSpeech({ ...speech, content: { fr: 'Texte' } })).toMatchObject({
      politician: null,
      content: { en: null, fr: 'Texte' },
      procedural: null,
      speaker: { en: null, fr: null },
      h1: { en: null, fr: null },
      h2: { en: null, fr: null },
      membershipUrl: null,
    });
    expect(
      parseSpeech({
        ...speech,
        url: '/committees/example/1/2/',
        document_url: '/committees/example/1/',
        procedural: true,
      }),
    ).toMatchObject({
      debateUrl: 'https://openparliament.ca/committees/example/1/',
      procedural: true,
    });
  });
  it.each(
    [undefined, null, '', ' \r\n\t '].flatMap((value) =>
      (['en', 'fr'] as const).map((language) => [language, value] as const),
    ),
  )(
    'keeps a blank %s speech value %j null, never filled from the other language',
    (language, value) => {
      const other = language === 'en' ? 'fr' : 'en';
      const both = (present: string) => ({
        ...(value === undefined ? {} : { [language]: value }),
        [other]: present,
      });
      const parsed = parseSpeech({
        ...speech,
        attribution: both('Attribution'),
        h1: both('Heading one'),
        h2: both('Heading two'),
        content: both('<p>Text &amp; more</p>'),
      });
      for (const [field, present] of [
        ['speaker', 'Attribution'],
        ['h1', 'Heading one'],
        ['h2', 'Heading two'],
        ['content', 'Text & more'],
      ] as const)
        expect(parsed[field]).toEqual({ [language]: null, [other]: present });
    },
  );
  it('treats speech HTML without visible text as missing in each language', () => {
    expect(
      parseSpeech({ ...speech, content: { en: '<p> </p>\n<p></p>', fr: '<p>&nbsp;</p><br>' } })
        .content,
    ).toEqual({ en: null, fr: null });
  });
  it.each([undefined, null, '', '  '])(
    'identifies a speech by its source path when source_id is %j',
    (sourceId) => {
      expect(
        parseSpeech({ ...speech, ...(sourceId === undefined ? {} : { source_id: sourceId }) }).id,
      ).toBe('/debates/2026/10/20/1/');
      expect(parseSpeech({ ...speech, source_id: '13107100' }).id).toBe('13107100');
    },
  );
  it.each([
    { content: { en: '<p>Text</p>', fr: 12 } },
    { attribution: { en: 'Speaker', fr: [] } },
    { h2: { fr: true } },
    { h1: 'Heading' },
  ])('rejects a non-text speech language value %j without retry', (extra) => {
    const run = () => parseSpeech({ ...speech, ...extra });
    expect(run).toThrow();
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ data: { retryable: false } });
    }
  });
  it('distinguishes malformed JSON from transient HTML', () => {
    expect(() => parseJson('{')).toThrow();
    expect(() => parseJson('<html>Unavailable</html>')).toThrow();
    expect(parseJson('{"objects":[]}')).toEqual({ objects: [] });
  });
});

describe('OpenParliament continuation validation', () => {
  const requested = new URL(
    'https://api.openparliament.ca/politicians/?limit=2&offset=0&include=all&name=Synthetic',
  );
  const page = (next: unknown, objects: unknown[] = []) => ({
    objects,
    pagination: { limit: 2, offset: 0, next_url: next },
  });
  it.each([
    { objects: [] },
    { objects: [actor] },
    { objects: [actor, { ...actor, url: '/politicians/second-member/' }] },
  ])('accepts terminal zero/short/full pages', ({ objects }) => {
    expect(parsePage(page(null, objects), requested, parsePolitician)).toMatchObject({
      nextOffset: null,
      objects: expect.any(Array),
    });
  });
  it('accepts reordered equivalent filters and format=json with a strictly increasing offset', () => {
    expect(
      parsePage(
        page('/politicians/?name=Synthetic&include=all&offset=2&format=json&limit=2', [actor]),
        requested,
        parsePolitician,
      ).nextOffset,
    ).toBe(2);
  });
  it('accepts an empty past-end page at its requested offset', () => {
    expect(
      parsePage(
        { objects: [], pagination: { offset: 900, limit: 2, next_url: null } },
        new URL(requested.href.replace('offset=0', 'offset=900')),
        parsePolitician,
      ),
    ).toEqual({ objects: [], nextOffset: null });
  });
  it.each([
    'https://evil.test/politicians/?limit=2&offset=2&include=all&name=Synthetic',
    '/bills/?limit=2&offset=2&include=all&name=Synthetic',
    '/politicians/?limit=2&offset=0&include=all&name=Synthetic',
    '/politicians/?limit=2&offset=-1&include=all&name=Synthetic',
    '/politicians/?limit=2&offset=2&offset=3&include=all&name=Synthetic',
    '/politicians/?limit=2&offset=2&include=all&include=all&name=Synthetic',
    '/politicians/?limit=2&offset=2&include=all&name=Other',
    '/politicians/?limit=2&offset=2&include=all&name=Synthetic&format=json&format=json',
    '/politicians/?limit=2&offset=2&include=all&name=Synthetic#fragment',
    null,
  ])('rejects changed, unsafe, repeated or non-increasing continuation %s', (next) => {
    const input =
      next === null
        ? { ...page(null), pagination: { limit: 2, offset: 1, next_url: null } }
        : page(next);
    expect(() => parsePage(input, requested, parsePolitician)).toThrow();
  });
  it('rejects responses exceeding the requested page cap', () => {
    expect(() =>
      parsePage(page(null, [actor, actor, actor]), requested, parsePolitician),
    ).toThrow();
  });
});
