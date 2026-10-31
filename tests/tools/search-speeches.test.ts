/** @fileoverview Bounded speech scanning and historical attribution contracts. @module tests/tools/search-speeches.test */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESPONSE_BUDGET } from '@/mcp-server/tools/definitions/_format.js';
import { searchSpeechesTool } from '@/mcp-server/tools/definitions/search-speeches.tool.js';
import { disposeOurCommonsService, initOurCommonsService } from '@/services/ourcommons/index.js';
import { wireBytes } from '../fixtures/bill-tools/harness.js';
import {
  type ArgumentRejection,
  assertArgumentRejection,
  assertFilterRejection,
  type FilterRejection,
} from '../fixtures/filter-rejection.js';
import {
  actor,
  api,
  bill,
  failure,
  hansard,
  member,
  membership,
  pages,
  parity,
  profile,
  settle,
  setup,
  speech,
  teardown,
} from '../fixtures/speech-tools/harness.js';
import { collection, rawPerson, rosterUrl } from '../fixtures/vote-tools/harness.js';

const SUBSTANTIVE =
  'substantiveOnly=true excludes procedural remarks; set substantiveOnly=false to include them.';
const EXCLUDED =
  'Non-House or committee candidates were excluded and are included in scanned and excludedCommittees.';
const budgetNotice = (shown: number) =>
  `The 24000-byte response budget ended this page after ${shown} ${shown === 1 ? 'speech' : 'speeches'}; call canparl_search_speeches with nextOffset and identical filters to continue.`;
const MISSING =
  'Historical party or riding is unavailable for some returned speeches; nulls never substitute current affiliation.';
const oversized =
  'The response exceeds the 24000-byte budget with one speech, returned whole; call canparl_search_speeches with nextOffset and identical filters to continue.';
const NO_MATCH =
  'No indexed speeches matched; broaden dates or remove contains and retry canparl_search_speeches. This does not establish that no parliamentary speech occurred.';
const textless = (count: number, language: 'English' | 'French') =>
  `${count} scanned ${count === 1 ? 'candidate' : 'candidates'} had no ${language} text and could not match contains.`;
/** Plain text of the captured 2025-06-19 Sgro statement, read from its `content` HTML. */
const SGRO_EN =
  "Mr. Speaker, our government is taking strong, targeted action to support the people of Ukraine and to hold Russia accountable for its ongoing war of aggression. In one of our most significant sanctions packages since the invasion began in 2022, we are imposing new sanctions on 77 individuals and 39 entities, and restricting trade on nearly 1,000 items, including those linked to chemical weapons, advanced technologies and critical industrial goods.\n\nWe are also expanding our crackdown on Russia's shadow fleet by listing over 200 additional vessels, now totalling more than 300, and banning all related services to disrupt Russia's global shipping networks.\n\nSanctions also target key financial institutions, energy companies and individuals enabling Russia's military and disinformation efforts. Canada stands firmly with the people of Ukraine as well as all those in the G7 whose courage and resilience continue to—";
const SGRO_FR =
  "Monsieur le Président, le gouvernement prend des mesures énergiques et ciblées pour soutenir le peuple ukrainien et pour tenir la Russie responsable de la guerre d'agression qu'elle mène en ce moment. Dans l'un de nos plus importants ensembles de sanctions depuis le début de l'invasion en 2022, nous imposons de nouvelles sanctions à 77 personnes et 39 entités et nous restreignons le commerce de près de 1 000 articles, y compris ceux liés aux armes chimiques, aux technologies de pointe et aux produits industriels essentiels.\n\nNous élargissons également nos mesures de répression contre la flotte fantôme de la Russie en y ajoutant plus de 200 navires, pour un total de plus de 300, et en interdisant tous les services connexes afin de perturber les réseaux mondiaux de transport maritime de la Russie.\n\nCes sanctions ciblent également des institutions financières clés, des sociétés d'énergie et des particuliers qui facilitent les efforts militaires et de désinformation de la Russie. Le Canada demeure résolument solidaire du peuple ukrainien ainsi que de tous les membres des pays du G7 dont le courage et la résilience continuent de...";
/** French plain text of the captured 2015-03-11 Strahl speech. */
const STRAHL_FR =
  "Monsieur le Président, comme je l'ai déjà mentionné, et comme la députée l'a souligné elle aussi, cette décision a été prise par la Ville d'Ottawa. Je le répète, nous établissons des partenariats avec les villes, les centres d'amitié ainsi que les fournisseurs de services partout au pays pour offrir des services aux Canadiens autochtones à l'endroit où ils vivent, et nous poursuivrons nos efforts en ce sens dans le cadre de la Stratégie pour les Autochtones vivant en milieu urbain.\n\nNous continuerons de travailler avec les provinces et les villes pour lutter contre l'itinérance. Nous souhaitons continuer dans cette voie, non seulement en faisant preuve de respect à l'égard des deniers publics, mais aussi en tenant compte des particularités culturelles des Autochtones.";

