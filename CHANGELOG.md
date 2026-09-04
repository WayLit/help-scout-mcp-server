# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-08-25

Consolidates the mailbox conversation-search surface: four overlapping search
tools collapse into one `searchConversations`, and `searchInboxes` folds into
`listAllInboxes`. The mailbox connector goes from 24 tools to 20 (measured
serialized surface: ~3,220 approximate tokens).

The Docs connector (`/docs/mcp`) is unchanged.

### Removed

This is a breaking tool-surface change. Removed names are **not** aliased —
`2.0.0` set the precedent of dropping removed names rather than shimming them.

| Change | Migration |
|---|---|
| `advancedConversationSearch` removed | Use `searchConversations` with `contentTerms`/`subjectTerms`/`customerEmail`/`emailDomain`/`tags` |
| `comprehensiveConversationSearch` removed | Use `searchConversations` with `searchTerms` and `status` as an array. `searchTerms` matches the subject **or** the body, which is what the old `searchIn: ["both"]` default did; reach for `contentTerms`/`subjectTerms` only where `searchIn` narrowed to one field, since passing both AND-s them |
| `structuredConversationFilter` removed | Use `searchConversations` with `assignedTo`/`folderId`/`customerIds`/`conversationNumber` |
| `searchInboxes` removed | Use `listAllInboxes` with `query` |
| `resultsByStatus` output shape dropped | Flat `results` plus `pagination.totalByStatus` carries the same information |
| `timeframeDays` dropped | No implicit 60-day window; pass `createdAfter` explicitly |
| `limitPerStatus` dropped | `limit` caps the merged result set |
| `tag` (singular) dropped | Use `tags: ["urgent"]` |
| `sortBy`/`sortOrder` dropped | Use `sort`/`order`, which gain the full 9-value sort enum |
| `searchInboxes` output keys | `results`/`totalFound` → `inboxes`/`totalInboxes`; `totalAvailable` retained |

The `structuredConversationFilter` "must use at least one unique field" guard
is dropped: the merged tool always has a bounded default (active+pending,
sorted, `limit` 50), so an unfiltered structural scan is no longer reachable.

### Added

- **`searchTerms[]`** on `searchConversations` — matches a term in either the
  subject or the body, which is the right default for "find tickets mentioning
  X". `contentTerms`/`subjectTerms` remain for narrowing to one field, and AND
  with each other.
- **A `conversationNumber` lookup now searches every status automatically.**
  Looking up a ticket by number is an identity lookup, not a "what's open right
  now" browse — people reach for an old ticket number precisely when the ticket
  is closed. Passing `conversationNumber` without `status` resolves to `"all"`;
  an explicit `status` still wins.

### Changed

- Omitting `status` searches `active` and `pending` in parallel and merges the
  results, deliberately excluding `closed` as noise. Pass a status, an array of
  statuses to sweep and merge, or `"all"` to widen.
- On a multi-status search, `sort`/`order` apply across the merged window
  rather than globally: each status is paginated independently, so only the
  fetched rows can be ordered together. Rows whose payload omits the sort field
  keep a round-robin interleave of the per-status results, so no single status
  can consume the whole `limit`.
- A multi-status `searchConversations` now returns an **opaque** `nextCursor`
  instead of a page number, because one page number cannot describe several
  independently-paginated statuses. Pass it back unchanged; a plain page number
  still works and still means "page N of every status". Single-status searches
  are unaffected and keep returning Help Scout's own page URL.

### Fixed

- **A multi-status search no longer drops the rows its merged window truncated
  away** ([#79]). Every status was advanced a full upstream page even though
  only part of each page fit inside `limit`, so the remainder was returned by
  no page at all — a default `limit: 50` sweep of `active`+`pending` could
  strand 50 conversations per page, with `pagination.totalAvailable` still
  reporting the full total. The cursor now records a resume position per
  status, so each one continues exactly where the previous response stopped.
- **Each status's final page is reachable again** on a multi-status search. The
  "is there another page" test compared `page.number + 1` against `totalPages`,
  but Help Scout's `page.number` is 1-based, so a status sitting on page N-1 of
  N reported itself finished and its last page was never fetched.

## [2.0.0] - 2026-08-24

Released as a GitHub release. See the release notes for details.

[#79]: https://github.com/WayLit/help-scout-mcp-server/issues/79

[3.0.0]: https://github.com/WayLit/help-scout-mcp-server/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/WayLit/help-scout-mcp-server/releases/tag/v2.0.0
