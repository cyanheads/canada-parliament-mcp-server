---
name: canada-parliament-guide
description: Use canparl_* tools to trace a Canadian federal bill through its versions and House divisions, read a bill version's text, find an MP by postal code, establish an MP's recorded ballot, or research historical Hansard evidence. Guides session identity, division selection, source coverage, and conclusions about missing activity.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.2"
---

## Scope

Use this guide when a parliamentary question needs evidence from more than one record: a bill's progress and votes, an MP's ballot on a particular motion, or speeches associated with legislation. Bills cover both chambers; member, division, and speech tools cover the House. Standalone Senate proceedings, committees, and provincial legislatures require other sources.

## Identifiers

Keep a bill's returned session and billCode together throughout the investigation, including any suffix letter. Carry that session with each division number obtained from canparl_get_bill or canparl_search_votes; a number alone does not identify the historical division.

For a member profile, pass the returned canparl_search_members detailLookup to canparl_get_member. For a historical division participant, the ballot row's personId can filter canparl_get_vote directly and, for members of the 36th Parliament onward, also opens their profile in canparl_get_member. A personId is never an OpenParliament slug: canparl_search_bills sponsor, canparl_search_speeches politician, and canparl_get_member slug read a personId only for a current MP. Any other digit-only value is an OpenParliament ID, so an answer for a former MP's personId can silently be another politician's. When the notice says the value is also a former MP's personId, call canparl_get_member with that personId and pass its member.slug where one is returned; a null slug means OpenParliament holds no verified profile for that member.

## Gates

- Before researching an older bill, resolve its session with canparl_list_reference and inspect the relevant source coverage. A missing field in basic bill coverage is not evidence that the event never occurred.
- Before reporting how an MP voted on a bill, inspect the selected division's subject and its relationship to the bill. Identify the motion or stage in the answer; do not treat every division attached to a bill as its final passage vote.
- Before quoting a bill's wording, check the version read: the publication's type, stage, and stageDate. A provision in the first-reading text may not survive to the version that passed or received Royal Assent.
- Before stating that a bill became law, inspect its dossier's status, royal-assent information, and statute citation. An agreed House division alone does not establish enactment.
- Before interpreting missing member activity, inspect the section's status. Unavailable or unrequested activity cannot support an empty-history conclusion.
- Before attributing a historical speech to a caucus or riding, use the returned speech-date affiliation. Leave unavailable affiliation unknown rather than filling it from the current roster.

## Workflows

### Trace a bill and an MP's ballot

Resolve the intended session, find the bill, and retain its complete identity. Read canparl_get_bill; if it returns an outline, retrieve the sections needed for the question before describing the bill's progress. Use its divisions or canparl_search_votes to discover candidate House votes, then inspect the relevant division with canparl_get_vote.

Resolve the MP independently and filter that division's ballots using the official personId. The filtered ballot page answers the individual question; the division's tally and party totals describe the full vote. If no recorded ballot appears, report that absence without inventing a reason for nonparticipation.

For a member-centred question spanning several divisions, canparl_get_member's official ballot activity can be scoped to a session and bill. Official ballots page up to 100 per call, and recentVotes.total is the exact count of the session's ballots after the bill filter, so one call sizes a session's record. Each ballot carries its division's yeas, nays, and paired tallies, which tell a unanimous division from a split one without a canparl_get_vote call per row. Follow nextOffset until hasMore is false before summarizing. A member without one official personId reads OpenParliament ballots instead: 10 per call, with no total and no division type. Inspect each returned division's subject before grouping the ballots into a claim about legislative support.

### Follow a bill's earlier versions

Bill numbers restart every session, and a bill that dies on the Order Paper usually returns under another number, so an earlier version is not found by number. In canparl_get_bill, read similarBills (earlier versions and related bills, newest session first) and reinstatement (the previous or next session's bill, when LEGISinfo records the reinstatement). A bill reinstated by government motion carries no reinstatement link; similarBills still lists its earlier version. Pass a returned session and billCode back to canparl_get_bill, keeping them together. interChamberMessages records whether the Senate amended the bill and how the House answered.

### Read a bill's text

canparl_get_bill_text reads one version as plain text. Take publicationId from canparl_get_bill publications; omitted, it reads the last-listed (furthest-stage) version, so pass an earlier publicationId to read the bill as introduced. Text over 24,000 bytes returns an outline with segment counts and the outermost headings, each with its body offset, count, and characters. Re-call with segment body and a heading's offset to read that part, and follow pagination.nextOffset; introduction, headings, and schedules are separate segments.

Sections are never split, and one section can be very large: a single section of 45-1 C-15 is 129,702 characters, so limit 1 alone returns about 271 KB. Use a heading's characters to size a page before reading a large part, and request a small limit for it. Explanatory notes sit in explanatoryNotes, apart from the enacted text; never quote them as law. Many versions before 42-1 are published only as a PDF and have no text here: the call fails as bill_text_unavailable, so read the version on its publications url and do not conclude that the bill lacked a provision.

### Find an MP by postal code

Pass the complete postal code to canparl_search_members postalCode. It returns the sitting MPs whose ridings contain the code, more than one when the code spans ridings, and an empty page with a notice for an unassigned code or a vacant riding. It reads the current roster only and cannot name who represented a code in an earlier Parliament; for that, search that Parliament's roster with parliament and the riding name. Pass the row's detailLookup to canparl_get_member.

### Research what a member said about legislation

Resolve the member and bill first. In canparl_search_speeches, distinguish speeches indexed under the bill being debated from speeches mentioning that bill. Combining those relationships narrows the query to their intersection; use separate searches when the question asks for either relationship.

Inspect headings and the complete returned speech before attributing a position. For questions about procedural conduct, include procedural remarks rather than relying on the substantive-only default. A completed indexed search establishes only what matched that scope, not that no parliamentary speech occurred.

Speeches come back in English by default. Set language to fr to read and search French Hansard (speaker, headings, content, and the contains scan); party and riding stay English. Older records carry no French: none in sampled 1994–2005 speeches, and no French headings or attribution in samples through late 2011 (they appear by mid-2012). A French scan that finds nothing therefore says nothing about those records. Read the notice reporting scanned candidates with no French text, or repeat the search in English.

### Investigate a former MP

When the Parliament is known (36th onward), use canparl_search_members with parliament: it searches that Parliament's official roster for everyone who sat in it, with official personIds, ridings, caucus, and membership dates. A roster row carries one caucus per member, the last held in that Parliament, so it does not show a mid-term switch or the caucuses at a given division; read those from canparl_get_vote byParty. Otherwise use historical mode (includeFormer) for name discovery. Then inspect the returned member profile and dated memberships. A former member's personId opens a canparl_get_member profile carrying their latest Parliament's caucus and riding. Historical name results are sparse: unknown caucus or riding values do not exclude a candidate. Continue into the profile's available activity or a specific historical division; do not reconstruct past affiliation from today's roster.