describe('canparl_search_speeches production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown> = {}) =>
    settle(runToolContract(searchSpeechesTool, input));
  const success = async (input: Record<string, unknown> = {}) =>
    parity(await call({ dateFrom: '2026-10-19', ...input }), searchSpeechesTool);
  const fail = async (input: Record<string, unknown>, reason: string) =>
    failure(
      await call(input),
      searchSpeechesTool.errors!.find((error) => error.reason === reason)!,
    );
  const ids = (data: Record<string, unknown>) =>
    (data.speeches as { id: string }[]).map((row) => row.id);
  /** A House speech whose English text holds `marker` and `chars` letters, with its own membership. */
  const long = (id: number, chars: number, extra: Record<string, unknown> = {}) =>
    speech(id, {
      content: { en: `<p>marker ${'a'.repeat(chars)}</p>` },
      politician_membership_url: `/politicians/memberships/${id + 1}/`,
      ...extra,
    });
  function memberships() {
    http.route({
      match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
      respond: (request) => Response.json(membership({ url: new URL(request.url).pathname })),
    });
  }
  const pageCalls = () =>
    http.calls.filter(({ request }) => new URL(request.url).pathname === '/speeches/').length;
  const membershipCalls = () =>
    http.calls.flatMap(({ request }) => {
      const id = /^\/politicians\/memberships\/(\d+)\/$/.exec(new URL(request.url).pathname)?.[1];
      return id === undefined ? [] : [id];
    });
  const provenancePaths = (data: Record<string, unknown>) =>
    (data.provenance as { url: string }[]).map((source) => new URL(source.url).pathname);
  it('intersects normalized speaker, both identical bills, dates, and literal English text', async () => {
    profile(http);
    bill(http);
    pages(http, [speech(1, { politician_membership_url: member })], {
      politician: actor,
      bill_debated: '/bills/45-1/S-321/',
      mentioned_bill: '/bills/45-1/S-321/',
      time__gte: '2026-10-19',
      time__lt: '2026-10-20',
    });
    http.route({ match: `${api}${member}`, respond: Response.json(membership()) });
    const data = await success({
      politician: ' https://openparliament.ca/politicians/river-example/ ',
      billDebated: { session: ' 045-01 ', code: ' bill s–321 ' },
      mentionedBill: { session: { parliament: 45, session: 1 }, code: 'S321' },
      dateTo: '2026-10-19',
      contains: ' e\u0301cole [x].* ',
    });
    expect(data).toMatchObject({
      scanned: 1,
      exhausted: true,
      nextOffset: null,
      shown: 1,
      cap: 5,
      truncated: false,
      excludedCommittees: 0,
      speeches: [
        {
          party: 'Historical [party]',
          riding: 'Old riding\n第二行',
          content: 'École [x].* & 中文\nnext line\n\n# heading\r\n``` fence',
          time: '2026-10-19 23:59:59',
        },
      ],
      appliedFilters: { politician: 'river-example', contains: 'e\u0301cole [x].*' },
    });
    expect(http.calls).toHaveLength(4);
  });
  it('validates distinct bill identities once each', async () => {
    bill(http);
    bill(http, 'C-19');
    pages(http, [], { bill_debated: '/bills/45-1/S-321/', mentioned_bill: '/bills/45-1/C-19/' });
    parity(
      await call({
        billDebated: { session: '45-1', code: 's321' },
        mentionedBill: { session: '45-1', code: 'c19' },
      }),
      searchSpeechesTool,
    );
    expect(http.calls).toHaveLength(3);
  });
  it('scopes a split bill by its exact suffixed code', async () => {
    bill(http, 'C-15A');
    pages(http, [], { bill_debated: '/bills/45-1/C-15A/', mentioned_bill: '/bills/45-1/C-15A/' });
    const data = parity(
      await call({
        billDebated: { session: '45-1', code: 'c 15a' },
        mentionedBill: { session: '45-1', code: 'C-15A' },
      }),
      searchSpeechesTool,
    );
    expect(data).toMatchObject({
      appliedFilters: { billDebated: '/bills/45-1/C-15A/', mentionedBill: '/bills/45-1/C-15A/' },
    });
    expect(http.calls).toHaveLength(2);
  });
  it.each([{ dateFrom: '2026-10-19' }, { dateTo: '2026-10-19' }])(
    'supports independent date bound %j',
    async (input) => {
      pages(
        http,
        [speech()],
        'dateFrom' in input ? { time__gte: '2026-10-19' } : { time__lt: '2026-10-20' },
      );
      const data = parity(await call(input), searchSpeechesTool);
      expect(data.scanned).toBe(1);
    },
  );
  it.each([0, 2, 5, 10])('discloses terminal pages at %i matches', async (count) => {
    pages(
      http,
      Array.from({ length: count }, (_, i) => speech(i)),
      { time__gte: '2026-10-19' },
    );
    expect(await success({ limit: count || 5 })).toMatchObject({
      scanned: count,
      shown: count,
      exhausted: true,
      nextOffset: null,
      truncated: false,
    });
  });
  it('keeps raw mid-page continuation and consumes the remainder with identical filters', async () => {
    pages(
      http,
      Array.from({ length: 8 }, (_, i) => speech(i)),
      { time__gte: '2026-10-19' },
    );
    expect(await success({ limit: 5 })).toMatchObject({
      scanned: 5,
      nextOffset: 5,
      exhausted: false,
    });
    expect(await success({ limit: 5, offset: 5 })).toMatchObject({
      scanned: 3,
      nextOffset: null,
      exhausted: true,
      speeches: [{ id: '5' }, { id: '6' }, { id: '7' }],
    });
  });
  it.each([true, false])(
    'scans at most 100 unmatched candidates, terminal=%s',
    async (terminal) => {
      pages(
        http,
        Array.from({ length: 100 }, (_, i) =>
          speech(i, { politician_membership_url: `/politicians/memberships/${i + 1}/` }),
        ),
        { time__gte: '2026-10-19' },
        terminal,
      );
      const data = await success({ contains: 'never present' });
      expect(data).toMatchObject({
        speeches: [],
        scanned: 100,
        exhausted: terminal,
        nextOffset: terminal ? null : 100,
        truncated: !terminal,
      });
      expect(data.notice).toContain(terminal ? 'does not establish' : 'identical filters');
      expect(http.calls).toHaveLength(5);
    },
  );
  it('uses next_url rather than short page length to establish exhaustion', async () => {
    pages(http, [speech()], { time__gte: '2026-10-19' }, false);
    expect(await success({ limit: 1 })).toMatchObject({
      scanned: 1,
      exhausted: false,
      nextOffset: 20,
    });
  });
  it('returns empty past-end source page without inventing totals', async () => {
    pages(http, [speech()], { time__gte: '2026-10-19' });
    expect(await success({ offset: 200 })).toMatchObject({
      speeches: [],
      scanned: 0,
      exhausted: true,
      nextOffset: null,
      notice: `${SUBSTANTIVE} This offset is past the last indexed candidate; retry canparl_search_speeches with offset 0 and identical filters.`,
    });
  });
  it.each<[string, Record<string, unknown>[], number]>([
    ['an empty scope at offset 0', [], 0],
    ['unmatched candidates after a nonzero offset', [speech(1), speech(2)], 1],
  ])('reports no indexed match for %s', async (_, rows, offset) => {
    pages(http, rows, { time__gte: '2026-10-19' });
    expect(await success({ offset, contains: 'never present' })).toMatchObject({
      speeches: [],
      exhausted: true,
      notice: `${SUBSTANTIVE} No indexed speeches matched; broaden dates or remove contains and retry canparl_search_speeches. This does not establish that no parliamentary speech occurred.`,
    });
  });
  it('names working politician sources in its recovery hints', () => {
    const recovery = (reason: string) =>
      searchSpeechesTool.errors!.find((error) => error.reason === reason)!.recovery;
    expect(recovery('speech_scope_required')).toBe(
      "Retry canparl_search_speeches with a politician (member.slug from canparl_get_member, a slug from an includeFormer canparl_search_members row, or a current MP's personId), a bill from canparl_search_bills, or a date bound.",
    );
    expect(recovery('invalid_speech_filter')).toBe(
      "Retry canparl_search_speeches in the shape the error names: a politician slug (member.slug from canparl_get_member or an includeFormer canparl_search_members row) or a current MP's personId, a bill session and code from canparl_search_bills, and YYYY-MM-DD dates with dateFrom no later than dateTo.",
    );
  });
  it('excludes committees and missing documents while preserving institutional and missing-body rows', async () => {
    pages(
      http,
      [
        speech(1, { document_url: '/committees/finance/1/' }),
        speech(2, { url: '/committees/finance/2/' }),
        speech(3, { document_url: null }),
        speech(4, {
          politician_url: null,
          content: { fr: 'French only phrase' },
          h1: null,
          h2: null,
          attribution: null,
        }),
      ],
      { time__gte: '2026-10-19' },
    );
    expect(await success()).toMatchObject({
      scanned: 4,
      excludedCommittees: 3,
      speeches: [{ id: '4', content: null, politician: null, party: null, riding: null }],
    });
    expect(await success({ contains: 'French only phrase' })).toMatchObject({
      speeches: [],
      scanned: 4,
    });
  });
  it('excludes committees and missing documents in French while keeping a row without French text', async () => {
    pages(
      http,
      [
        speech(1, { document_url: '/committees/finance/1/' }),
        speech(2, { url: '/committees/finance/2/' }),
        speech(3, { document_url: null }),
        speech(4, {
          politician_url: null,
          content: { en: 'English only phrase' },
          h1: null,
          h2: null,
          attribution: null,
        }),
      ],
      { time__gte: '2026-10-19' },
    );
    expect(await success({ language: 'fr' })).toMatchObject({
      scanned: 4,
      excludedCommittees: 3,
      speeches: [
        {
          id: '4',
          speaker: null,
          h1: null,
          h2: null,
          content: null,
          politician: null,
          party: null,
          riding: null,
        },
      ],
    });
    // Excluded committee rows are counted in excludedCommittees, not as missing French text.
    expect(await success({ language: 'fr', contains: 'English only phrase' })).toMatchObject({
      speeches: [],
      scanned: 4,
      excludedCommittees: 3,
      notice: `${SUBSTANTIVE} ${EXCLUDED} ${textless(1, 'French')} ${NO_MATCH}`,
    });
  });
  /** The captured Sgro statement of 2025-06-19, its real membership, and a verified profile. */
  function sgro() {
    const rows = hansard();
    http.route(
      {
        match: `${api}/politicians/judy-sgro/`,
        respond: Response.json({ url: '/politicians/judy-sgro/', name: 'Judy Sgro' }),
      },
      {
        match: `${api}/politicians/memberships/4375/`,
        respond: Response.json(rows.sgroMembership),
      },
    );
    pages(http, [rows.sgro], {
      politician: '/politicians/judy-sgro/',
      time__gte: '2025-06-19',
      time__lt: '2025-06-20',
    });
  }
  const sgroScope = { politician: 'judy-sgro', dateFrom: '2025-06-19', dateTo: '2025-06-19' };
  /** Fields of the Sgro speech that no language selection changes. */
  const sgroIdentity = {
    id: '13107100',
    politician: 'judy-sgro',
    membershipUrl: 'https://openparliament.ca/politicians/memberships/4375/',
    party: 'Liberal Party of Canada',
    riding: 'Humber River—Black Creek',
    time: '2025-06-19 14:05:00',
    procedural: false,
    url: 'https://openparliament.ca/debates/2025/6/19/judy-sgro-1/',
    debateUrl: 'https://openparliament.ca/debates/2025/6/19/',
  };
  it('returns the captured English record by default and matches no French wording in it', async () => {
    sgro();
    const english = await success({ ...sgroScope, contains: 'shadow fleet' });
    expect(english.speeches).toEqual([
      {
        ...sgroIdentity,
        speaker: 'Hon. Judy A. Sgro (Humber River—Black Creek, Lib.)',
        h1: 'Statements by Members',
        h2: 'Ukraine',
        content: SGRO_EN,
      },
    ]);
    expect(await success({ ...sgroScope, contains: 'flotte fantôme' })).toMatchObject({
      speeches: [],
      scanned: 1,
      exhausted: true,
    });
  });
  it('selects French text, headings, and attribution from the same row, keeping English affiliation', async () => {
    sgro();
    const french = await success({ ...sgroScope, language: 'fr', contains: 'flotte fantôme' });
    expect(french).toMatchObject({
      scanned: 1,
      exhausted: true,
      nextOffset: null,
      appliedFilters: { politician: 'judy-sgro', contains: 'flotte fantôme', language: 'fr' },
    });
    expect(french.speeches).toEqual([
      {
        ...sgroIdentity,
        speaker: "L'hon. Judy A. Sgro (Humber River—Black Creek, Lib.)",
        h1: 'Déclarations de députés',
        h2: "L'Ukraine",
        content: SGRO_FR,
      },
    ]);
    expect(await success({ ...sgroScope, language: 'fr', contains: 'shadow fleet' })).toMatchObject(
      { speeches: [], scanned: 1 },
    );
    expect(
      await success({ ...sgroScope, language: 'en', contains: 'flotte fantôme' }),
    ).toMatchObject({ speeches: [], appliedFilters: { language: 'en' } });
  });
  it.each<[string, string[]]>([
    ['flotte fantome', [SGRO_FR]],
    ['flotte fantomes', []],
  ])(
    'matches French contains %j ignoring accents, relaying the text as published',
    async (contains, content) => {
      sgro();
      const data = await success({ ...sgroScope, language: 'fr', contains });
      expect((data.speeches as { content: string }[]).map((row) => row.content)).toEqual(content);
      expect(data).toMatchObject({
        shown: content.length,
        scanned: 1,
        exhausted: true,
        appliedFilters: { contains, language: 'fr' },
      });
    },
  );
  it('returns a blank English source attribution as null', async () => {
    pages(http, [hansard().procedural2026], {
      time__gte: '2026-10-30',
      time__lt: '2026-10-31',
      procedural: undefined,
    });
    const data = await success({
      dateFrom: '2026-10-30',
      dateTo: '2026-10-30',
      substantiveOnly: false,
    });
    expect(data.speeches).toMatchObject([
      {
        id: 'p5',
        speaker: null,
        h1: "Private Members' Business",
        h2: 'National Strategy for Children and Youth Act',
        content: expect.stringContaining('(Bill S-212. On the Order'),
      },
    ]);
  });
  it('returns a blank French source attribution as null beside French headings and text', async () => {
    pages(http, [hansard().procedural2026], {
      time__gte: '2026-10-30',
      time__lt: '2026-10-31',
      procedural: undefined,
    });
    const data = await success({
      dateFrom: '2026-10-30',
      dateTo: '2026-10-30',
      substantiveOnly: false,
      language: 'fr',
    });
    expect(data).toMatchObject({
      appliedFilters: { language: 'fr', substantiveOnly: false },
      speeches: [
        {
          id: 'p5',
          speaker: null,
          h1: 'Ordres émanant des députés',
          h2: 'Loi sur la stratégie nationale pour les enfants et les jeunes',
          content: expect.stringContaining('(Projet de loi S‑212.'),
        },
      ],
    });
  });
  it.each<[string | undefined, Record<string, string | null>]>([
    [
      undefined,
      {
        speaker: 'Mr. Duhamel',
        h1: 'Government Orders',
        h2: 'Income Tax Act',
        content: 'I am listening.',
      },
    ],
    ['fr', { speaker: null, h1: null, h2: null, content: null }],
  ])(
    'never fills a missing field of a 1994 speech from the other language, language %s',
    async (language, text) => {
      memberships();
      pages(http, [hansard().duhamel1994], { time__gte: '1994-02-09', time__lt: '1994-02-10' });
      const data = await success({
        dateFrom: '1994-02-09',
        dateTo: '1994-02-09',
        ...(language ? { language } : {}),
      });
      // A blank source_id falls back to the speech path, never an empty identifier.
      expect(data.speeches).toEqual([
        {
          id: '/debates/1994/2/9/ronald-j-duhamel-5/',
          politician: '4255',
          membershipUrl: 'https://openparliament.ca/politicians/memberships/3114/',
          party: null,
          riding: null,
          time: '1994-02-09 19:45:00',
          procedural: false,
          url: 'https://openparliament.ca/debates/1994/2/9/ronald-j-duhamel-5/',
          debateUrl: 'https://openparliament.ca/debates/1994/2/9/',
          ...text,
        },
      ]);
    },
  );
  it('counts scanned candidates without selected-language text only when contains is set', async () => {
    memberships();
    const rows = hansard();
    pages(http, [rows.duhamel1994, rows.someMembers2009, rows.strahl2015], {
      time__gte: '1994-01-01',
    });
    const french = await success({
      dateFrom: '1994-01-01',
      language: 'fr',
      contains: 'itinérance',
    });
    expect(french).toMatchObject({
      scanned: 3,
      exhausted: true,
      notice: `${SUBSTANTIVE} ${textless(1, 'French')} ${MISSING}`,
    });
    expect(french.speeches).toEqual([
      {
        id: '8611105',
        speaker: 'M. Mark Strahl',
        politician: 'mark-strahl',
        membershipUrl: 'https://openparliament.ca/politicians/memberships/4101/',
        party: null,
        riding: null,
        time: '2015-03-11 19:40:00',
        h1: "Motion D'Ajournement",
        h2: null,
        content: STRAHL_FR,
        procedural: false,
        url: 'https://openparliament.ca/debates/2015/3/11/mark-strahl-8/',
        debateUrl: 'https://openparliament.ca/debates/2015/3/11/',
      },
    ]);
    expect(
      await success({ dateFrom: '1994-01-01', language: 'fr', contains: 'never present' }),
    ).toMatchObject({
      speeches: [],
      notice: `${SUBSTANTIVE} ${textless(1, 'French')} ${NO_MATCH}`,
    });
    const all = await success({ dateFrom: '1994-01-01', language: 'fr' });
    expect(all).toMatchObject({ shown: 3, notice: `${SUBSTANTIVE} ${MISSING}` });
    expect(all.speeches).toMatchObject([
      { content: null, speaker: null },
      { content: " D'accord.", speaker: null, h1: null, h2: null },
      { id: '8611105' },
    ]);
    expect(await success({ dateFrom: '1994-01-01', contains: 'never present' })).toMatchObject({
      speeches: [],
      notice: `${SUBSTANTIVE} ${NO_MATCH}`,
    });
  });
  it('allows procedural records only when explicitly requested and omits blank filters', async () => {
    pages(http, [speech(1, { procedural: true })], {
      time__gte: '2026-10-19',
      procedural: undefined,
    });
    const data = await success({
      substantiveOnly: false,
      politician: ' ',
      dateTo: '',
      contains: '',
    });
    expect(data).toMatchObject({
      shown: 1,
      appliedFilters: { substantiveOnly: false, contains: null, politician: null, dateTo: null },
    });
  });
  it.each([{}, { contains: 'something' }, { politician: ' ', dateFrom: '', dateTo: ' ' }])(
    'requires a nonblank scope %j',
    async (input) => {
      await fail(input, 'speech_scope_required');
      expect(http.calls).toHaveLength(0);
    },
  );
  const slug = 'Expected an OpenParliament politician slug';
  const session = 'Expected a parliament-session token such as 45-1';
  const code = 'Expected a House or Senate bill code such as C-15';
  const date = 'Expected a real calendar date written YYYY-MM-DD';
  it.each<[Record<string, unknown>, FilterRejection]>([
    [{ politician: 'First Last' }, { field: 'politician', rejected: 'First Last', shape: slug }],
    [
      { politician: 'https://evil.test/politicians/river-example/' },
      { field: 'politician', rejected: 'evil.test', shape: slug },
    ],
    [{ politician: 'https://' }, { field: 'politician', rejected: 'https://', shape: slug }],
    [
      { billDebated: { session: '45-0', code: 'S321' } },
      { field: 'billDebated.session', rejected: '45-0', shape: session },
    ],
    [
      { mentionedBill: { session: '9007199254740992-1', code: 'S321' } },
      { field: 'mentionedBill.session', rejected: '9007199254740992-1', shape: session },
    ],
    [{ dateFrom: '2026-02-30' }, { field: 'dateFrom', rejected: '2026-02-30', shape: date }],
    [
      { dateTo: '9999-12-31' },
      { field: 'dateTo', rejected: '', shape: 'Expected a date before 9999-12-31' },
    ],
    [
      { dateFrom: '2026-10-20', dateTo: '2026-10-19' },
      { field: 'dateFrom', rejected: '2026-10-2', shape: 'Expected a date no later than dateTo' },
    ],
  ])('returns invalid filter recovery %j', async (input, expected) => {
    const result = await call(input);
    failure(
      result,
      searchSpeechesTool.errors!.find((error) => error.reason === 'invalid_speech_filter')!,
    );
    assertFilterRejection(result, expected);
    expect(http.calls).toHaveLength(0);
  });
  it.each<[Record<string, unknown>, ArgumentRejection]>([
    [{ billDebated: {} }, { lines: ['billDebated.session', 'billDebated.code'], rejected: '' }],
    [{ mentionedBill: { code: 'S321' } }, { lines: ['mentionedBill.session'], rejected: '' }],
    [
      { billDebated: { session: '45-1', code: '' } },
      { lines: [`billDebated.code: ${code}`], rejected: '' },
    ],
    [
      { billDebated: { session: '', code: 'S321' } },
      { lines: [`billDebated.session: ${session}`], rejected: '' },
    ],
    [
      { mentionedBill: { session: '45/1', code: 'S321' } },
      { lines: [`mentionedBill.session: ${session}`], rejected: '45/1' },
    ],
    [
      { mentionedBill: { session: '45-1', code: 'C-0' } },
      { lines: [`mentionedBill.code: ${code}`], rejected: 'C-0' },
    ],
    [
      { mentionedBill: { session: '45-1', code: 'C - 9' } },
      { lines: [`mentionedBill.code: ${code}`], rejected: 'C - 9' },
    ],
    [{ dateFrom: 'yesterday' }, { lines: [`dateFrom: ${date}.`], rejected: 'yesterday' }],
    [{ dateTo: '2026/10/20' }, { lines: [`dateTo: ${date}.`], rejected: '2026/10/20' }],
  ])('rejects %j by its advertised format before HTTP', async (input, expected) => {
    assertArgumentRejection(await call(input), expected);
    expect(http.calls).toHaveLength(0);
  });
  it.each([
    ['speech_scope_required', {}],
    ['invalid_speech_filter', { dateFrom: '2026-02-30' }],
  ])('declares %s not retryable on both surfaces', async (reason, input) => {
    const result = await call(input);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, retryable: false } },
    });
    expect(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain(`(reason ${reason} · not retryable`);
  });
  it.each([{ politician: 'river-example' }, { billDebated: { session: '45-1', code: 'S321' } }])(
    'maps absent scope entity %j',
    async (input) => {
      http.route({ match: () => true, respond: new Response('missing', { status: 404 }) });
      const result = await call(input);
      failure(
        result,
        searchSpeechesTool.errors!.find((error) => error.reason === 'speech_entity_not_found')!,
      );
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'speech_entity_not_found', retryable: false } },
      });
      expect(
        result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('(reason speech_entity_not_found · not retryable');
      expect(http.calls).toHaveLength(1);
    },
  );
  it.each([
    { limit: 0 },
    { limit: 10_001 },
    { offset: -1 },
    { billDebated: { session: '45-1', code: 'S321', other: true } },
    { language: 'de' },
    { language: 'FR' },
    { language: '' },
  ])('rejects schema-invalid input %j', async (input) => {
    expect((await call(input)).structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });
  it.each([
    { procedural: true },
    { procedural: null },
    { time: '2026-10-18 23:59:59' },
    { time: '2026-10-20 00:00:00' },
    { politician_url: '/politicians/different-person/' },
  ])('fails closed for ignored upstream filters %j', async (extra) => {
    profile(http);
    pages(http, [speech(1, extra)], {
      politician: actor,
      time__gte: '2026-10-19',
      time__lt: '2026-10-20',
    });
    await fail(
      { politician: 'river-example', dateFrom: '2026-10-19', dateTo: '2026-10-19' },
      'upstream_filter_not_honored',
    );
  });
  it.each([
    { start_date: '2026-10-20' },
    { end_date: '2026-10-18' },
    { start_date: null },
    { politician_url: '/politicians/different-person/' },
  ])('does not substitute current affiliation for invalid membership %j', async (extra) => {
    pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
    http.route({ match: `${api}${member}`, respond: Response.json(membership(extra)) });
    expect(await success()).toMatchObject({
      speeches: [{ party: null, riding: null }],
      notice: expect.stringContaining('unavailable'),
    });
  });
  it('deduplicates only returned memberships, not every scanned candidate', async () => {
    pages(
      http,
      [
        speech(1, {
          content: { en: 'ignore' },
          politician_membership_url: '/politicians/memberships/902/',
        }),
        speech(2, { politician_membership_url: member }),
        speech(3, { politician_membership_url: member }),
      ],
      { time__gte: '2026-10-19' },
    );
    http.route({ match: `${api}${member}`, respond: Response.json(membership()) });
    expect(await success({ contains: 'École' })).toMatchObject({ shown: 2, scanned: 3 });
    expect(http.calls).toHaveLength(2);
  });
  it.each([404, 503, 429])(
    'preserves speeches when optional affiliation returns %i',
    async (status) => {
      pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
      http.route({ match: `${api}${member}`, respond: new Response('unavailable', { status }) });
      expect(await success()).toMatchObject({
        speeches: [{ party: null, riding: null }],
        notice: expect.stringContaining('SourceUnavailable'),
      });
    },
  );
  it('honors caller cancellation during membership without a partial success', async () => {
    const caller = new AbortController();
    pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
    http.route({
      match: `${api}${member}`,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
          caller.abort();
        }),
    });
    const result = await settle(
      runToolContract(
        searchSpeechesTool,
        { dateFrom: '2026-10-19' },
        { context: { signal: caller.signal } },
      ),
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('cancel') }),
      ]),
    );
    expect(http.calls).toHaveLength(2);
  });
  it('hydrates at most ten distinct returned memberships within the shared cold budget', async () => {
    pages(
      http,
      Array.from({ length: 10 }, (_, i) =>
        speech(i, { politician_membership_url: `/politicians/memberships/${i + 1}/` }),
      ),
      { time__gte: '2026-10-19' },
    );
    http.route({
      match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
      respond: (request) => Response.json(membership({ url: new URL(request.url).pathname })),
    });
    expect(await success({ limit: 10 })).toMatchObject({
      shown: 10,
      scanned: 10,
      exhausted: true,
      notice:
        'substantiveOnly=true excludes procedural remarks; set substantiveOnly=false to include them.',
    });
    expect(http.calls).toHaveLength(11);
  });
  it.each([11, 10_000])(
    'clamps limit %i to ten matches and ten membership hydrations',
    async (limit) => {
      pages(
        http,
        Array.from({ length: 30 }, (_, i) =>
          speech(i, { politician_membership_url: `/politicians/memberships/${i + 1}/` }),
        ),
        { time__gte: '2026-10-19' },
      );
      http.route({
        match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
        respond: (request) => Response.json(membership({ url: new URL(request.url).pathname })),
      });
      const notice = `limit ${limit} exceeds the per-call maximum of 10; returned up to 10. substantiveOnly=true excludes procedural remarks; set substantiveOnly=false to include them.`;
      expect(await success({ limit })).toMatchObject({
        shown: 10,
        cap: 10,
        scanned: 10,
        exhausted: false,
        truncated: true,
        nextOffset: 10,
        notice,
      });
      expect(http.calls).toHaveLength(11);
      const rest = await success({ limit, offset: 20 });
      expect(rest).toMatchObject({ shown: 10, cap: 10, scanned: 10, exhausted: true, notice });
      expect((rest.speeches as { id: string }[]).at(-1)?.id).toBe('29');
      expect(http.calls).toHaveLength(22);
    },
  );
  it('returns speeches when only the optional 45 second child budget expires', async () => {
    pages(
      http,
      Array.from({ length: 10 }, (_, i) =>
        speech(i, { politician_membership_url: `/politicians/memberships/${i + 1}/` }),
      ),
      { time__gte: '2026-10-19' },
    );
    http.route({
      match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
      respond: (request) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(Response.json(membership({ url: new URL(request.url).pathname }))),
            6_000,
          );
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(request.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const pending = runToolContract(searchSpeechesTool, { dateFrom: '2026-10-19', limit: 10 });
    await vi.advanceTimersByTimeAsync(45_001);
    const data = parity(await pending, searchSpeechesTool);
    expect(data).toMatchObject({ shown: 10, notice: expect.stringContaining('Timeout') });
    const callsAtDeadline = http.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.calls).toHaveLength(callsAtDeadline);
  });
  it('finishes the candidate scan when early matches hang on membership lookups', async () => {
    pages(
      http,
      Array.from({ length: 100 }, (_, i) => (i < 2 ? long(i, 10) : speech(i))),
      { time__gte: '2026-10-19' },
      false,
    );
    http.route({
      match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
      respond: (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    });
    const pending = runToolContract(searchSpeechesTool, {
      dateFrom: '2026-10-19',
      limit: 10,
      contains: 'marker',
    });
    await vi.advanceTimersByTimeAsync(50_001);
    const data = parity(await pending, searchSpeechesTool);
    expect(data).toMatchObject({
      shown: 2,
      scanned: 100,
      nextOffset: 100,
      exhausted: false,
      speeches: [{ party: null }, { party: null }],
      notice: expect.stringContaining('unavailable (Timeout)'),
    });
    expect(pageCalls()).toBe(5);
  });
  it('fails required scans on budget exhaustion rather than returning a negative result', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname === '/speeches/',
      respond: (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    });
    const pending = runToolContract(searchSpeechesTool, { dateFrom: '2026-10-19' });
    await vi.advanceTimersByTimeAsync(50_001);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
  });
  it('returns each oversized speech whole and alone, continuing at the next candidate', async () => {
    const prose = 'École 中文 [literal].*\n'.repeat(800);
    pages(
      http,
      Array.from({ length: 20 }, (_, i) => speech(i, { content: { en: prose } })),
      { time__gte: '2026-10-19' },
    );
    for (const offset of [0, 1]) {
      const reply = await call({ dateFrom: '2026-10-19', limit: 10, offset });
      const data = parity(reply, searchSpeechesTool);
      expect(data).toMatchObject({
        shown: 1,
        scanned: 1,
        exhausted: false,
        nextOffset: offset + 1,
        truncated: true,
        notice: `${SUBSTANTIVE} ${MISSING} ${oversized}`,
      });
      expect(data.speeches).toMatchObject([{ id: String(offset), content: prose }]);
      expect(wireBytes(reply)).toBeGreaterThan(RESPONSE_BUDGET);
    }
    expect(pageCalls()).toBe(2);
  });
  it('stops at the first match that does not fit and resumes from it', async () => {
    memberships();
    pages(
      http,
      [
        long(0, 3_800),
        long(1, 3_800, { document_url: '/committees/finance/1/' }),
        long(2, 3_800),
        long(3, 3_800),
        long(4, 3_800),
      ],
      { time__gte: '2026-10-19' },
    );
    const first = await success({ limit: 10 });
    expect(first).toMatchObject({
      shown: 2,
      scanned: 3,
      excludedCommittees: 1,
      exhausted: false,
      nextOffset: 3,
      truncated: true,
      notice: `${SUBSTANTIVE} ${EXCLUDED} ${budgetNotice(2)}`,
    });
    expect(ids(first)).toEqual(['0', '2']);
    expect(first.speeches).toMatchObject([
      { party: 'Historical [party]' },
      { party: 'Historical [party]' },
    ]);
    expect(provenancePaths(first)).toEqual([
      '/speeches/',
      '/politicians/memberships/1/',
      '/politicians/memberships/3/',
    ]);
    expect(membershipCalls()).toEqual(['1', '3']);
    expect(pageCalls()).toBe(1);
    const rest = await success({ limit: 10, offset: 3 });
    expect(ids(rest)).toEqual(['3', '4']);
    expect(rest).toMatchObject({ scanned: 2, nextOffset: null, exhausted: true, truncated: false });
  });
  it.each([undefined, 'marker'])(
    'returns every match exactly once across budget pages with contains %s',
    async (contains) => {
      memberships();
      const rows = Array.from({ length: 30 }, (_, i) =>
        i % 5 === 1
          ? speech(i, { document_url: '/committees/finance/1/' })
          : i % 5 === 3
            ? speech(i)
            : long(i, 3_800),
      );
      pages(http, rows, { time__gte: '2026-10-19' });
      const expected = rows
        .filter((_, i) => i % 5 !== 1 && (!contains || i % 5 !== 3))
        .map((row) => row.source_id);
      const seen: string[] = [];
      let offset = 0;
      for (;;) {
        const data = await success({ limit: 10, offset, ...(contains ? { contains } : {}) });
        seen.push(...ids(data));
        expect(data.nextOffset).toBe(data.exhausted ? null : offset + (data.scanned as number));
        if (data.exhausted) break;
        expect(data.notice).toContain(budgetNotice(ids(data).length));
        offset = data.nextOffset as number;
      }
      expect(seen).toEqual(expected);
    },
  );
  /** A House speech with short English and French text holding `marqueur` and `chars` letters. */
  const longFrench = (id: number, chars: number) =>
    speech(id, {
      content: { en: '<p>short</p>', fr: `<p>marqueur ${'a'.repeat(chars)}</p>` },
      politician_membership_url: `/politicians/memberships/${id + 1}/`,
    });
  it('measures the budget on the selected language, returning an oversized French speech whole', async () => {
    memberships();
    pages(http, [longFrench(0, 30_000), longFrench(1, 10)], { time__gte: '2026-10-19' });
    const reply = await call({ dateFrom: '2026-10-19', language: 'fr', limit: 5 });
    const french = parity(reply, searchSpeechesTool);
    expect(french).toMatchObject({
      shown: 1,
      scanned: 1,
      nextOffset: 1,
      exhausted: false,
      truncated: true,
      notice: `${SUBSTANTIVE} ${oversized}`,
    });
    expect(french.speeches).toMatchObject([{ id: '0', content: `marqueur ${'a'.repeat(30_000)}` }]);
    expect(wireBytes(reply)).toBeGreaterThan(RESPONSE_BUDGET);
    expect(await success({ limit: 5 })).toMatchObject({
      shown: 2,
      scanned: 2,
      exhausted: true,
      speeches: [{ content: 'short' }, { content: 'short' }],
      notice: SUBSTANTIVE,
    });
  });
  it.each([undefined, 'marqueur'])(
    'returns every French match exactly once across budget pages with contains %s',
    async (contains) => {
      memberships();
      const rows = Array.from({ length: 30 }, (_, i) =>
        i % 5 === 1
          ? speech(i, { document_url: '/committees/finance/1/' })
          : i % 5 === 3
            ? speech(i, { content: { en: '<p>marqueur in English only</p>' } })
            : longFrench(i, 3_800),
      );
      pages(http, rows, { time__gte: '2026-10-19' });
      const filters = contains ? { contains } : {};
      // English measures its own short text: one page of ten (or the six English-only markers).
      const english = await success({ limit: 10, ...filters });
      expect(english).toMatchObject({
        shown: contains ? 6 : 10,
        notice: expect.not.stringContaining('budget'),
      });
      const expected = rows
        .filter((_, i) => i % 5 !== 1 && (!contains || i % 5 !== 3))
        .map((row) => row.source_id);
      const seen: string[] = [];
      /** Candidates without French text that the walk's notices disclosed. */
      let disclosed = 0;
      let offset = 0;
      for (;;) {
        const data = await success({ limit: 10, offset, language: 'fr', ...filters });
        seen.push(...ids(data));
        disclosed += Number(
          / (\d+) scanned candidates? had no French text/.exec(data.notice as string)?.[1] ?? 0,
        );
        expect(data.nextOffset).toBe(data.exhausted ? null : offset + (data.scanned as number));
        if (data.exhausted) break;
        expect(data.notice).toContain(budgetNotice(ids(data).length));
        offset = data.nextOffset as number;
      }
      expect(seen).toEqual(expected);
      expect(seen.length).toBeGreaterThan(10);
      // Each English-only row is disclosed once across the walk, even where a page rewinds.
      expect(disclosed).toBe(contains ? 6 : 0);
    },
  );
  it('ends an oversized last candidate of a terminal page as exhausted', async () => {
    pages(http, [speech(0, { content: { en: `<p>${'a'.repeat(30_000)}</p>` } })], {
      time__gte: '2026-10-19',
    });
    expect(await success({ limit: 5 })).toMatchObject({
      shown: 1,
      scanned: 1,
      exhausted: true,
      nextOffset: null,
      truncated: false,
      notice: `${SUBSTANTIVE} ${MISSING} The response exceeds the 24000-byte budget with one speech, returned whole.`,
    });
  });
  it('fetches no candidate page after a sparse scan fills the page', async () => {
    memberships();
    pages(
      http,
      Array.from({ length: 100 }, (_, i) => (i % 20 === 0 ? long(i, 7_000) : speech(i))),
      { time__gte: '2026-10-19' },
      false,
    );
    const data = await success({ limit: 10, contains: 'marker' });
    expect(data).toMatchObject({
      shown: 1,
      scanned: 20,
      nextOffset: 20,
      exhausted: false,
      truncated: true,
      notice: `${SUBSTANTIVE} ${budgetNotice(1)}`,
    });
    expect(pageCalls()).toBe(2);
    expect(membershipCalls()).toEqual(['1']);
    expect(provenancePaths(data)).toEqual([
      '/speeches/',
      '/speeches/',
      '/politicians/memberships/1/',
    ]);
  });
  it('hydrates after the scan and ends the page before a match whose affiliation outgrows the budget', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname.startsWith('/politicians/memberships/'),
      respond: (request) =>
        Response.json(
          membership({
            url: new URL(request.url).pathname,
            riding: { name: { en: 'r'.repeat(5_000) }, province: 'ON' },
          }),
        ),
    });
    pages(
      http,
      Array.from({ length: 21 }, (_, i) => (i % 20 === 0 ? long(i, 3_000) : speech(i))),
      { time__gte: '2026-10-19' },
    );
    const reply = await call({ dateFrom: '2026-10-19', limit: 10, contains: 'marker' });
    const data = parity(reply, searchSpeechesTool);
    expect(data).toMatchObject({
      shown: 1,
      scanned: 20,
      nextOffset: 20,
      exhausted: false,
      truncated: true,
      notice: `${SUBSTANTIVE} ${budgetNotice(1)}`,
    });
    expect(http.calls.map(({ request }) => new URL(request.url).pathname)).toEqual([
      '/speeches/',
      '/speeches/',
      '/politicians/memberships/1/',
      '/politicians/memberships/21/',
    ]);
    expect(provenancePaths(data)).toEqual([
      '/speeches/',
      '/speeches/',
      '/politicians/memberships/1/',
    ]);
    expect(wireBytes(reply)).toBeLessThanOrEqual(RESPONSE_BUDGET);
    const rest = await success({ limit: 10, offset: 20, contains: 'marker' });
    expect(ids(rest)).toEqual(['20']);
    expect(rest).toMatchObject({ exhausted: true, nextOffset: null });
  });
  /** Body length that puts a one-speech, one-page response near `target` wire bytes. */
  async function sized(target: number) {
    const probe = 4_000;
    memberships();
    pages(http, [long(99, probe)], { time__gte: '2026-10-19', time__lt: '2026-10-20' });
    const reply = await call({ dateFrom: '2026-10-19', dateTo: '2026-10-19', contains: 'marker' });
    http.reset();
    return probe + Math.floor((target - wireBytes(reply)) / 2);
  }
  it('ends the page after the last fitting speech when later candidate pages outgrow the budget', async () => {
    const chars = await sized(23_100);
    memberships();
    pages(
      http,
      Array.from({ length: 100 }, (_, i) => (i === 0 ? long(0, chars) : speech(i))),
      { time__gte: '2026-10-19' },
      false,
    );
    const reply = await call({ dateFrom: '2026-10-19', limit: 10, contains: 'marker' });
    const data = parity(reply, searchSpeechesTool);
    expect(data).toMatchObject({
      shown: 1,
      scanned: 1,
      nextOffset: 1,
      exhausted: false,
      truncated: true,
      notice: `${SUBSTANTIVE} ${budgetNotice(1)}`,
    });
    expect(pageCalls()).toBe(5);
    expect(provenancePaths(data)).toEqual(['/speeches/', '/politicians/memberships/1/']);
    expect(wireBytes(reply)).toBeLessThanOrEqual(RESPONSE_BUDGET);
  });
  it('ends the page after the last fitting speech when a rejected match follows outgrown candidate pages', async () => {
    const chars = await sized(23_100);
    memberships();
    pages(
      http,
      Array.from({ length: 100 }, (_, i) =>
        i === 0 ? long(0, chars) : i === 60 ? long(60, 10) : speech(i),
      ),
      { time__gte: '2026-10-19' },
      false,
    );
    const reply = await call({ dateFrom: '2026-10-19', limit: 10, contains: 'marker' });
    const data = parity(reply, searchSpeechesTool);
    expect(data).toMatchObject({
      shown: 1,
      scanned: 1,
      nextOffset: 1,
      exhausted: false,
      notice: `${SUBSTANTIVE} ${budgetNotice(1)}`,
    });
    expect(pageCalls()).toBe(4);
    expect(membershipCalls()).toEqual(['1']);
    expect(provenancePaths(data)).toEqual(['/speeches/', '/politicians/memberships/1/']);
    expect(wireBytes(reply)).toBeLessThanOrEqual(RESPONSE_BUDGET);
  });
  it('never turns outer deadline expiry during optional membership into partial success', async () => {
    pages(http, [speech(1, { politician_membership_url: member })], { time__gte: '2026-10-19' });
    http.route({
      match: `${api}${member}`,
      respond: () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(Response.json(membership())), 51_000),
        ),
    });
    const pending = runToolContract(searchSpeechesTool, { dateFrom: '2026-10-19' });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('50 second') }),
      ]),
    );
    expect(http.calls).toHaveLength(2);
  });
});

