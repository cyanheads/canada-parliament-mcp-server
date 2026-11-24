/**
 * @fileoverview Official bill XML to verified plain-text segments, and the DocumentViewer page's
 * XML export-link scan.
 * @module tests/services/legisinfo/bill-text.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  type BillTextRequest,
  exportLinkScanner,
  parseBillText,
} from '@/services/legisinfo/bill-text.js';
import { billTextFixture } from '../../fixtures/bill-tools/bill-text.js';
import { expectLinearCpu } from '../../fixtures/cpu-timing.js';

const synthetic: BillTextRequest = { session: '45-1', billCode: 'C-901', language: 'en' };
interface Shape {
  after?: string;
  identification?: string;
  introduction?: string;
  lang?: string;
  number?: string;
  parliament?: string;
  session?: string;
}
/** A well-formed synthetic bill around `body`, the content of its `Body`. */
const bill = (body: string, shape: Shape = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?><Bill xml:lang="${shape.lang ?? 'en'}"><Identification><BillNumber>${shape.number ?? 'C-901'}</BillNumber><Parliament><Session>${shape.session ?? '1'}</Session><Number>${shape.parliament ?? '45'}</Number></Parliament>${shape.identification ?? ''}</Identification>${shape.introduction ?? ''}<Body>${body}</Body>${shape.after ?? ''}</Bill>`;
/** The `text` of a bill whose one section holds `content` after its label. */
const sectionText = (content: string) =>
  parseBillText(bill(`<Section><Label>1</Label>${content}</Section>`), synthetic).body[0];
const invalid = {
  code: JsonRpcErrorCode.SerializationError,
  data: { reason: 'upstream_response_invalid', retryable: false },
};
/** `run` fails as retryable ServiceUnavailable with `message`. */
function expectTransient(run: () => unknown, message: string): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable, message });
  expect((failure as { data?: { retryable?: boolean } }).data?.retryable).not.toBe(false);
}

describe('parseBillText on captured bills', () => {
  it('reads 45-1 C-202 at Royal Assent whole', () =>
    expect(
      parseBillText(billTextFixture('C-202_4_E.xml'), {
        session: '45-1',
        billCode: 'C-202',
        language: 'en',
      }),
    ).toEqual({
      billCode: 'C-202',
      session: '45-1',
      language: 'en',
      longTitle:
        'An Act to amend the Department of Foreign Affairs, Trade and Development Act (supply management)',
      shortTitle: null,
      sponsor: null,
      stage: 'assented-to',
      stageDate: '2025-06-26',
      introduction: {
        recommendation: null,
        summary:
          'SUMMARY\nThis enactment amends the Department of Foreign Affairs, Trade and Development Act so that the Minister of Foreign Affairs cannot make certain commitments with respect to international trade regarding certain goods.',
        preamble: null,
        enactingClause:
          'His Majesty, by and with the advice and consent of the Senate and House of Commons of Canada, enacts as follows:',
        explanatoryNotes: null,
      },
      body: [
        {
          label: '1',
          marginalNote: null,
          headings: ['Department of Foreign Affairs, Trade and Development Act'],
          text: 'Section 10 of the Department of Foreign Affairs, Trade and Development Act is amended by adding the following after subsection (2):\nSupply management\n(2.1) In exercising and performing the powers, duties and functions set out in subsection (2), the Minister must not make any commitment on behalf of the Government of Canada, by international trade treaty or agreement, that would have the effect of\n(a) increasing the tariff rate quota, within the meaning of subsection 2(1) of the Customs Tariff, applicable to dairy products, poultry or eggs; or\n(b) reducing the tariff applicable to those goods when they are imported in excess of the applicable tariff rate quota.',
          explanatoryNotes: null,
        },
      ],
      headings: [
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
          characters: 668,
        },
      ],
      schedules: [],
    }));

  it('reads 45-1 S-2 with explanatory notes kept out of the enacted text', () => {
    const text = parseBillText(billTextFixture('S-2_1_E.xml'), {
      session: '45-1',
      billCode: 'S-2',
      language: 'en',
    });
    expect(text).toMatchObject({
      stage: 'first-reading-senate',
      stageDate: '2025-05-29',
      sponsor: 'THE HONOURABLE SENATOR GOLD, P.C.',
      shortTitle: 'An Act to amend the Indian Act (new registration entitlements)',
    });
    expect(text.body.map((section) => section.label)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1)),
    );
    const [first, second] = text.body;
    expect(first?.text?.split('\n')[0]).toBe(
      '(1) The definition mentally incompetent Indian in subsection 2(1) of the Indian Act is repealed.',
    );
    expect(first?.text).not.toContain('Existing text');
    expect(first?.explanatoryNotes?.split('\n').slice(0, 2)).toEqual([
      'Indian Act',
      'Clause 1: (1) Existing text of the definition:',
    ]);
    expect(second?.marginalNote).toBe('R.S., c. 48 (4th Supp.), s. 1');
    expect(second?.text).toContain(
      'the definitions band, Indian moneys and dependent person in section 2',
    );
    expect(text.headings.map(({ title, offset, count }) => [title, offset, count])).toEqual([
      ['Indian Act', 0, 7],
      ['Related Provisions', 7, 4],
    ]);
    expect(text.body.at(-1)?.headings).toEqual(['Related Provisions']);
  });

  it('reads the French version from S-2_F.xml with the same sections', () => {
    const text = parseBillText(billTextFixture('S-2_1_F.xml'), {
      session: '45-1',
      billCode: 'S-2',
      language: 'fr',
    });
    expect(text.language).toBe('fr');
    expect(text.body).toHaveLength(11);
    expect(text.body[0]?.text?.split('\n')[0]).toBe(
      '(1) La définition de Indien mentalement incapable, au paragraphe 2(1) de la Loi sur les Indiens, est abrogée.',
    );
    expect(text.headings.map(({ title, citation }) => [title, citation])).toEqual([
      ['Loi sur les Indiens', 'L.R., ch. I-5'],
      ['Dispositions connexes', null],
    ]);
  });

  it('outlines 45-1 C-15: Parts, a four-deep path, schedules, and decoded entities', () => {
    const text = parseBillText(billTextFixture('C-15_1_E.xml'), {
      session: '45-1',
      billCode: 'C-15',
      language: 'en',
    });
    expect([text.body.length, text.headings.length, text.schedules.length]).toEqual([606, 196, 6]);
    expect(
      text.headings
        .filter((heading) => heading.level === 1)
        .map(({ index, label, title, offset, count, firstLabel, lastLabel }) => [
          index,
          label,
          title,
          offset,
          count,
          firstLabel,
          lastLabel,
        ]),
    ).toEqual([
      [0, null, 'Short Title', 0, 1, '1', '1'],
      [1, 'PART 1', 'Amendments to the Income Tax Act and Other Legislation', 1, 124, '2', '125'],
      [7, 'PART 2', 'Digital Services Tax (Repeals and Other Measures)', 125, 33, '126', '158'],
      [
        25,
        'PART 3',
        'Amendments to the Excise Tax Act (GST/HST), the Underused Housing Tax Act, the Select Luxury Items Tax Act and Other Related Texts',
        158,
        18,
        '159',
        '176',
      ],
      [38, 'PART 4', 'First Nations Goods and Services Tax Act', 176, 14, '177', '190'],
      [43, 'PART 5', 'Various Measures', 190, 416, '191', '606'],
    ]);
    expect(Math.max(...text.headings.map((heading) => heading.level))).toBe(4);
    expect(text.body[166]?.headings).toEqual([
      'PART 3 Amendments to the Excise Tax Act (GST/HST), the Underused Housing Tax Act, the Select Luxury Items Tax Act and Other Related Texts',
      'DIVISION 2 Underused Housing Tax Measures',
      'Underused Housing Tax Act',
      'Amendments to the Act',
    ]);
    for (const heading of text.headings) {
      const spanned = text.body.slice(heading.offset, heading.offset + heading.count);
      expect(heading.characters).toBe(
        spanned.reduce((sum, section) => sum + (section.text?.length ?? 0), 0),
      );
    }
    expect(text.body[223]).toMatchObject({
      label: '224',
      marginalNote: 'Enactment of Act',
      headings: [
        'PART 5 Various Measures',
        'DIVISION 9 Consumer-Driven Banking',
        'Consumer-Driven Banking Act',
      ],
    });
    expect(text.body[605]?.headings).toEqual([
      'PART 5 Various Measures',
      'DIVISION 45 Stablecoin Act',
      'Coming into Force',
    ]);
    expect(text.introduction.recommendation?.split('\n')[0]).toBe('RECOMMENDATION');
    expect(text.introduction.summary).toContain('the enhanced 35% SR&ED credit');
    expect(JSON.stringify(text.introduction)).not.toContain('TABLE OF PROVISIONS');
    expect(text.schedules.map(({ label, originatingRef }) => [label, originatingRef])).toEqual([
      ['SCHEDULE 1', '(Section 187)'],
      ['SCHEDULE 2', '(Section 224)'],
      ['SCHEDULE 3', '(Section 290)'],
      ['SCHEDULE 4', '(Section 370)'],
      ['SCHEDULE 5', '(Section 445)'],
      ['SCHEDULE 6', '(Section 507)'],
    ]);
    const rows = text.schedules[2]?.text?.split('\n');
    expect(rows?.slice(0, 4)).toEqual([
      'SCHEDULE V (Sections 14.12 and 992)',
      'TABLE 1 National Instrument 51-102',
      ' | Column 1 | Column 2',
      'Item | Province | Instrument',
    ]);
  });
});

describe('parseBillText conversion rules', () => {
  it('keeps mixed content in document order with inline markup as its text', () =>
    expect(
      sectionText(
        '<Text>The definition <DefinedTermEn>x</DefinedTermEn> of the <XRefExternal reference-type="act">Indian Act</XRefExternal> is <Ins>now</Ins> repealed.</Text>',
      )?.text,
    ).toBe('The definition x of the Indian Act is now repealed.'));

  it('collapses pretty-printing whitespace and drops whitespace-only nodes', () =>
    expect(
      sectionText(
        '\n  <Text>\n    Section 10 of\n    the Act\n  </Text>\n  <Subsection>\n    <Label>(2)</Label>\n    <Text>New text.</Text>\n  </Subsection>\n',
      )?.text,
    ).toBe('Section 10 of the Act\n(2) New text.'));

  it('opens each line with its labels, three levels deep', () =>
    expect(
      sectionText(
        '<Subsection><Label>(1)</Label><Text>Lead.</Text><Paragraph><Label>(a)</Label><Subparagraph><Label>(i)</Label><Text>deep</Text><Clause><Label>(A)</Label><Text>deeper</Text></Clause></Subparagraph></Paragraph></Subsection>',
      )?.text,
    ).toBe('(1) Lead.\n(a) (i) deep\n(A) deeper'));

  it('gives a label that nothing follows its own line instead of the next block', () =>
    expect(
      sectionText(
        '<Subsection><Label>(1)</Label><Paragraph><Label>(a)</Label></Paragraph><Paragraph><Label>(b)</Label><Text>b text</Text></Paragraph></Subsection><Subsection><Label>(2)</Label></Subsection>',
      )?.text,
    ).toBe('(1) (a)\n(b) b text\n(2)'));

  it('keeps a label open across an element that writes no text of its own', () =>
    expect(
      sectionText(
        '<Subsection><Label>(1)</Label><Paragraph><ExplanatoryNote><ExplanatoryText>Aside.</ExplanatoryText></ExplanatoryNote></Paragraph><Text>Lead.</Text></Subsection>',
      ),
    ).toMatchObject({ text: '(1) Lead.', explanatoryNotes: 'Aside.' }));

  it('renders table rows as cells joined by " | ", dropping rows with no text', () =>
    expect(
      sectionText(
        '<TableGroup><table><title>Rates</title><tgroup><colspec/><thead><row><entry/><entry> </entry></row><row><entry>Item</entry><entry>Rate</entry></row></thead><tbody><row><entry>1</entry><entry>10<Sup>2</Sup> m</entry></row><row><entry><Provision><Text>a</Text></Provision><Provision><Text>b</Text></Provision></entry><entry/></row></tbody></tgroup></table></TableGroup>',
      )?.text,
    ).toBe('Rates\nItem | Rate\n1 | 102 m\na b | '));

  it('routes explanatory notes from any depth to explanatoryNotes, never text', () => {
    const section = sectionText(
      '<Text>Enacted.</Text><Subsection><Label>(1)</Label><Text>Sub.</Text><ExplanatoryNote><Label>Clause 1:</Label><ExplanatoryText>Existing text:</ExplanatoryText><ExistingText><Text>Old.</Text></ExistingText></ExplanatoryNote></Subsection><ExplanatoryNote><ExplanatoryText>New.</ExplanatoryText></ExplanatoryNote>',
    );
    expect(section).toMatchObject({
      text: 'Enacted.\n(1) Sub.',
      explanatoryNotes: 'Clause 1: Existing text:\nOld.\nNew.',
    });
  });

  it('routes an explanatory note inside a table cell to explanatoryNotes, never text', () =>
    expect(
      sectionText(
        '<TableGroup><table><tgroup><tbody><row><entry>1</entry><entry><Text>Rate</Text><ExplanatoryNote><ExplanatoryText>Cell note.</ExplanatoryText></ExplanatoryNote></entry></row></tbody></tgroup></table></TableGroup>',
      ),
    ).toMatchObject({ text: '1 | Rate', explanatoryNotes: 'Cell note.' }));

  it('decodes entities in text and keeps unknown elements as text', () =>
    expect(
      sectionText('<Text>R&amp;D &lt;5&gt; &#x2014; &#8217;</Text><Unknown>kept</Unknown>')?.text,
    ).toBe('R&D <5> — ’\nkept'));

  it('spans nested heading levels with paths, counts, and characters', () => {
    const text = parseBillText(
      bill(
        [
          '<Section><Label>1</Label><Text>abc</Text></Section>',
          '<Heading level="1"><Label>PART 1</Label><TitleText>One</TitleText></Heading>',
          '<Heading level="2"><Label>DIVISION 1</Label><TitleText>Alpha</TitleText></Heading>',
          '<Heading level="3"><TitleText>Act A</TitleText></Heading>',
          '<Section><Label>2</Label><Text>de</Text></Section>',
          '<Section><Label>3</Label><Text>f</Text></Section>',
          '<Heading level="2"><Label>DIVISION 2</Label></Heading>',
          '<Section><Label>4</Label></Section>',
          '<Heading level="1"><MarginalNote><HistoricalNote>R.S., c. X</HistoricalNote></MarginalNote><TitleText>Two</TitleText></Heading>',
          '<Heading level="2"><TitleText>Empty</TitleText></Heading>',
        ].join(''),
      ),
      synthetic,
    );
    expect(
      text.headings.map(({ index, level, offset, count, firstLabel, lastLabel, characters }) => [
        index,
        level,
        offset,
        count,
        firstLabel,
        lastLabel,
        characters,
      ]),
    ).toEqual([
      [0, 1, 1, 3, '2', '4', 3],
      [1, 2, 1, 2, '2', '3', 3],
      [2, 3, 1, 2, '2', '3', 3],
      [3, 2, 3, 1, '4', '4', 0],
      [4, 1, 4, 0, null, null, 0],
      [5, 2, 4, 0, null, null, 0],
    ]);
    expect(text.headings[4]).toMatchObject({ label: null, title: 'Two', citation: 'R.S., c. X' });
    expect(text.body.map((section) => section.headings)).toEqual([
      [],
      ['PART 1 One', 'DIVISION 1 Alpha', 'Act A'],
      ['PART 1 One', 'DIVISION 1 Alpha', 'Act A'],
      ['PART 1 One', 'DIVISION 2'],
    ]);
    expect(text.body[3]).toMatchObject({ label: '4', text: null, explanatoryNotes: null });
  });

  it('reads schedules: heading fields apart, nested schedules and other heading parts as text', () =>
    expect(
      parseBillText(
        bill('', {
          after:
            '<Schedule><ScheduleFormHeading><Label>SCHEDULE 1</Label><OriginatingRef>(Section 2)</OriginatingRef><TitleText>Lands</TitleText></ScheduleFormHeading><Schedule><ScheduleFormHeading><Label>SCHEDULE</Label></ScheduleFormHeading><Provision><Text>Inner.</Text></Provision></Schedule><ExplanatoryNote><ExplanatoryText>Note.</ExplanatoryText></ExplanatoryNote></Schedule><Schedule><Provision><Text>Bare.</Text></Provision></Schedule>',
        }),
        synthetic,
      ).schedules,
    ).toEqual([
      {
        label: 'SCHEDULE 1',
        originatingRef: '(Section 2)',
        text: 'Lands\nSCHEDULE\nInner.',
        explanatoryNotes: 'Note.',
      },
      { label: null, originatingRef: null, text: 'Bare.', explanatoryNotes: null },
    ]));

  it('reads a sparse bill: no introduction, sponsor, history, or short title', () =>
    expect(parseBillText(bill(''), synthetic)).toEqual({
      billCode: 'C-901',
      session: '45-1',
      language: 'en',
      longTitle: null,
      shortTitle: null,
      sponsor: null,
      stage: null,
      stageDate: null,
      introduction: {
        recommendation: null,
        summary: null,
        preamble: null,
        enactingClause: null,
        explanatoryNotes: null,
      },
      body: [],
      headings: [],
      schedules: [],
    }));

  it('joins repeated introduction parts and keeps their notes apart', () =>
    expect(
      parseBillText(
        bill('', {
          introduction:
            '<Introduction><Preamble><Provision><Text>Whereas one;</Text></Provision></Preamble><Preamble><Provision><Text>Whereas two;</Text></Provision><ExplanatoryNote><ExplanatoryText>Aside.</ExplanatoryText></ExplanatoryNote></Preamble><TableOfProvisions><Heading level="1"><TitleText>Listed</TitleText></Heading></TableOfProvisions></Introduction>',
        }),
        synthetic,
      ).introduction,
    ).toEqual({
      recommendation: null,
      summary: null,
      preamble: 'Whereas one;\nWhereas two;',
      enactingClause: null,
      explanatoryNotes: 'Aside.',
    }));
});

describe('parseBillText trust', () => {
  it.each([
    ['a body cut between elements', (xml: string) => xml.slice(0, xml.indexOf('</Section>') + 10)],
    ['a body cut inside a tag', (xml: string) => xml.slice(0, xml.lastIndexOf('</Bill>') + 4)],
    ['an empty body', () => ''],
  ])('retries %s as transient, never as a partial tree', (_case, cut) =>
    expectTransient(
      () =>
        parseBillText(cut(billTextFixture('S-2_1_E.xml')), {
          session: '45-1',
          billCode: 'S-2',
          language: 'en',
        }),
      'The bill XML ended before its closing Bill element.',
    ),
  );

  it('retries an HTML page served in place of the XML as transient', () =>
    expectTransient(
      () => parseBillText('<!DOCTYPE html><html><body>Busy</body></html>', synthetic),
      'LEGISinfo returned HTML instead of the bill XML.',
    ));

  it.each([
    ['a mismatched closing tag', bill('<Section><Label>1</Text></Section>')],
    ['an unclosed element', bill('<Section><Label>1</Label>')],
    ['a DTD', `<!DOCTYPE Bill [<!ENTITY e "x">]>${bill('')}`],
    ['an undeclared entity', bill('<Section><Text>&nbsp;</Text></Section>')],
    ['a bare ampersand in an attribute', bill('<Heading level="1&2"/>')],
    [
      'nesting past the parser limit',
      bill(`<Section>${'<Text>'.repeat(120)}x${'</Text>'.repeat(120)}</Section>`),
    ],
  ])('rejects a complete document with %s as upstream_response_invalid', (_case, xml) =>
    expect(() => parseBillText(xml, synthetic)).toThrow(expect.objectContaining(invalid)),
  );

  it.each([
    ['another language', { lang: 'fr' }],
    ['another bill number', { number: 'C-90' }],
    ['another parliament', { parliament: '44' }],
    ['another session', { session: '2' }],
  ])('rejects a complete document for %s', (_case, shape) =>
    expect(() => parseBillText(bill('', shape), synthetic)).toThrow(
      expect.objectContaining(invalid),
    ),
  );

  it.each([
    ['an unknown top-level element', bill('', { after: '<Appendix/>' })],
    ['a second Body', bill('', { after: '<Body/>' })],
    ['no Body', bill('').replace('<Body></Body>', '')],
    ['an unknown Body child', bill('<Provision><Text>x</Text></Provision>')],
    ['text directly in Body', bill('loose text')],
    ['an unknown Heading part', bill('<Heading level="1"><Note>x</Note></Heading>')],
    ['a Heading without a level', bill('<Heading><TitleText>x</TitleText></Heading>')],
    ['a zero Heading level', bill('<Heading level="0"><TitleText>x</TitleText></Heading>')],
    [
      'an unknown introduction part',
      bill('', { introduction: '<Introduction><Foreword/></Introduction>' }),
    ],
    [
      'an impossible stage date',
      bill('', {
        identification:
          '<BillHistory><Stages stage="x"><Date><YYYY>2025</YYYY><MM>2</MM><DD>30</DD></Date></Stages></BillHistory>',
      }),
    ],
    ['a non-numeric session', bill('', { session: 'one' })],
  ])('rejects %s', (_case, xml) =>
    expect(() => parseBillText(xml, synthetic)).toThrow(expect.objectContaining(invalid)),
  );

  it('reads the last of several stages and pads its date', () =>
    expect(
      parseBillText(
        bill('', {
          identification:
            '<BillHistory><Stages stage="first-reading-house"><Date><YYYY>2025</YYYY><MM>5</MM><DD>1</DD></Date></Stages><Stages stage="assented-to"><Date><YYYY>2025</YYYY><MM>6</MM><DD>9</DD></Date></Stages></BillHistory>',
        }),
        synthetic,
      ),
    ).toMatchObject({ stage: 'assented-to', stageDate: '2025-06-09' }));
});

describe('exportLinkScanner', () => {
  const page = billTextFixture('viewer-S-2-first-reading.html');
  const scan = (chunks: string[]) => {
    const push = exportLinkScanner();
    for (const chunk of chunks) {
      const result = push(chunk);
      if (result !== undefined) return result;
    }
    return 'undecided';
  };

  it('finds the captured export link in one chunk', () =>
    expect(scan([page])).toBe('/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml'));

  it('finds it when the page arrives a character at a time', () =>
    expect(scan([...page])).toBe('/Content/Bills/451/Government/S-2/S-2_1/S-2_E.xml'));

  it.each([
    [
      'the French page',
      'viewer-S-2-premiere-lecture.html',
      '/Content/Bills/451/Government/S-2/S-2_1/S-2_F.xml',
    ],
    [
      'the 41-2 TOC export page',
      'viewer-41-2-C-8-toc.html',
      '/Content/Bills/412/Government/C-8/C-8_1/C-8-TOC-e.xml',
    ],
    ['a PDF-only page', 'viewer-37-1-C-15A-pdf-only.html', null],
  ] as const)('reads %s', (_case, name, expected) =>
    expect(scan([billTextFixture(name)])).toBe(expected),
  );

  it('stays undecided until the publication content or the link arrives', () =>
    expect(scan(['<html><head><title>x</title>', '<a href="/x">', '<div class="row">'])).toBe(
      'undecided',
    ));

  it.each([
    [
      'a commented-out anchor',
      '<!-- <a class="btn btn-export-xml" href="/old.xml"> --><a class="btn btn-export-xml" href="/new.xml">',
      '/new.xml',
    ],
    [
      'a data-href before the href',
      '<a data-href="/x.xml" class="btn-export-xml" href="/y.xml">',
      '/y.xml',
    ],
    [
      'a non-anchor naming the class',
      '<span class="btn-export-xml">XML</span><div class="publication-container">',
      null,
    ],
  ])('reads past %s', (_case, html, expected) => expect(scan([html])).toBe(expected));

  it('rejects an export anchor without an href as upstream_response_invalid', () =>
    expect(() => scan(['<a class="btn btn-export-xml" title="XML">'])).toThrow(
      expect.objectContaining(invalid),
    ));
});

const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000] as const;
const attempt = (run: () => unknown) => {
  try {
    run();
  } catch {
    // Rejected shapes still scan their input; that scan is what is timed.
  }
};
const parse = (xml: string) => attempt(() => parseBillText(xml, synthetic));
const section = (content: string) => bill(`<Section><Label>1</Label>${content}</Section>`);

describe('parseBillText stays linear', { timeout: 0 }, () => {
  it.each([
    [
      'one long text line ending in a break',
      (n: number) => section(`<Text>${'§1 x'.repeat(n / 4)}\ny</Text>`),
    ],
    [
      'line breaks throughout a text',
      (n: number) => section(`<Text>${'  \r\n'.repeat(n / 4)}x</Text>`),
    ],
    [
      'line breaks between elements',
      (n: number) => section(`${'  \r\n'.repeat(n / 4)}<Text>x</Text>`),
    ],
    ['leading whitespace before the root', (n: number) => `${'  \r\n'.repeat(n / 4)}${bill('')}`],
    ['trailing whitespace after the root', (n: number) => `${bill('')}${'  \r\n'.repeat(n / 4)}`],
    [
      'many sections',
      (n: number) => bill('<Section><Label>1</Label><Text>x</Text></Section>'.repeat(n / 48)),
    ],
    [
      'alternating heading levels',
      (n: number) => bill('<Heading level="1"/><Heading level="5"/>'.repeat(n / 40)),
    ],
    ['repeated labels with no text', (n: number) => section('<Label>(a)</Label>'.repeat(n / 18))],
    ['repeated entities', (n: number) => section(`<Text>${'&amp;'.repeat(n / 5)}</Text>`)],
    [
      'a row of many cells',
      (n: number) => section(`<row>${'<entry>a</entry>'.repeat(n / 16)}</row>`),
    ],
    [
      'inline elements in one text',
      (n: number) => section(`<Text>${'a<Ins>b</Ins>'.repeat(n / 13)}</Text>`),
    ],
    [
      'a repeated opener with no closer',
      (n: number) => section(`<Text>${'<a'.repeat(n / 2)}</Text>`),
    ],
    ['repeated unclosed comments', (n: number) => section('<!--'.repeat(n / 4))],
    [
      'many attributes',
      (n: number) =>
        section(
          `<Text ${Array.from({ length: n / 12 }, (_, i) => `a${i}="1"`).join(' ')}>x</Text>`,
        ),
    ],
    ['a repeated attribute', (n: number) => section(`<Text${' a="1"'.repeat(n / 6)}>x</Text>`)],
    ['a long unterminated reference', (n: number) => section(`<Text>&#x${'a'.repeat(n)}</Text>`)],
  ])('on %s', (_shape, build) => expectLinearCpu(parse, build, SIZES));
});

describe('exportLinkScanner stays linear', { timeout: 0 }, () => {
  /** Feed `html` in 16 KiB chunks, as a streamed body arrives. */
  const feed = (html: string) =>
    attempt(() => {
      const push = exportLinkScanner();
      for (let start = 0; start < html.length; start += 16_384)
        if (push(html.slice(start, start + 16_384)) !== undefined) return;
    });
  it.each([
    ['a repeated opener with no closer', (n: number) => '<'.repeat(n)],
    ['many small tags', (n: number) => '<a>'.repeat(n / 3)],
    [
      'an export anchor never closed',
      (n: number) => `<a class="btn-export-xml"${' href'.repeat(n / 5)}`,
    ],
    [
      'an export anchor whose hrefs never open',
      (n: number) => `<a class="btn-export-xml"${' href='.repeat(n / 6)}>`,
    ],
    [
      'an export anchor whose href never closes',
      (n: number) => `<a class="btn-export-xml" href="${' x'.repeat(n / 2)}>`,
    ],
    ['one long line ending in a break', (n: number) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n: number) => '  \r\n'.repeat(n / 4)],
  ])('on %s', (_shape, build) => expectLinearCpu(feed, build, SIZES));
});
