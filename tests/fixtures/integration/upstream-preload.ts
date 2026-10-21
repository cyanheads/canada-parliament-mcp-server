/**
 * @fileoverview Strict synthetic HTTP boundary for the actual stdio entry point.
 * @module tests/fixtures/integration/upstream-preload
 */
import { appendFileSync } from 'node:fs';

const bill = (code: string) => ({
  ParliamentNumber: 45,
  SessionNumber: 1,
  NumberCode: code,
  IsSessionOngoing: true,
  LongTitleEn: `Synthetic marine act ${code}`,
  LongTitleFr: `Loi synthétique ${code}`,
  BillDocumentTypeNameEn: 'Government Bill',
  OriginatingChamberNameEn: 'House of Commons',
  StatusNameEn: 'At second reading in the House of Commons',
});
const root = 'https://www.parl.ca/legisinfo/en';
const routes = new Map<string, () => Response>([
  [`${root}/bills`, () => new Response('<a data-input="parlsession" data-value="45-1">45-1</a>')],
  [`${root}/bills/json`, () => Response.json([bill('C-901')])],
  [`${root}/bills/json?parlsession=45-1`, () => Response.json([bill('C-901'), bill('C-902')])],
  [
    `${root}/bill/45-1/c-901/json`,
    () =>
      Response.json([
        {
          ...bill('C-901'),
          SponsorPersonName: 'River Example',
          SponsorPersonId: 99001,
          BillStages: {
            HouseBillStages: [
              {
                BillStageId: 990,
                BillStageNameEn: 'Synthetic committee stage',
                Committee: {
                  CommitteeOrganizationId: 991,
                  CommitteeNameEn: 'Synthetic marine committee',
                },
                Sittings: [{ Number: 3, NameEn: 'Synthetic third sitting', IsPublished: true }],
                Decisions: [{ nested: { values: ['Synthetic decision', null, 7] } }],
              },
            ],
          },
        },
      ]),
  ],
  [`${root}/bill/45-1/c-999/json`, () => new Response('', { status: 404 })],
  [
    'https://www.ourcommons.ca/Members/en/votes',
    () => new Response('<a data-input="parlSession" data-value="45-1">45-1</a>'),
  ],
]);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const route = routes.get(url);
  appendFileSync(
    'requests.jsonl',
    `${JSON.stringify({ url, matched: !!route, method: init?.method ?? 'GET' })}\n`,
  );
  if (!route) throw new Error(`Unexpected integration HTTP request: ${url}`);
  return route();
}) as typeof fetch;
