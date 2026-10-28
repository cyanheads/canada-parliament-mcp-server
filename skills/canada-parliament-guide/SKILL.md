---
name: canada-parliament-guide
description: Use canparl_* tools to trace a Canadian federal bill through House divisions, establish an MP's recorded ballot, or research historical Hansard evidence. Guides session identity, division selection, source coverage, and conclusions about missing activity.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use this guide when a parliamentary question needs evidence from more than one record: a bill's progress and votes, an MP's ballot on a particular motion, or speeches associated with legislation. Bills cover both chambers; member, division, and speech tools cover the House. Standalone Senate proceedings, committees, and provincial legislatures require other sources.

## Identifiers

Keep a bill's returned session and billCode together throughout the investigation, including any suffix letter. Carry that session with each division number obtained from canparl_get_bill or canparl_search_votes; a number alone does not identify the historical division.

For a member profile, pass the returned canparl_search_members detailLookup to canparl_get_member. For a historical division participant, the ballot row's personId can filter canparl_get_vote directly; do not assume that identifier also permits a current-member profile lookup.

## Gates

- Before researching an older bill, resolve its session with canparl_list_reference and inspect the relevant source coverage. A missing field in basic bill coverage is not evidence that the event never occurred.
- Before reporting how an MP voted on a bill, inspect the selected division's subject and its relationship to the bill. Identify the motion or stage in the answer; do not treat every division attached to a bill as its final passage vote.
- Before stating that a bill became law, inspect its dossier's status, royal-assent information, and statute citation. An agreed House division alone does not establish enactment.
- Before interpreting missing member activity, inspect the section's status. Unavailable or unrequested activity cannot support an empty-history conclusion.
- Before attributing a historical speech to a caucus or riding, use the returned speech-date affiliation. Leave unavailable affiliation unknown rather than filling it from the current roster.

## Workflows

### Trace a bill and an MP's ballot

Resolve the intended session, find the bill, and retain its complete identity. Read canparl_get_bill; if it returns an outline, retrieve the sections needed for the question before describing the bill's progress. Use its divisions or canparl_search_votes to discover candidate House votes, then inspect the relevant division with canparl_get_vote.

Resolve the MP independently and filter that division's ballots using the official personId. The filtered ballot page answers the individual question; the division's tally and party totals describe the full vote. If no recorded ballot appears, report that absence without inventing a reason for nonparticipation.

For a member-centred question spanning several divisions, canparl_get_member's official ballot activity can be scoped to a session and bill. Inspect each returned division's subject before grouping the ballots into a claim about legislative support.

### Research what a member said about legislation

Resolve the member and bill first. In canparl_search_speeches, distinguish speeches indexed under the bill being debated from speeches mentioning that bill. Combining those relationships narrows the query to their intersection; use separate searches when the question asks for either relationship.

Inspect headings and the complete returned speech before attributing a position. For questions about procedural conduct, include procedural remarks rather than relying on the substantive-only default. A completed indexed search establishes only what matched that scope, not that no parliamentary speech occurred.

### Investigate a former MP

Use canparl_search_members historical mode for name discovery, then inspect the returned member profile and dated memberships. Historical name results are sparse: unknown caucus or riding values do not exclude a candidate. Continue into the profile's available activity or a specific historical division; do not reconstruct past affiliation from today's roster.
