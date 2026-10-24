/**
 * @fileoverview Complete official bill dossiers with source-preserving stage records.
 * @module mcp-server/tools/definitions/get-bill.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  clampCount,
  filterFailure,
  normalizeBillCode,
  normalizeFilter,
} from '@/domain/normalization.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  BilingualTextSchema,
  COUNT_CEILING,
  JsonRecordSchema,
  OptionalStringSchema,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import type { BillDossier } from '@/services/legisinfo/types.js';
import { formatResult, RESPONSE_BUDGET, renderValue, responseBytes } from './_format.js';

const text = () => z.string().nullable();
const integer = () => z.number().int().nullable();
const chamber = () => z.enum(['House', 'Senate']).nullable();
const sectionNames = [
  'sponsor',
  'stages.house',
  'stages.senate',
  'stages.royalAssent',
  'divisions',
  'senateVoteDetails',
  'publications',
  'statute',
  'summary.en',
  'summary.fr',
  'notes.en',
  'notes.fr',
  'milestones',
  'webReferences',
] as const;
/** Sections returned whole; only the remaining collections accept offset and limit. */
const scalarSections = new Set<string>([
  'sponsor',
  'statute',
  'summary.en',
  'summary.fr',
  'notes.en',
  'notes.fr',
  'milestones',
]);
/** Plain-text bilingual field; a `<field>.en` or `<field>.fr` section carries one language. */
const languageText = (what: string) =>
  z
    .object({
      en: text().describe(`English ${what}, or null when unavailable.`),
      fr: text().describe(`French ${what}, or null when unavailable.`),
    })
    .partial()
    .strict();
const reading = (what: string) => text().describe(`${what} date-time, or null.`);
/** Official bill identity and list metadata, without fabricated sponsor fields. */
export const BillSummarySchema = z
  .object({
    session: z.string().describe('Verified parliament-session token.'),
    billCode: z.string().describe('Canonical House or Senate bill code.'),
    longTitle: BilingualTextSchema.describe('Official long titles.'),
    shortTitle: BilingualTextSchema.describe('Official short titles.'),
    billType: text().describe('Official bill type, or null.'),
    originatingChamber: chamber().describe('Originating chamber, or null.'),
    status: text().describe('Official status wording, or null.'),
    latestMajorStage: z
      .object({
        name: text().describe('Latest completed major stage name, or null.'),
        chamber: chamber().describe(
          'Chamber of the latest completed major stage, or null; royal assent is reported as Senate.',
        ),
      })
      .strict()
      .nullable()
      .describe('Latest completed major stage, or null.'),
    royalAssentDate: text().describe(
      'Royal assent as a UTC instant ending in Z (YYYY-MM-DDTHH:MM:SS[.fraction]Z), or null; a value in another shape is relayed as published.',
    ),
    url: z.string().describe('Absolute HTTPS official bill URL.'),
  })
  .strict()
  .describe('Official bill summary.');
const StageSchema = z
  .object({
    id: z.number().int().describe('Bill stage ID.'),
    name: BilingualTextSchema.describe('Stage names.'),
    chamber: chamber().describe('Containing chamber, or null for royal assent.'),
    state: z
      .object({
        id: integer().describe('Stage state ID.'),
        en: text().describe('English state wording.'),
        fr: text().describe('French state wording.'),
      })
      .strict()
      .describe('Stage state.'),
    stateAsOf: text().describe('State-as-of date.'),
    committee: z
      .object({
        id: integer().describe('Committee organization ID.'),
        acronym: text().describe('Committee acronym.'),
        name: BilingualTextSchema.describe('Committee names.'),
      })
      .strict()
      .nullable()
      .describe('Committee referral.'),
    sittings: z
      .array(
        z
          .object({
            number: text().describe('Sitting number.'),
            date: text().describe('Sitting date.'),
            name: BilingualTextSchema.describe('Sitting names.'),
            published: z.boolean().nullable().describe('Publication flag.'),
          })
          .strict()
          .describe('Sitting record.'),
      )
      .nullable()
      .describe('Sittings.'),
    committeeMeetings: z
      .array(
        z
          .object({
            number: text().describe('Committee meeting number.'),
            date: text().describe('Committee meeting date.'),
            committeeId: integer().describe('Committee organization ID.'),
            acronym: text().describe('Committee acronym.'),
            name: BilingualTextSchema.describe('Committee meeting names.'),
          })
          .strict()
          .describe('Committee meeting record.'),
      )
      .nullable()
      .describe('Committee meetings.'),
    decisions: z.array(JsonRecordSchema).nullable().describe('Complete variable decision records.'),
    significantEvents: z
      .array(JsonRecordSchema)
      .nullable()
      .describe('Complete variable significant-event records.'),
    endOfStageEvent: JsonRecordSchema.nullable().describe('Complete end-of-stage event.'),
  })
  .strict()
  .describe(
    'Complete official stage; null fields are unavailable and empty arrays have no records.',
  )
  .meta({ id: 'BillStage' });

