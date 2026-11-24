/**
 * @fileoverview One bill version's text from its official XML: the whole text, its outline, or a
 * page of one segment, sections never split.
 * @module mcp-server/tools/definitions/get-bill-text.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  BILL_CODE_FORMAT,
  clampCount,
  type InputFormat,
  normalizeBillCode,
} from '@/domain/normalization.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  BilingualTextSchema,
  COUNT_CEILING,
  JsonRecordSchema,
  optionalFormat,
  requiredFormat,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import {
  formatResult,
  measuredTrailer,
  OUTLINE_THRESHOLD_BYTES,
  responseBytes,
} from './_format.js';
import { BillSummarySchema } from './get-bill.tool.js';

const text = () => z.string().nullable();
const SEGMENTS = ['introduction', 'headings', 'body', 'schedules'] as const;
type Segment = (typeof SEGMENTS)[number];
/** Segments read by whole-record pages. */
type PagedSegment = Exclude<Segment, 'introduction'>;
/** Exactly one listed segment. */
const SEGMENT_FORMAT: InputFormat = {
  source: `(?:${SEGMENTS.join('|')})`,
  expectation: `Unknown segment. Available segments: ${SEGMENTS.join(', ')}.`,
};
/** Per-call page cap for every paged segment. */
const PAGE_CAP = 100;
const DEFAULT_LIMIT: Record<PagedSegment, number> = { headings: 50, body: 5, schedules: 5 };
const RECORD_NAMES: Record<PagedSegment, string> = {
  headings: 'body headings',
  body: 'body sections',
  schedules: 'schedules',
};
const explanatoryNotes = () =>
  text().describe(
    'Explanatory notes on existing text, never enacted text, kept apart from the text; or null.',
  );
const HeadingSchema = z
  .object({
    index: z
      .number()
      .int()
      .nonnegative()
      .describe('Position in the headings segment; pass it as offset with segment headings.'),
    level: z.number().int().positive().describe('Heading depth; 1 is outermost.'),
    label: text().describe('Heading label, such as PART 5 or DIVISION 9, or null.'),
    title: text().describe('Heading title, or null.'),
    citation: text().describe(
      'Citation printed under the heading (its MarginalNote, such as a HistoricalNote), or null.',
    ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .describe('Body offset of the first section under this heading; pass it with segment body.'),
    count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Body sections under this heading, up to the next heading of the same or a higher level.',
      ),
    firstLabel: text().describe(
      'Label of the first spanned body section, or null when count is 0.',
    ),
    lastLabel: text().describe('Label of the last spanned body section, or null when count is 0.'),
    characters: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Text length of the spanned sections in UTF-16 code units, for sizing a body page.',
      ),
  })
  .strict()
  .describe('Body heading and the run of body sections it spans.');
