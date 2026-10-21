/**
 * @fileoverview Complete official bill dossiers with source-preserving stage records.
 * @module mcp-server/tools/definitions/get-bill.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { normalizeBillCode, normalizeSession } from '@/domain/normalization.js';
import { createRequestContext } from '@/domain/request-context.js';
import {
  BilingualTextSchema,
  JsonRecordSchema,
  SessionInputSchema,
  SourceSchema,
} from '@/domain/schemas.js';
import { getLegisinfoService } from '@/services/legisinfo/index.js';
import { formatResult, renderValue } from './_format.js';

const text = () => z.string().nullable();
const integer = () => z.number().int().nullable();
const chamber = () => z.enum(['House', 'Senate']).nullable();
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
        chamber: text().describe('Latest completed major stage chamber, or null.'),
      })
      .strict()
      .nullable()
      .describe('Latest completed major stage, or null.'),
    royalAssentDate: text().describe('Official royal assent date, or null.'),
    url: z.string().describe('Absolute HTTPS official bill URL.'),
  })
  .strict()
  .describe('Official bill summary.');
const StageSchema = z
  .object({
    id: z.number().int().describe('Official bill stage ID.'),
    name: BilingualTextSchema.describe('Official stage names.'),
    chamber: chamber().describe('Containing chamber, or null for royal assent.'),
    state: z
      .object({
        id: integer().describe('Official stage state ID, or null.'),
        en: text().describe('English state wording, or null.'),
        fr: text().describe('French state wording, or null.'),
      })
      .strict()
      .describe('Official state including unavailable values.'),
    stateAsOf: text().describe('Source state-as-of date, or null.'),
    committee: z
      .object({
        id: integer().describe('Committee organization ID, or null.'),
        acronym: text().describe('Committee acronym, or null.'),
        name: BilingualTextSchema.describe('Committee names.'),
      })
      .strict()
      .nullable()
      .describe('Committee referral, or null.'),
    sittings: z
      .array(
        z
          .object({
            number: text().describe('Sitting number, or null.'),
            date: text().describe('Sitting date, or null.'),
            name: BilingualTextSchema.describe('Sitting names.'),
            published: z.boolean().nullable().describe('Publication flag, or null.'),
          })
          .strict()
          .describe('Official sitting record.'),
      )
      .nullable()
      .describe('Actual sittings, empty if none; null if unavailable.'),
    committeeMeetings: z
      .array(
        z
          .object({
            number: text().describe('Committee meeting number, or null.'),
            date: text().describe('Committee meeting date, or null.'),
            committeeId: integer().describe('Committee organization ID, or null.'),
            acronym: text().describe('Committee acronym, or null.'),
            name: BilingualTextSchema.describe('Committee meeting names.'),
          })
          .strict()
          .describe('Official committee meeting record.'),
      )
      .nullable()
      .describe('Actual committee meetings, or null if unavailable.'),
    decisions: z
      .array(JsonRecordSchema)
      .nullable()
      .describe('Complete variable official decisions, or null.'),
    significantEvents: z
      .array(JsonRecordSchema)
      .nullable()
      .describe('Complete variable significant events, or null.'),
    endOfStageEvent: JsonRecordSchema.nullable().describe('Complete end-of-stage event, or null.'),
  })
  .strict()
  .describe('Complete official stage record.');

/** Read one official bill dossier without changing unavailable source values. */
export const getBillTool = tool('canparl_get_bill', {
  description:
    "Read one House or Senate bill's official dossier, including both chambers' stages, publications, House divisions, and an enacted statute citation when available. Obtain billCode and session from canparl_search_bills; omitted session means the verified current official session.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    session: SessionInputSchema,
    billCode: z
      .string()
      .describe('Bill code from canparl_search_bills; accepts bill s321, S321, or S-321.'),
  }),
  output: z.object({
    bill: BillSummarySchema.describe('Official bill summary.'),
    sponsor: z
      .object({
        name: text().describe('Official sponsor name, or null.'),
        personId: text().describe(
          'Official person ID, distinct from an OpenParliament slug; or null.',
        ),
        riding: text().describe('Sponsor riding, or null.'),
      })
      .strict()
      .describe('Official sponsor fields.'),
    stages: z
      .object({
        house: z.array(StageSchema).nullable().describe('House stages, or null if unavailable.'),
        senate: z.array(StageSchema).nullable().describe('Senate stages, or null if unavailable.'),
        royalAssent: z
          .array(StageSchema)
          .nullable()
          .describe('Royal assent stages, or null if unavailable.'),
      })
      .strict()
      .describe('All official stage containers.'),
    divisions: z
      .array(
        z
          .object({
            session: z.string().describe('Verified division session.'),
            number: z.number().int().describe('House division number for canparl_get_vote.'),
            subject: BilingualTextSchema.describe('Official division subjects.'),
            dateTime: text().describe('Official date-time string, or null.'),
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
    provenance: z
      .array(SourceSchema)
      .describe('Original retrieval metadata for every source request.'),
  }),
  enrichment: {
    appliedFilters: z
      .object({
        session: z.string().describe('Resolved official session.'),
        billCode: z.string().describe('Canonical bill code.'),
      })
      .strict()
      .describe('Normalized requested bill identity.'),
    notice: z.string().optional().describe('Source coverage guidance when applicable.'),
  },
  enrichmentTrailer: {
    appliedFilters: { render: (value) => renderValue(value, 'appliedFilters') },
  },
  errors: [
    {
      reason: 'unknown_session',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Unsupported official bill session.',
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
  ],
  async handler(input, ctx) {
    const request = createRequestContext(ctx);
    try {
      let billCode: string;
      try {
        billCode = normalizeBillCode(input.billCode);
      } catch {
        throw ctx.fail('invalid_bill_code');
      }
      const service = getLegisinfoService();
      let session = normalizeSession(input.session);
      const currentProvenance = [];
      if (session === undefined) {
        const current = await service.getCurrentSession(request);
        session = current.data;
        currentProvenance.push(...current.provenance);
      }
      const result = await service.getBill(session, billCode, request);
      ctx.enrich({ appliedFilters: { session, billCode } });
      if (Number(session.split('-')[0]) < 37)
        ctx.enrich.notice(
          'This early session provides basic bill coverage; unavailable dossier fields remain null.',
        );
      request.throwIfOuterAborted();
      return { ...result.data, provenance: [...currentProvenance, ...result.provenance] };
    } finally {
      request.dispose();
    }
  },
  format: (result) => formatResult(result),
});