/** Read one official bill dossier without changing unavailable source values. */
export const getBillTool = tool('canparl_get_bill', {
  description:
    "Read one House or Senate bill's official dossier. Large dossiers return an outline; re-call with one section and follow pagination.nextOffset for collections. Stages preserve nested records whole. Obtain billCode and session from canparl_search_bills; omitted session means the verified current official session.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    session: SessionInputSchema,
    billCode: z
      .string()
      .describe(
        'Bill code from canparl_search_bills, including a split-bill suffix letter such as C-15A; accepts bill s321, S321, S 321, or S-321.',
      ),
    section: OptionalStringSchema.describe(
      'One section from the returned outline; omit for full dossier or overflow outline.',
    ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based whole-record offset within the selected collection.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(COUNT_CEILING)
      .default(20)
      .describe(
        'Maximum whole records per selected collection page, 1–100 per call; larger values up to 10000 return 100 with a notice, and the byte budget may reduce it.',
      ),
  }),
  output: z.object({
    totalCount: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Selected collection total, or null for unavailable or scalar sections.'),
    kind: z
      .enum(['outline', 'section'])
      .optional()
      .describe('Absent for full dossier; outline lists sections; section returns one selection.'),
    sections: z
      .array(
        z
          .object({
            name: z.string().describe('Exact section selector.'),
            count: z
              .number()
              .int()
              .nullable()
              .describe('Collection record count; null for objects or unavailable data.'),
          })
          .describe('Retrievable dossier section.'),
      )
      .optional()
      .describe('Available section selectors.'),
    pagination: z
      .object({
        section: z.string().describe('Selected section.'),
        offset: z.number().int().describe('Requested zero-based record offset.'),
        limit: z
          .number()
          .int()
          .describe(
            'Effective maximum page size after the per-call cap; the byte budget may return fewer.',
          ),
        total: z
          .number()
          .int()
          .nullable()
          .describe('Collection total; null for scalar sections or unavailable collections.'),
        nextOffset: z
          .number()
          .int()
          .nullable()
          .describe('Next whole-record offset; null when complete.'),
      })
      .optional()
      .describe('Whole-record selection continuation.'),
    disclosure: z
      .string()
      .optional()
      .describe('Overflow, empty, unavailable, past-end, or response-budget-stop guidance.'),
    ...z
      .object({
        bill: BillSummarySchema.describe('Official bill summary.'),
        sponsor: z
          .object({
            name: text().describe('Official sponsor name, or null.'),
            personId: text().describe(
              'Official person ID, distinct from an OpenParliament slug; or null.',
            ),
            riding: text().describe('Sponsor riding, or null.'),
            title: BilingualTextSchema.describe(
              'Sponsor affiliation title, such as a ministerial office or Senator.',
            ),
          })
          .strict()
          .describe('Official sponsor fields.'),
        stages: z
          .object({
            house: z
              .array(StageSchema)
              .nullable()
              .describe('House stages, or null if unavailable.'),
            senate: z
              .array(StageSchema)
              .nullable()
              .describe('Senate stages, or null if unavailable.'),
            royalAssent: z
              .array(StageSchema)
              .nullable()
              .describe('Royal assent stages, or null if unavailable.'),
          })
          .partial()
          .strict()
          .describe('All official stage containers.'),
        divisions: z
          .array(
            z
              .object({
                session: z.string().describe('Verified division session.'),
                number: z.number().int().describe('House division number for canparl_get_vote.'),
                subject: BilingualTextSchema.describe('Official division subjects.'),
                dateTime: text().describe(
                  'LEGISinfo sitting date-time as published, not the time the division was recorded (canparl_get_vote reports that); or null.',
                ),
                result: text().describe('Official decision wording, or null.'),
                yeas: integer().describe('Yea count, or null.'),
                nays: integer().describe('Nay count, or null.'),
                paired: integer().describe('Paired count, or null.'),
                total: integer().describe('Official total, or null.'),
                url: z.string().describe('Absolute HTTPS House division URL.'),
              })
              .strict()
              .describe('Official House division record.'),
          )
          .nullable()
          .describe('House divisions, or null if unavailable.'),
        senateVoteDetails: z
          .array(JsonRecordSchema)
          .nullable()
          .describe('Complete variable Senate vote records; not House divisions.'),
        publications: z
          .array(
            z
              .object({
                id: z.number().int().describe('Official publication ID.'),
                typeId: integer().describe('Publication type ID, or null.'),
                type: BilingualTextSchema.describe('Publication type wording.'),
                url: z.string().describe('Verified absolute HTTPS document viewer URL.'),
              })
              .strict()
              .describe('Official publication record.'),
          )
          .nullable()
          .describe('Publications, or null if unavailable.'),
        statute: z
          .object({
            year: z.number().int().describe('Statute year.'),
            chapter: z.string().describe('Exact statute chapter designation.'),
            citation: z.string().describe('Statutes of Canada citation.'),
          })
          .strict()
          .nullable()
          .describe('Enacted statute when both year and chapter exist; otherwise null.'),
        summary: languageText('legislative summary as plain text').describe(
          'Library of Parliament legislative summary; summary.en and summary.fr sections each return one language.',
        ),
        notes: languageText('dossier notes as plain text, each link kept as text (href)').describe(
          'Official dossier notes; notes.en and notes.fr sections each return one language.',
        ),
        milestones: z
          .object({
            houseFirstReading: reading('House first reading'),
            houseSecondReading: reading('House second reading'),
            houseThirdReading: reading('House third reading'),
            senateFirstReading: reading('Senate first reading'),
            senateSecondReading: reading('Senate second reading'),
            senateThirdReading: reading('Senate third reading'),
          })
          .strict()
          .describe(
            'Reading milestones as UTC instants ending in Z (YYYY-MM-DDTHH:MM:SS[.fraction]Z); a value in another shape is relayed as published. Royal assent is bill.royalAssentDate.',
          ),
        webReferences: z
          .array(
            z
              .object({
                title: BilingualTextSchema.describe('Reference titles.'),
                typeId: integer().describe('Reference type ID, or null.'),
                type: BilingualTextSchema.describe(
                  'Reference type, such as Press Release or Legislative Costing Note.',
                ),
                url: BilingualTextSchema.describe(
                  'Reference URL or citation as published and never fetched; may be http, prose, or null.',
                ),
              })
              .strict()
              .describe('Official related web reference.'),
          )
          .nullable()
          .describe(
            'Related documents, press releases, and costing notes, or null if unavailable.',
          ),
        provenance: z
          .array(SourceSchema)
          .describe('Original retrieval metadata for every source request.'),
      })
      .partial()
      .required({ bill: true, provenance: true }).shape,
  }),
  enrichment: {
    appliedFilters: z
      .object({
        session: z.string().describe('Resolved official session.'),
        billCode: z.string().describe('Canonical bill code.'),
      })
      .strict()
      .describe('Normalized requested bill identity.'),
    notice: z
      .string()
      .optional()
      .describe('Limit clamp or source coverage guidance when applicable.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
    notice: { render: (value) => renderValue(z.string().parse(value), 'notice') },
  },
  errors: [
    {
      reason: 'invalid_bill_section',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unknown section selector or pagination supplied without a collection section.',
      recovery:
        'Choose an available section from the outline and use offset and limit only for collections.',
      retryable: false,
    },
    {
      reason: 'unknown_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Malformed or unsupported official bill session.',
      recovery: 'Call canparl_list_reference with topic sessions and choose a listed bill session.',
      retryable: false,
      thrownBy: 'service',
    },
    {
      reason: 'invalid_bill_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Ambiguous or malformed bill code.',
      recovery: 'Call canparl_search_bills by title and copy the returned billCode and session.',
      retryable: false,
    },
    {
      reason: 'bill_not_found',
      code: JsonRpcErrorCode.NotFound,
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
      const limit = clampCount('limit', input.limit, 100);
      let billCode: string;
      try {
        billCode = normalizeFilter('billCode', input.billCode, normalizeBillCode);
      } catch (error) {
        throw ctx.fail('invalid_bill_code', ...filterFailure(error));
      }
      const service = getLegisinfoService();
      const resolved = await service.resolveSession(input.session, request);
      const session = resolved.data;
      const result = await service.getBill(session, billCode, request);
      const notices = [
        ...(limit.notice ? [limit.notice] : []),
        ...(Number(session.split('-')[0]) < 37
          ? [
              'This early session provides basic bill coverage; unavailable dossier fields remain null.',
            ]
          : []),
      ];
      const enrichment = {
        appliedFilters: { session, billCode },
        ...(notices.length ? { notice: notices.join(' ') } : {}),
      };
      ctx.enrich(enrichment);
      request.throwIfOuterAborted();
      const full = { ...result.data, provenance: [...resolved.provenance, ...result.provenance] };
      const size = (value: unknown) => responseBytes(value, enrichment);
      // A dotted selector (`stages.house`, `summary.en`) selects one key under its parent.
      const sections = sectionNames.map((name) => {
        const [parent, child] = name.split('.') as [keyof BillDossier, string?];
        const container: unknown = full[parent];
        const value =
          child === undefined ? container : (container as Record<string, unknown>)[child];
        return { name, parent, child, value };
      });
      if (!input.section) {
        if (input.offset !== 0 || input.limit !== 20) throw ctx.fail('invalid_bill_section');
        if (size(full) <= RESPONSE_BUDGET) return full;
        return {
          kind: 'outline' as const,
          bill: full.bill,
          sponsor: full.sponsor,
          statute: full.statute,
          milestones: full.milestones,
          provenance: full.provenance,
          sections: sections.map(({ name, value }) => ({
            name,
            count: Array.isArray(value) ? value.length : null,
          })),
          disclosure: `Dossier exceeds the ${RESPONSE_BUDGET}-byte serialized response budget. Re-call with one section selector; collections use offset and limit. No records have been discarded.`,
        };
      }
      const selected = sections.find(({ name }) => name === input.section);
      if (!selected)
        throw ctx.fail(
          'invalid_bill_section',
          `Unknown section. Available sections: ${sectionNames.join(', ')}.`,
        );
      if (scalarSections.has(selected.name) && (input.offset !== 0 || input.limit !== 20))
        throw ctx.fail('invalid_bill_section');
      const values = Array.isArray(selected.value) ? selected.value : null;
      const page = (count: number, disclosure?: string) => {
        const value =
          values === null ? selected.value : values.slice(input.offset, input.offset + count);
        return {
          kind: 'section' as const,
          totalCount: values?.length ?? null,
          bill: full.bill,
          provenance: full.provenance,
          [selected.parent]: selected.child === undefined ? value : { [selected.child]: value },
          pagination: {
            section: selected.name,
            offset: input.offset,
            limit: limit.value,
            total: values?.length ?? null,
            nextOffset:
              values !== null && input.offset + count < values.length ? input.offset + count : null,
          },
          ...(disclosure ? { disclosure } : {}),
        };
      };
      const available =
        values === null ? 0 : Math.max(0, Math.min(limit.value, values.length - input.offset));
      /** A page shorter than `available` is a budget stop, disclosed inside the measured page. */
      const stop = (count: number) =>
        count < available
          ? `The ${RESPONSE_BUDGET}-byte response budget ended this page after ${count} ${count === 1 ? 'record' : 'records'}; call canparl_get_bill with pagination.nextOffset and the same section to continue.`
          : undefined;
      let count = available;
      while (count > 1 && size(page(count, stop(count))) > RESPONSE_BUDGET) count--;
      const disclosure =
        size(page(count, stop(count))) > RESPONSE_BUDGET
          ? 'One indivisible record or scalar section exceeds the serialized response budget; returned whole without truncation.'
          : selected.value === null
            ? 'Section is unavailable in the official source.'
            : values?.length === 0
              ? 'Section has no records.'
              : values !== null && input.offset >= values.length
                ? 'Offset is past the end of this section.'
                : stop(count);
      return page(count, disclosure);
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(JsonRecordSchema.parse(result)),
});
