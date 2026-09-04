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

## [2.0.0] - 2026-08-24

Released as a GitHub release. See the release notes for details.

[3.0.0]: https://github.com/WayLit/help-scout-mcp-server/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/WayLit/help-scout-mcp-server/releases/tag/v2.0.0