const OutputSchema = z.object({
  totalCount: z
    .number()
    .int()
    .optional()
    .describe('Records in the selected headings, body, or schedules segment; paged segments only.'),
  kind: z
    .enum(['outline', 'segment'])
    .optional()
    .describe('Absent for the whole text; outline lists segments; segment returns one selection.'),
  bill: BillSummarySchema.describe('Official bill summary, as canparl_search_bills returns it.'),
  publication: z
    .object({
      id: z.number().int().describe('Official publication ID read.'),
      typeId: z.number().int().nullable().describe('Publication type ID, or null.'),
      type: BilingualTextSchema.describe(
        'Publication type wording, such as First Reading or Royal Assent.',
      ),
      url: z
        .string()
        .describe('Official DocumentViewer page of this version in the text language.'),
      xmlUrl: z.string().describe('Official XML the text was read from.'),
      stage: text().describe(
        'Stage the XML names, as published (such as first-reading-senate or assented-to), or null.',
      ),
      stageDate: text().describe('Stage date, YYYY-MM-DD, or null.'),
      longTitle: text().describe('Long title printed in this version, or null.'),
      shortTitle: text().describe('Short title printed in this version, or null.'),
      sponsor: text().describe('Sponsor as printed, or null; Royal Assent versions print none.'),
    })
    .strict()
    .describe('The version read: its dossier publication record and the identity its XML prints.'),
  segments: z
    .array(
      z
        .object({
          name: z.enum(SEGMENTS).describe('Exact segment selector.'),
          count: z
            .number()
            .int()
            .nullable()
            .describe('Record count; null for introduction, which returns whole.'),
        })
        .strict()
        .describe('Retrievable text segment.'),
    )
    .optional()
    .describe('Segment selectors with their record counts; outline only.'),
  introduction: z
    .object({
      recommendation: text().describe(
        'Royal recommendation, opening with its title line, or null.',
      ),
      summary: text().describe('Summary, opening with its SUMMARY line, or null.'),
      preamble: text().describe('Preamble, or null.'),
      enactingClause: text().describe('Enacting clause, or null.'),
      explanatoryNotes: explanatoryNotes(),
    })
    .strict()
    .optional()
    .describe(
      'Text before the body as plain text; the table of provisions is left to the outline and headings.',
    ),
  headings: z
    .array(HeadingSchema)
    .optional()
    .describe(
      'Body headings of every level in document order; an outline lists only the outermost level.',
    ),
  body: z
    .array(
      z
        .object({
          label: text().describe('Section label, such as 224, or null.'),
          marginalNote: text().describe('Marginal note, or null.'),
          headings: z
            .array(z.string().describe('One enclosing heading: its label and title, space-joined.'))
            .describe('Enclosing heading path, outermost first.'),
          text: text().describe(
            'Whole section text: one line per block, labels opening their line, table cells joined by " | "; or null.',
          ),
          explanatoryNotes: explanatoryNotes(),
        })
        .strict()
        .describe('One top-level body section, never split.'),
    )
    .optional()
    .describe('Top-level body sections in document order.'),
  schedules: z
    .array(
      z
        .object({
          label: text().describe('Schedule label, such as SCHEDULE 1, or null.'),
          originatingRef: text().describe(
            'Provision the schedule belongs to, such as (Section 12), or null.',
          ),
          text: text().describe(
            'Whole schedule text, nested schedules included, in the section text format; or null.',
          ),
          explanatoryNotes: explanatoryNotes(),
        })
        .strict()
        .describe('One top-level schedule, never split.'),
    )
    .optional()
    .describe('Top-level schedules in document order.'),
  pagination: z
    .object({
      segment: z.enum(['headings', 'body', 'schedules']).describe('Selected segment.'),
      offset: z.number().int().describe('Requested zero-based record offset.'),
      limit: z.number().int().describe('Effective maximum page size after the per-call cap.'),
      total: z.number().int().describe('Records in the segment.'),
      nextOffset: z
        .number()
        .int()
        .nullable()
        .describe('Offset of the next page, or null when the segment is complete.'),
    })
    .strict()
    .optional()
    .describe('Whole-record continuation of a headings, body, or schedules page.'),
  disclosure: z.string().optional().describe('Outline, empty-segment, or past-end guidance.'),
  provenance: z
    .array(SourceSchema)
    .describe('Original retrieval metadata for every source request.'),
});
const enrichment = {
  appliedFilters: z
    .object({
      session: z.string().describe('Resolved official session.'),
      billCode: z.string().describe('Canonical bill code.'),
      publicationId: z
        .number()
        .int()
        .describe('Publication read: the requested one, or the last-listed by default.'),
      language: z.enum(['en', 'fr']).describe('Text language read.'),
    })
    .strict()
    .describe('Normalized requested bill version.'),
  notice: z.string().optional().describe('Limit clamp guidance when applicable.'),
};