describe('canparl_search_speeches speaker identity', () => {
  const namePage = `${api}/politicians/?limit=4&offset=0&include=all&name=River+Example`;
  const notFound = searchSpeechesTool.errors!.find(
    (error) => error.reason === 'speech_entity_not_found',
  )!;
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
    initOurCommonsService({ userAgent: 'synthetic-speech-tests' });
  });
  afterEach(() => {
    disposeOurCommonsService();
    teardown(http);
  });
  const roster = (...ids: number[]) =>
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection(
          'ArrayOfMemberOfParliament',
          'MemberOfParliament',
          ids.map((id) => rawPerson(id)),
        ),
      ),
    });
  const politician = (path: string, extra: Record<string, unknown> = {}) =>
    http.route({
      match: `${api}${path}`,
      respond: Response.json({ url: path, name: 'River Example', ...extra }),
    });
  const candidates = (paths: string[], next = false) =>
    http.route({
      match: namePage,
      respond: Response.json({
        objects: paths.map((url) => ({ url, name: 'River Example' })),
        pagination: {
          offset: 0,
          limit: 4,
          next_url: next ? namePage.replace('offset=0', 'offset=4') : null,
        },
      }),
    });
  const call = (input: Record<string, unknown>) =>
    settle(runToolContract(searchSpeechesTool, { dateFrom: '2026-10-01', ...input }));
  const urls = () => http.calls.map((c) => c.request.url);

  it('scans by the verified profile when politician is a current personId', async () => {
    roster(2897);
    candidates([actor]);
    politician(actor, { other_info: { parl_mp_id: ['2897'] } });
    politician('/politicians/2897/', { name: 'Unrelated Candidate' });
    pages(http, [speech(1)], { politician: actor, time__gte: '2026-10-01' });
    const data = parity(await call({ politician: ' 2897 ' }), searchSpeechesTool);
    expect(data).toMatchObject({
      speeches: [{ id: '1', politician: 'river-example' }],
      appliedFilters: { politician: 'river-example', politicianName: 'River Example' },
    });
    expect(urls().filter((url) => !new URL(url).pathname.startsWith('/speeches/'))).toEqual([
      rosterUrl,
      namePage,
      `${api}${actor}`,
    ]);
  });
  it('resolves Judy Sgro through the surname fallback for politician personId 1787', async () => {
    const judy = '/politicians/judy-sgro/';
    http.route({
      match: rosterUrl,
      respond: new Response(
        collection('ArrayOfMemberOfParliament', 'MemberOfParliament', [
          rawPerson(1787, { PersonOfficialFirstName: 'Judy A.', PersonOfficialLastName: 'Sgro' }),
        ]),
      ),
    });
    const exact = `${api}/politicians/?limit=4&offset=0&include=all&name=Judy+A.+Sgro`;
    const surname = `${api}/politicians/?limit=4&offset=0&include=all&family_name=Sgro`;
    http.route(
      {
        match: exact,
        respond: Response.json({
          objects: [],
          pagination: { offset: 0, limit: 4, next_url: null },
        }),
      },
      {
        match: surname,
        respond: Response.json({
          objects: [{ url: judy, name: 'Judy Sgro' }],
          pagination: { offset: 0, limit: 4, next_url: null },
        }),
      },
    );
    politician(judy, {
      name: 'Judy Sgro',
      other_info: { parl_mp_id: ['1787'], alternate_name: ['judy a. sgro'] },
    });
    pages(http, [speech(1, { politician_url: judy })], {
      politician: judy,
      time__gte: '2026-10-01',
    });
    expect(parity(await call({ politician: '1787' }), searchSpeechesTool)).toMatchObject({
      speeches: [{ politician: 'judy-sgro' }],
      appliedFilters: { politician: 'judy-sgro', politicianName: 'Judy Sgro' },
    });
    expect(urls().filter((url) => !new URL(url).pathname.startsWith('/speeches/'))).toEqual([
      rosterUrl,
      exact,
      surname,
      `${api}${judy}`,
    ]);
  });
  it.each(['/politicians/2897/', 'https://api.openparliament.ca/politicians/2897/'])(
    'reads politician %j, holding a current personId, through the verified crosswalk',
    async (input) => {
      roster(2897);
      candidates([actor]);
      politician(actor, { other_info: { parl_mp_id: ['2897'] } });
      pages(http, [speech(1)], { politician: actor, time__gte: '2026-10-01' });
      expect(parity(await call({ politician: input }), searchSpeechesTool)).toMatchObject({
        appliedFilters: { politician: 'river-example', politicianName: 'River Example' },
      });
      expect(urls().filter((url) => !new URL(url).pathname.startsWith('/speeches/'))).toEqual([
        rosterUrl,
        namePage,
        `${api}${actor}`,
      ]);
    },
  );
  it('describes how politician reads a current personId', () => {
    expect(searchSpeechesTool.input.shape.politician.description).toBe(
      "Speaker OpenParliament slug or exact politician path/HTTPS URL (member.slug from canparl_get_member, or an includeFormer canparl_search_members row), or a current MP's official personId. A digit-only value equal to a current personId, or its /politicians/<digits>/ path or profile URL, is read as that personId.",
    );
  });
  it.each([
    ['no candidate', [] as string[], false],
    ['several verified candidates', [actor, '/politicians/river-example-2/'], false],
    ['a candidate page continuation', [actor], true],
  ])(
    'fails speech_entity_not_found for a current personId with %s, before scanning',
    async (_case, paths, next) => {
      roster(2897);
      candidates(paths, next);
      const surnamePage = `${api}/politicians/?limit=4&offset=0&include=all&family_name=Example`;
      if (!paths.length)
        http.route({
          match: surnamePage,
          respond: Response.json({
            objects: [],
            pagination: { offset: 0, limit: 4, next_url: null },
          }),
        });
      for (const path of paths) politician(path, { other_info: { parl_mp_id: ['2897'] } });
      failure(await call({ politician: '2897' }), notFound);
      expect(urls().filter((url) => url.startsWith(api))).toEqual([
        namePage,
        ...(!paths.length ? [surnamePage] : []),
        ...(next ? [] : paths.map((path) => `${api}${path}`)),
      ]);
    },
  );
  it('keeps a numeric politician absent from the roster as an OpenParliament ID, read after the roster', async () => {
    roster(1);
    politician('/politicians/5724/', { name: 'Numeric Example' });
    pages(http, [speech(1, { politician_url: '/politicians/5724/' })], {
      politician: '/politicians/5724/',
      time__gte: '2026-10-01',
    });
    const data = parity(await call({ politician: '/politicians/5724/' }), searchSpeechesTool);
    expect(data).toMatchObject({
      speeches: [{ politician: '5724' }],
      appliedFilters: { politician: '5724', politicianName: 'Numeric Example' },
    });
    expect(urls().slice(0, 2)).toEqual([rosterUrl, `${api}/politicians/5724/`]);
  });
  it('fails speech_entity_not_found when a numeric politician answers with another canonical profile', async () => {
    roster(1);
    politician('/politicians/413/', { url: actor });
    failure(await call({ politician: '413' }), notFound);
    expect(urls().some((url) => new URL(url).pathname === '/speeches/')).toBe(false);
  });
  it.each([
    [
      { politician: 'river-example' },
      { politician: 'river-example', politicianName: 'River Example' },
    ],
    [{}, { politician: null, politicianName: null }],
  ])('names the speaker of %j without reading the roster', async (input, applied) => {
    politician(actor);
    pages(http, [speech(1)], {
      ...('politician' in input ? { politician: actor } : {}),
      time__gte: '2026-10-01',
    });
    expect(parity(await call(input), searchSpeechesTool)).toMatchObject({
      appliedFilters: applied,
    });
    expect(urls()).not.toContain(rosterUrl);
  });
});
