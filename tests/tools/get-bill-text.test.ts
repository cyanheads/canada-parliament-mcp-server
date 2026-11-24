/**
 * @fileoverview canparl_get_bill_text contracts through the real LEGISinfo service, XML parser, and
 * tool envelope over captured DocumentViewer pages and bill XML.
 * @module tests/tools/get-bill-text.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBillTextTool } from '@/mcp-server/tools/definitions/get-bill-text.tool.js';
import { parseBillText } from '@/services/legisinfo/bill-text.js';
import {
  billTextFixture,
  capturedRedirects,
  capturedXml,
} from '../fixtures/bill-tools/bill-text.js';
import {
  assertDomainParity,
  assertError,
  assertMeasuredResponse,
  current,
  detail,
  parseMarkdown,
  picker,
  rawBill,
  realDossier,
  sessions,
  settle,
  setup,
  teardown,
  wireBytes,
} from '../fixtures/bill-tools/harness.js';
import { assertArgumentRejection } from '../fixtures/filter-rejection.js';

const ORIGIN = 'https://www.parl.ca';
const viewer = (id: number, language = 'en') => `${ORIGIN}/DocumentViewer/${language}/${id}`;
/** A dossier publication record as LEGISinfo publishes it. */
const publication = (id: number, en: string, fr: string, typeId: number) => ({
  PublicationId: id,
  PublicationTypeId: typeId,
  PublicationTypeNameEn: en,
  PublicationTypeNameFr: fr,
  PublicationTypeName: en,
});
const firstReading = (id: number) => publication(id, 'First Reading', 'Première lecture', 80701);
const royalAssent = (id: number) => publication(id, 'Royal Assent', 'Sanction royale', 80704);
const S2_EXPORT = '/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml';
const C15_EXPORT = '/Content/Bills/451/Government/C-15/C-15_1/C-15_E.xml';
/** The captured S-2 first-reading page head with its XML export link pointed at `href`. */
function pageLinking(href: string): string {
  const page = billTextFixture('viewer-S-2-first-reading.html');
  expect(page).toContain(`href="${S2_EXPORT}"`);
  return page.replace(`href="${S2_EXPORT}"`, `href="${href}"`);
}
/** A minimal well-formed 45-1 bill XML around `body`, the content of its `Body`. */
const syntheticXml = (code: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Bill xml:lang="en"><Identification><BillNumber>${code}</BillNumber><Parliament><Session>1</Session><Number>45</Number></Parliament></Identification><Body>${body}</Body></Bill>`;
/** Independent parse of the trimmed C-15 fixture: the oracle its pages must rebuild. */
const C15 = parseBillText(billTextFixture('C-15_1_E.xml'), {
  session: '45-1',
  billCode: 'C-15',
  language: 'en',
});
const c15 = { session: '45-1', billCode: 'C-15', publicationId: 13752361 };
const RECOVERY = {
  segment:
    'Remove offset and limit, or add segment headings, body, or schedules to page that segment.',
  publication:
    'Retry with a publication ID listed in allowed, or omit publicationId to read the last-listed version.',
  unavailable:
    'Read the version on its DocumentViewer page, the url in canparl_get_bill publications; sessions before 42-1 often have no XML text for any version.',
};

describe('canparl_get_bill_text production contract', () => {
  let http: ReturnType<typeof setup>;
  beforeEach(() => {
    http = setup();
    sessions(http, ['45-1', '41-2', '37-1']);
  });
  afterEach(() => teardown(http));
  const call = (input: Record<string, unknown>) =>
    // Deliberately permit malformed fixtures to reach the production input validator.
    settle(runToolContract(getBillTextTool, input as { billCode: string; session?: unknown }));
  const urls = () => http.calls.map((entry) => entry.request.url);
  /** Text a CommonMark reader sees in the domain block of `content[]`. */
  const bodyText = (reply: Awaited<ReturnType<typeof call>>) => {
    const [block] = reply.content;
    return parseMarkdown(block?.type === 'text' ? block.text : '').text;
  };
  /** Both surfaces carry the same complete body, and the shared measure equals the wire. */
  function check(result: Awaited<ReturnType<typeof call>>) {
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    const domain = getBillTextTool.output.parse(structured);
    assertDomainParity(domain, getBillTextTool.format!(domain));
    assertDomainParity(domain, result.content.slice(0, 1));
    for (const [key, schema] of Object.entries(getBillTextTool.enrichment!))
      schema.parse(structured[key]);
    assertMeasuredResponse(result, getBillTextTool);
    return domain;
  }
  /** Serve one bill's dossier listing `publications` (null: no publication records). */
  function routeBill(code: string, publications: unknown[] | null, session = '45-1') {
    const [parliament, number] = session.split('-').map(Number);
    http.route({
      match: detail(code, session),
      respond: Response.json([
        rawBill(code, {
          ParliamentNumber: parliament,
          SessionNumber: number,
          Publications: publications,
        }),
      ]),
    });
  }
  /** Serve a publication's DocumentViewer redirect and the page it names. */
  function routeViewer(id: number, location: string, page: string, language = 'en') {
    http.route(
      {
        match: viewer(id, language),
        respond: new Response(null, { status: 302, headers: { location } }),
      },
      { match: new URL(location, ORIGIN).href, respond: new Response(page) },
    );
  }
  const routeXml = (url: string, xml: string) =>
    http.route({ match: url, respond: new Response(xml) });
  function routeC202() {
    routeBill('C-202', [firstReading(13000001), royalAssent(13577949)]);
    routeViewer(
      13577949,
      capturedRedirects.c202RoyalAssent,
      billTextFixture('viewer-C-202-royal-assent.html'),
    );
    routeXml(capturedXml.c202En, billTextFixture('C-202_4_E.xml'));
  }
  const S2_PUBLICATIONS = [
    firstReading(13542656),
    publication(13810695, 'As passed by the Senate', 'Tel qu’adopté par le Sénat', 80703),
  ];
  function routeS2(language: 'en' | 'fr' = 'en') {
    routeBill('S-2', S2_PUBLICATIONS);
    if (language === 'en')
      routeViewer(
        13542656,
        capturedRedirects.s2FirstReading,
        billTextFixture('viewer-S-2-first-reading.html'),
      );
    else
      routeViewer(
        13542656,
        capturedRedirects.s2PremiereLecture,
        billTextFixture('viewer-S-2-premiere-lecture.html'),
        'fr',
      );
    routeXml(
      language === 'en' ? capturedXml.s2En : capturedXml.s2Fr,
      billTextFixture(language === 'en' ? 'S-2_1_E.xml' : 'S-2_1_F.xml'),
    );
  }
  function routeC15() {
    http.route({ match: detail('C-15'), respond: new Response(realDossier('45-1-c-15')) });
    routeViewer(
      13752361,
      '/documentviewer/en/45-1/bill/C-15/first-reading',
      pageLinking(C15_EXPORT),
    );
    routeXml(`${ORIGIN}${C15_EXPORT}`, billTextFixture('C-15_1_E.xml'));
  }

  it('returns 45-1 C-202 whole at its default Royal Assent publication 13577949', async () => {
    routeC202();
    const reply = await call({ session: '45-1', billCode: 'C-202' });
    const text = check(reply);
    expect(Object.keys(text)).toEqual([
      'bill',
      'publication',
      'introduction',
      'headings',
      'body',
      'schedules',
      'provenance',
    ]);
    expect(text.bill).toMatchObject({ session: '45-1', billCode: 'C-202' });
    expect(text.publication).toEqual({
      id: 13577949,
      typeId: 80704,
      type: { en: 'Royal Assent', fr: 'Sanction royale' },
      url: 'https://www.parl.ca/DocumentViewer/en/13577949',
      xmlUrl: 'https://www.parl.ca/Content/Bills/451/Private/C-202/C-202_4/C-202_E.xml',
      stage: 'assented-to',
      stageDate: '2025-06-26',
      longTitle:
        'An Act to amend the Department of Foreign Affairs, Trade and Development Act (supply management)',
      shortTitle: null,
      sponsor: null,
    });
    expect(text.body).toHaveLength(1);
    expect(text.body?.[0]).toMatchObject({
      label: '1',
      marginalNote: null,
      headings: ['Department of Foreign Affairs, Trade and Development Act'],
      explanatoryNotes: null,
    });
    expect(text.headings).toEqual([
      {
        index: 0,
        level: 1,
        label: null,
        title: 'Department of Foreign Affairs, Trade and Development Act',
        citation: '2013, c. 33, s. 174',
        offset: 0,
        count: 1,
        firstLabel: '1',
        lastLabel: '1',
        characters: text.body?.[0]?.text?.length,
      },
    ]);
    expect(text.introduction).toMatchObject({
      recommendation: null,
      preamble: null,
      explanatoryNotes: null,
      enactingClause:
        'His Majesty, by and with the advice and consent of the Senate and House of Commons of Canada, enacts as follows:',
    });
    expect(text.schedules).toEqual([]);
    expect(reply.structuredContent).toMatchObject({
      appliedFilters: {
        session: '45-1',
        billCode: 'C-202',
        publicationId: 13577949,
        language: 'en',
      },
    });
    expect(reply.structuredContent).not.toHaveProperty('notice');
    expect(urls()).toEqual([
      picker,
      detail('C-202'),
      viewer(13577949),
      'https://www.parl.ca/documentviewer/en/45-1/bill/C-202/royal-assent',
      capturedXml.c202En,
    ]);
    expect(text.provenance.map(({ url, cached }) => [url, cached])).toEqual([
      [picker, false],
      [detail('C-202'), false],
      [viewer(13577949), false],
      [capturedXml.c202En, false],
    ]);
    expect(wireBytes(reply)).toBeLessThanOrEqual(24_000);
  });

  it('serves a repeat call for the same publication and language without a viewer or XML request', async () => {
    routeC202();
    const first = check(await call({ session: '45-1', billCode: 'C-202' }));
    const requests = http.calls.length;
    const repeat = check(await call({ session: '45-1', billCode: 'C-202' }));
    expect(http.calls).toHaveLength(requests);
    expect(repeat.body).toEqual(first.body);
    expect(repeat.provenance.slice(2)).toEqual(
      first.provenance.slice(2).map((source) => ({ ...source, cached: true })),
    );
  });

  it('defaults 45-1 S-2 to its last-listed publication 13810695', async () => {
    routeBill('S-2', S2_PUBLICATIONS);
    const export3 = '/Content/Bills/451/Government/S-2/S-2_3/S-2_E.xml';
    routeViewer(13810695, '/documentviewer/en/45-1/bill/S-2/third-reading', pageLinking(export3));
    // The first-reading XML stands in for the S-2_3 body; this case pins the version chosen.
    routeXml(`${ORIGIN}${export3}`, billTextFixture('S-2_1_E.xml'));
    const reply = await call({ session: '45-1', billCode: 'S-2', segment: 'introduction' });
    const text = check(reply);
    expect(text.publication).toMatchObject({
      id: 13810695,
      typeId: 80703,
      type: { en: 'As passed by the Senate', fr: 'Tel qu’adopté par le Sénat' },
      url: viewer(13810695),
      xmlUrl: `${ORIGIN}${export3}`,
    });
    expect(reply.structuredContent).toMatchObject({ appliedFilters: { publicationId: 13810695 } });
    expect(urls()).toContain(viewer(13810695));
    expect(urls()).not.toContain(viewer(13542656));
  });

  it('reads S-2 13542656 section 1 with its existing-text note only in explanatoryNotes', async () => {
    routeS2();
    const reply = await call({
      session: '45-1',
      billCode: 'S-2',
      publicationId: 13542656,
      segment: 'body',
    });
    const page = check(reply);
    expect(page).toMatchObject({
      kind: 'segment',
      totalCount: 11,
      pagination: { segment: 'body', offset: 0, limit: 5, total: 11, nextOffset: 5 },
      publication: {
        id: 13542656,
        xmlUrl: capturedXml.s2En,
        stage: 'first-reading-senate',
        stageDate: '2025-05-29',
        sponsor: 'THE HONOURABLE SENATOR GOLD, P.C.',
      },
    });
    expect(page).not.toHaveProperty('disclosure');
    expect(page.body?.map(({ label }) => label)).toEqual(['1', '2', '3', '4', '5']);
    const [section] = page.body ?? [];
    expect(section?.headings).toEqual(['Indian Act']);
    expect(section?.text).toMatch(
      /^\(1\) The definition mentally incompetent Indian in subsection 2\(1\) of the Indian Act is repealed\.\n/,
    );
    expect(section?.text).not.toContain('Existing text');
    expect(section?.explanatoryNotes).toMatch(
      /^Indian Act\nClause 1: \(1\) Existing text of the definition:\n/,
    );
    expect(bodyText(reply)).toContain('of the Indian Act is repealed.');
  });

  it.each([
    [4, [4, 4, 3], [4, 8, null]],
    [5, [5, 5, 1], [5, 10, null]],
  ])(
    'reads S-2 13542656 in French from S-2_F.xml with the same 11 sections, %i at a time',
    async (limit, expectedSizes, expectedNext) => {
      routeS2('fr');
      const labels: string[] = [];
      const sizes: number[] = [];
      const next: (number | null)[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const reply = await call({
          session: '45-1',
          billCode: 'S-2',
          publicationId: 13542656,
          language: 'fr',
          segment: 'body',
          offset,
          limit,
        });
        const page = check(reply);
        expect(page.publication).toMatchObject({
          url: 'https://www.parl.ca/DocumentViewer/fr/13542656',
          xmlUrl: 'https://www.parl.ca/Content/Bills/451/Government/S-2/S-2_1/S-2_F.xml',
        });
        expect(reply.structuredContent).toMatchObject({ appliedFilters: { language: 'fr' } });
        sizes.push(page.body?.length ?? 0);
        labels.push(...(page.body ?? []).map(({ label }) => label ?? ''));
        offset = page.pagination?.nextOffset ?? null;
        next.push(offset);
      }
      // The last page of a 5-section walk holds one section, which a continuation must still reach.
      expect(sizes).toEqual(expectedSizes);
      expect(next).toEqual(expectedNext);
      expect(labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
      // One viewer, page, and XML read serve every page.
      expect(
        urls().filter((url) => url.includes('/documentviewer/') || url.endsWith('.xml')),
      ).toEqual([
        'https://www.parl.ca/documentviewer/fr/45-1/projet-loi/S-2/premiere-lecture',
        capturedXml.s2Fr,
      ]);
      expect(urls().filter((url) => url === viewer(13542656, 'fr'))).toHaveLength(1);
    },
  );

  it('outlines 45-1 C-15 13752361 with segment counts and its six level-1 headings', async () => {
    routeC15();
    const reply = await call(c15);
    const outline = check(reply);
    expect(Object.keys(outline)).toEqual([
      'kind',
      'bill',
      'publication',
      'segments',
      'headings',
      'disclosure',
      'provenance',
    ]);
    expect(outline.kind).toBe('outline');
    expect(outline.segments).toEqual([
      { name: 'introduction', count: null },
      { name: 'headings', count: 196 },
      { name: 'body', count: 606 },
      { name: 'schedules', count: 6 },
    ]);
    expect(
      outline.headings?.map(({ index, label, offset, count, firstLabel, lastLabel }) => [
        index,
        label,
        offset,
        count,
        firstLabel,
        lastLabel,
      ]),
    ).toEqual([
      [0, null, 0, 1, '1', '1'],
      [1, 'PART 1', 1, 124, '2', '125'],
      [7, 'PART 2', 125, 33, '126', '158'],
      [25, 'PART 3', 158, 18, '159', '176'],
      [38, 'PART 4', 176, 14, '177', '190'],
      [43, 'PART 5', 190, 416, '191', '606'],
    ]);
    expect(outline.headings?.[0]?.title).toBe('Short Title');
    expect(outline.headings?.[5]?.title).toBe('Various Measures');
    expect(outline.publication).toMatchObject({
      id: 13752361,
      typeId: 80701,
      type: { en: 'First Reading', fr: 'Première lecture' },
      url: viewer(13752361),
      xmlUrl: `${ORIGIN}${C15_EXPORT}`,
      stage: 'first-reading-house',
      stageDate: '2025-11-18',
      shortTitle: 'Budget 2025 Implementation Act, No. 1',
      sponsor: 'MINISTER OF FINANCE AND NATIONAL REVENUE',
    });
    expect(outline.disclosure).toBe(
      "Text exceeds the 24000-byte outline threshold. Re-call with segment introduction, headings, body, or schedules; page headings, body, and schedules with offset and limit, and pass a heading's offset with segment body to read its sections. Sections are never split; no text has been discarded.",
    );
    expect(wireBytes(reply)).toBeLessThanOrEqual(24_000);
    // The disclosure's recipe: PART 5's offset opens its first section.
    const part5 = check(await call({ ...c15, segment: 'body', offset: 190, limit: 1 }));
    expect(part5.body?.[0]).toMatchObject({
      label: '191',
      headings: [
        'PART 5 Various Measures',
        'DIVISION 1 High-Speed Rail Network Act',
        'Enactment of Act',
      ],
    });
  });

  it('returns C-15 section 224 whole at body offset 223, limit 1', async () => {
    routeC15();
    const page = check(await call({ ...c15, segment: 'body', offset: 223, limit: 1 }));
    expect(page.body).toEqual([C15.body[223]]);
    expect(page.body?.[0]).toMatchObject({
      label: '224',
      marginalNote: 'Enactment of Act',
      headings: [
        'PART 5 Various Measures',
        'DIVISION 9 Consumer-Driven Banking',
        'Consumer-Driven Banking Act',
      ],
    });
    expect(page.pagination).toEqual({
      segment: 'body',
      offset: 223,
      limit: 1,
      total: 606,
      nextOffset: 224,
    });
  });

  it('pages the C-15 body by whole sections and nextOffset rebuilds it', async () => {
    routeC15();
    const rebuilt: unknown[] = [];
    const sizes: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = check(await call({ ...c15, segment: 'body', offset, limit: 100 }));
      expect(page.pagination).toMatchObject({ segment: 'body', offset, limit: 100, total: 606 });
      sizes.push(page.body?.length ?? 0);
      rebuilt.push(...(page.body ?? []));
      offset = page.pagination?.nextOffset ?? null;
    }
    expect(sizes).toEqual([100, 100, 100, 100, 100, 100, 6]);
    expect(rebuilt).toEqual(C15.body);
  });

  it('pages C-15 headings 50 at a time by default and rebuilds all 196', async () => {
    routeC15();
    const rebuilt: { index: number }[] = [];
    const sizes: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = check(await call({ ...c15, segment: 'headings', offset }));
      expect(page.pagination).toMatchObject({ segment: 'headings', limit: 50, total: 196 });
      sizes.push(page.headings?.length ?? 0);
      rebuilt.push(...(page.headings ?? []));
      offset = page.pagination?.nextOffset ?? null;
    }
    expect(sizes).toEqual([50, 50, 50, 46]);
    expect(rebuilt).toEqual(C15.headings);
    expect(rebuilt.map(({ index }) => index)).toEqual([...Array(196).keys()]);
  });

  it('clamps a limit above 100 to 100 whole sections with a notice', async () => {
    routeC15();
    const reply = await call({ ...c15, segment: 'body', limit: 500 });
    const page = check(reply);
    expect(page.body).toHaveLength(100);
    expect(page.pagination).toEqual({
      segment: 'body',
      offset: 0,
      limit: 100,
      total: 606,
      nextOffset: 100,
    });
    expect(reply.structuredContent).toMatchObject({
      notice: 'limit 500 exceeds the per-call maximum of 100; returned up to 100.',
    });
  });

  it('reports a past-end page and an empty segment explicitly', async () => {
    routeC15();
    const past = check(await call({ ...c15, segment: 'body', offset: 606 }));
    expect(past).toMatchObject({
      kind: 'segment',
      totalCount: 606,
      body: [],
      pagination: { segment: 'body', offset: 606, limit: 5, total: 606, nextOffset: null },
      disclosure:
        'Offset 606 is past the end of the 606 body sections; re-call with an offset below 606.',
    });
    routeC202();
    const empty = check(await call({ session: '45-1', billCode: 'C-202', segment: 'schedules' }));
    expect(empty).toMatchObject({
      kind: 'segment',
      totalCount: 0,
      schedules: [],
      pagination: { segment: 'schedules', offset: 0, limit: 5, total: 0, nextOffset: null },
      disclosure: 'This version has no schedules.',
    });
  });

  it('returns the C-15 introduction whole, without pagination, entities decoded', async () => {
    routeC15();
    const page = check(await call({ ...c15, segment: 'introduction' }));
    expect(Object.keys(page)).toEqual([
      'kind',
      'bill',
      'publication',
      'introduction',
      'provenance',
    ]);
    expect(page.introduction).toEqual(C15.introduction);
    expect(page.introduction?.recommendation).toMatch(/^RECOMMENDATION\nHer Excellency/);
    expect(page.introduction?.summary).toMatch(/^SUMMARY\n/);
    expect(page.introduction?.summary).toContain('SR&ED');
  });

  it('renders a schedule table row as cells joined by " | " on both surfaces', async () => {
    routeC15();
    const reply = await call({ ...c15, segment: 'schedules', offset: 2, limit: 1 });
    const page = check(reply);
    expect(page.schedules?.[0]).toMatchObject({
      label: 'SCHEDULE 3',
      originatingRef: '(Section 290)',
      explanatoryNotes: null,
    });
    expect(page.schedules?.[0]?.text?.split('\n')).toContain('Item | Province | Instrument');
    expect(bodyText(reply)).toContain('Item | Province | Instrument');
  });

  it('treats a blank segment as unset and trims a padded one', async () => {
    routeC202();
    expect(check(await call({ session: '45-1', billCode: 'C-202', segment: '  ' })).kind).toBe(
      undefined,
    );
    expect(
      check(await call({ session: '45-1', billCode: 'C-202', segment: ' headings ' })).pagination,
    ).toMatchObject({ segment: 'headings', total: 1 });
  });

  it('returns the whole text at or below 24000 serialized bytes and the outline above it', async () => {
    let probes = 0;
    /** The unselected response for a one-section bill whose text is `padding` characters. */
    const probe = (padding: number) => {
      const code = `C-${1000 + ++probes}`;
      const id = 900_000 + probes;
      const href = `/Content/Bills/451/Government/${code}/${code}_1/${code}_E.xml`;
      routeBill(code, [firstReading(id)]);
      routeViewer(id, `/documentviewer/en/45-1/bill/${code}/first-reading`, pageLinking(href));
      routeXml(
        `${ORIGIN}${href}`,
        syntheticXml(
          code,
          `<Section><Label>1</Label><Text>${'x'.repeat(padding)}</Text></Section>`,
        ),
      );
      return call({ session: '45-1', billCode: code });
    };
    const kind = (reply: Awaited<ReturnType<typeof call>>) =>
      (reply.structuredContent as { kind?: string }).kind;
    let whole = 0;
    let outlined = 24_000;
    while (outlined - whole > 1) {
      const middle = Math.floor((whole + outlined) / 2);
      if (kind(await probe(middle)) === undefined) whole = middle;
      else outlined = middle;
    }
    const largest = await probe(whole);
    expect(check(largest).kind).toBeUndefined();
    // One more character adds one byte to each surface, crossing the threshold.
    expect(wireBytes(largest)).toBeGreaterThan(23_998);
    expect(wireBytes(largest)).toBeLessThanOrEqual(24_000);
    const outline = check(await probe(outlined));
    expect(outline).toMatchObject({
      kind: 'outline',
      segments: [
        { name: 'introduction', count: null },
        { name: 'headings', count: 0 },
        { name: 'body', count: 1 },
        { name: 'schedules', count: 0 },
      ],
      headings: [],
    });
    // One section of any size returns whole.
    const section = check(
      await call({ session: '45-1', billCode: `C-${1000 + probes}`, segment: 'body' }),
    );
    expect(section.body?.[0]?.text).toBe('x'.repeat(outlined));
  });

  it('resolves an omitted session from the current official feed', async () => {
    http.route({ match: current, respond: Response.json([rawBill('C-202')]) });
    routeC202();
    const reply = await call({ billCode: 'C-202', segment: 'introduction' });
    check(reply);
    expect(reply.structuredContent).toMatchObject({
      appliedFilters: { session: '45-1', billCode: 'C-202', publicationId: 13577949 },
    });
    expect(urls()[0]).toBe(current);
  });

  it.each([
    { offset: 0 },
    { limit: 5 },
    { segment: 'introduction', offset: 1 },
    { segment: 'introduction', limit: 5 },
    { segment: '  ', offset: 3 },
  ])('fails %j as invalid_text_segment before any request', async (paging) => {
    const result = await call({ ...c15, ...paging });
    assertError(result, 'invalid_text_segment', JsonRpcErrorCode.ValidationError, RECOVERY.segment);
    expect(http.calls).toHaveLength(0);
  });

  it('rejects an unknown segment through the schema with the available segments', async () => {
    const result = await call({ ...c15, segment: 'preamble' });
    assertArgumentRejection(result, {
      lines: [
        'segment: Unknown segment. Available segments: introduction, headings, body, schedules.',
      ],
      rejected: 'preamble',
    });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    ['limit', { segment: 'body', limit: 0 }],
    ['limit', { segment: 'body', limit: 10_001 }],
    ['offset', { segment: 'body', offset: -1 }],
    ['publicationId', { publicationId: 0 }],
    ['publicationId', { publicationId: 1.5 }],
    ['language', { language: 'de' }],
  ])('rejects invalid %s %j through the schema before any request', async (field, args) => {
    const result = await call({ session: '45-1', billCode: 'C-15', ...args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(JSON.stringify(result.content)).toContain(field);
    expect(http.calls).toHaveLength(0);
  });

  it('fails a publication ID from another bill as unknown_publication with the allowed IDs', async () => {
    routeBill('S-2', S2_PUBLICATIONS);
    const result = await call({ session: '45-1', billCode: 'S-2', publicationId: 13577949 });
    assertError(
      result,
      'unknown_publication',
      JsonRpcErrorCode.ValidationError,
      RECOVERY.publication,
    );
    expect(result.structuredContent).toMatchObject({
      error: {
        message: "publicationId: Expected one of this bill's publication IDs: 13542656, 13810695.",
        data: { field: 'publicationId', allowed: [13542656, 13810695] },
      },
    });
    expect(JSON.stringify(result)).not.toContain('13577949');
    expect(urls()).toEqual([picker, detail('S-2')]);
  });

  it.each([
    {
      name: '41-2 C-8 6270288, a table-of-contents export',
      message: "The publication's XML export is a table-of-contents cover, not the bill text.",
      route: (scope: Routes) => {
        scope.bill('C-8', [firstReading(6270288)], '41-2');
        scope.viewer(
          6270288,
          capturedRedirects.c8TocFirstReading,
          billTextFixture('viewer-41-2-C-8-toc.html'),
        );
      },
      input: { session: '41-2', billCode: 'C-8' },
      requests: [
        detail('C-8', '41-2'),
        viewer(6270288),
        `${ORIGIN}${capturedRedirects.c8TocFirstReading}`,
      ],
    },
    {
      name: '37-1 C-15A 2336876, a PDF-only version',
      message: 'The publication has no XML export of its text.',
      route: (scope: Routes) => {
        scope.bill('C-15A', [royalAssent(2336876)], '37-1');
        scope.viewer(
          2336876,
          capturedRedirects.c15aRoyalAssent,
          billTextFixture('viewer-37-1-C-15A-pdf-only.html'),
        );
      },
      input: { session: '37-1', billCode: 'C-15A' },
      requests: [
        detail('C-15A', '37-1'),
        viewer(2336876),
        `${ORIGIN}${capturedRedirects.c15aRoyalAssent}`,
      ],
    },
    {
      name: 'a viewer redirect to its error page',
      message: 'The official document viewer has no page for this publication.',
      route: (scope: Routes) => {
        scope.bill('C-901', [firstReading(99999999)]);
        scope.redirect(viewer(99999999), capturedRedirects.viewerError);
      },
      input: { session: '45-1', billCode: 'C-901' },
      requests: [detail('C-901'), viewer(99999999)],
    },
    {
      name: 'an XML redirect to the 404 error page',
      message: "The publication's XML text was not found.",
      route: (scope: Routes) => {
        const missing = '/Content/Bills/451/Government/S-2/S-2_9/S-2_E.xml';
        scope.bill('S-2', [firstReading(13542656)]);
        scope.viewer(13542656, capturedRedirects.s2FirstReading, pageLinking(missing));
        scope.redirect(`${ORIGIN}${missing}`, capturedRedirects.xmlError);
      },
      input: { session: '45-1', billCode: 'S-2' },
      requests: [
        detail('S-2'),
        viewer(13542656),
        `${ORIGIN}${capturedRedirects.s2FirstReading}`,
        'https://www.parl.ca/Content/Bills/451/Government/S-2/S-2_9/S-2_E.xml',
      ],
    },
  ])('fails $name as bill_text_unavailable without retry', async (scenario) => {
    scenario.route({
      bill: routeBill,
      viewer: routeViewer,
      redirect: (match, location) =>
        http.route({ match, respond: new Response(null, { status: 302, headers: { location } }) }),
    });
    const result = await call(scenario.input);
    assertError(result, 'bill_text_unavailable', JsonRpcErrorCode.NotFound, RECOVERY.unavailable);
    expect(result.structuredContent).toMatchObject({ error: { message: scenario.message } });
    expect(urls()).toEqual([picker, ...scenario.requests]);
  });

  it.each([
    ['null', null],
    ['empty', []],
  ])('fails a dossier with %s publications as bill_text_unavailable', async (_, publications) => {
    routeBill('C-901', publications);
    const result = await call({ session: '45-1', billCode: 'C-901', publicationId: 13542656 });
    assertError(
      result,
      'bill_text_unavailable',
      JsonRpcErrorCode.NotFound,
      'Call canparl_get_bill for this bill to check its stages; LEGISinfo lists no published version, as for a pro forma bill or one not yet printed.',
    );
    expect(result.structuredContent).toMatchObject({
      error: { message: 'The bill lists no published versions.' },
    });
    expect(urls()).toEqual([picker, detail('C-901')]);
  });

  it('returns the declared unknown-session recovery for an unlisted session', async () => {
    const result = await call({ session: '46-1', billCode: 'C-15' });
    assertError(
      result,
      'unknown_session',
      JsonRpcErrorCode.ValidationError,
      'Call canparl_list_reference with topic sessions and choose a listed bill session.',
    );
    expect(urls()).toEqual([picker]);
  });

  it('rejects an impossible session as unknown_session before any request', async () => {
    const result = await call({ session: '45-0', billCode: 'C-15' });
    assertError(
      result,
      'unknown_session',
      JsonRpcErrorCode.ValidationError,
      'Call canparl_list_reference with topic sessions and choose a listed bill session.',
    );
    expect(http.calls).toHaveLength(0);
  });

  it('returns the declared bill-not-found recovery for a missing dossier', async () => {
    http.route({ match: detail('C-999'), respond: Response.json([]) });
    const result = await call({ session: '45-1', billCode: 'C-999' });
    assertError(
      result,
      'bill_not_found',
      JsonRpcErrorCode.NotFound,
      'Call canparl_search_bills in the same session and copy a returned billCode.',
    );
    expect(urls()).toEqual([picker, detail('C-999')]);
  });

  it('declares no reason for a bill-code shape the schema refuses', async () => {
    expect(getBillTextTool.errors?.map(({ reason }) => reason)).not.toContain('invalid_bill_code');
    assertArgumentRejection(await call({ session: '45-1', billCode: 'K-15' }), {
      lines: ['billCode: Expected a House or Senate bill code'],
      rejected: 'K-15',
    });
    expect(http.calls).toHaveLength(0);
  });
});

/** Route builders a table-driven case receives. */
interface Routes {
  bill(code: string, publications: unknown[] | null, session?: string): void;
  redirect(match: string, location: string): void;
  viewer(id: number, location: string, page: string, language?: string): void;
}