/** Read one bill version's official text without splitting a section. */
export const getBillTextTool = tool('canparl_get_bill_text', {
  description:
    'Read one version of a House or Senate bill as plain text from its official XML: the introduction (recommendation, summary, preamble, enacting clause), headings, numbered body sections, and schedules. Omitted publicationId reads the last-listed version in canparl_get_bill publications; omitted session means the verified current official session. Text over 24000 bytes returns an outline of segment counts and the outermost headings, each with its body offset and count; re-call with one segment and follow pagination.nextOffset. Sections are never split. A version exported only as a PDF, as in many older sessions, has no text here.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    session: SessionInputSchema,
    billCode: requiredFormat(BILL_CODE_FORMAT).describe(
      'Bill code from canparl_search_bills, including a split-bill suffix letter such as C-15A; accepts bill s321, S321, S 321, or S-321.',
    ),
    publicationId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Publication ID from canparl_get_bill publications; omit for the last-listed (furthest-stage) version.',
      ),
    language: z
      .enum(['en', 'fr'])
      .default('en')
      .describe('Text language: en (default) reads the English XML, fr the French.'),
    segment: optionalFormat(SEGMENT_FORMAT).describe(
      `One segment: ${SEGMENTS.join(', ')}. Omit for the whole text, or its outline above the 24000-byte threshold.`,
    ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Zero-based whole-record offset in segment headings, body, or schedules, default 0; a heading's offset is the body offset of its first section.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COUNT_CEILING)
      .optional()
      .describe(
        'Whole records per page of segment headings, body, or schedules: default 50 headings or 5 sections or schedules, 1–100 per call; larger values up to 10000 return 100 with a notice.',
      ),
  }),
  output: OutputSchema,
  enrichment,
  enrichmentTrailer: measuredTrailer(enrichment),
  errors: [
    {
      reason: 'invalid_text_segment',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'offset or limit supplied without segment headings, body, or schedules.',
      recovery:
        'Remove offset and limit, or add segment headings, body, or schedules to page that segment.',
      retryable: false,
    },
    {
      reason: 'unknown_publication',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: "publicationId is not one of the bill's publications.",
      recovery:
        'Retry with a publication ID listed in allowed, or omit publicationId to read the last-listed version.',
      retryable: false,
    },
    {
      reason: 'bill_text_unavailable',
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
      when: 'The bill lists no publications, or the version has no XML text: a PDF-only or table-of-contents export, a missing viewer page, or a missing XML file.',
      recovery:
        'Read the version on its DocumentViewer page, the url in canparl_get_bill publications; sessions before 42-1 often have no XML text for any version.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'unknown_session',
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
      when: 'Session with a zero or out-of-range number, or absent from the official bill session index.',
      recovery: 'Call canparl_list_reference with topic sessions and choose a listed bill session.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'bill_not_found',
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
      when: 'Official dossier has no matching record or returns a missing-record response.',
      recovery: 'Call canparl_search_bills in the same session and copy a returned billCode.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_blocked',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'An official parliamentary source refuses the request with HTTP 403.',
      recovery: 'Retry the affected official source later for parliamentary data.',
      retryable: false,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      // The segment pattern admits only listed segments.
      const segment = input.segment as Segment | undefined;
      const paged = segment === undefined || segment === 'introduction' ? undefined : segment;
      if (!paged && (input.offset !== undefined || input.limit !== undefined))
        throw ctx.fail('invalid_text_segment');
      const limit = clampCount('limit', input.limit ?? DEFAULT_LIMIT[paged ?? 'body'], PAGE_CAP);
      const billCode = normalizeBillCode(input.billCode);
      const service = getLegisinfoService();
      const resolved = await service.resolveSession(input.session, request);
      const session = resolved.data;
      const dossier = await service.getBill(session, billCode, request);
      const publications = dossier.data.publications ?? [];
      const ids = publications.map(({ id }) => id);
      const chosen =
        input.publicationId === undefined
          ? publications.at(-1)
          : publications.find(({ id }) => id === input.publicationId);
      if (!ids.length)
        throw ctx.fail('bill_text_unavailable', 'The bill lists no published versions.', {
          recovery: {
            hint: 'Call canparl_get_bill for this bill to check its stages; LEGISinfo lists no published version, as for a pro forma bill or one not yet printed.',
          },
        });
      if (!chosen)
        throw ctx.fail(
          'unknown_publication',
          `publicationId: Expected one of this bill's publication IDs: ${ids.join(', ')}.`,
          { field: 'publicationId', allowed: ids },
        );
      const read = await service.getBillText(session, billCode, chosen.id, input.language, request);
      const enrichment = {
        appliedFilters: { session, billCode, publicationId: chosen.id, language: input.language },
        ...(limit.notice ? { notice: limit.notice } : {}),
      };
      ctx.enrich(enrichment);
      request.throwIfOuterAborted();
      const { data } = read;
      const head = {
        bill: dossier.data.bill,
        publication: {
          id: chosen.id,
          typeId: chosen.typeId,
          type: chosen.type,
          url: data.url,
          xmlUrl: data.xmlUrl,
          stage: data.stage,
          stageDate: data.stageDate,
          longTitle: data.longTitle,
          shortTitle: data.shortTitle,
          sponsor: data.sponsor,
        },
      };
      const provenance = [...resolved.provenance, ...dossier.provenance, ...read.provenance];
      if (segment === undefined) {
        // Parsed for the output schema's key order, which the measure must share with the wire.
        const whole = OutputSchema.parse({
          ...head,
          introduction: data.introduction,
          headings: data.headings,
          body: data.body,
          schedules: data.schedules,
          provenance,
        });
        if (responseBytes(whole, enrichment) <= OUTLINE_THRESHOLD_BYTES) return whole;
        const outermost = Math.min(...data.headings.map(({ level }) => level));
        return {
          kind: 'outline' as const,
          ...head,
          segments: SEGMENTS.map((name) => ({
            name,
            count: name === 'introduction' ? null : data[name].length,
          })),
          headings: data.headings.filter(({ level }) => level === outermost),
          disclosure: `Text exceeds the ${OUTLINE_THRESHOLD_BYTES}-byte outline threshold. Re-call with segment introduction, headings, body, or schedules; page headings, body, and schedules with offset and limit, and pass a heading's offset with segment body to read its sections. Sections are never split; no text has been discarded.`,
          provenance,
        };
      }
      if (!paged)
        return { kind: 'segment' as const, ...head, introduction: data.introduction, provenance };
      const records = data[paged];
      const offset = input.offset ?? 0;
      const end = Math.min(records.length, offset + limit.value);
      const disclosure =
        records.length === 0
          ? `This version has no ${RECORD_NAMES[paged]}.`
          : offset >= records.length
            ? `Offset ${offset} is past the end of the ${records.length} ${RECORD_NAMES[paged]}; re-call with an offset below ${records.length}.`
            : undefined;
      return {
        totalCount: records.length,
        kind: 'segment' as const,
        ...head,
        [paged]: records.slice(offset, end),
        pagination: {
          segment: paged,
          offset,
          limit: limit.value,
          total: records.length,
          nextOffset: end < records.length ? end : null,
        },
        ...(disclosure ? { disclosure } : {}),
        provenance,
      };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(JsonRecordSchema.parse(result)),
});
