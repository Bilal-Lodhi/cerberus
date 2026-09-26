# Managing the reference corpus

The reference corpus is the operator-managed set of documents that paste content is
compared against during risk analysis. It is the local, deterministic half of the
anti-exfiltration signal: the model is **not** asked whether content looks exfiltrated
— Cerberus computes that itself, so the answer is reproducible from inputs an operator
can inspect.

## The assessment: why this needed a console surface

Before this, the corpus had **no console surface at all** — a search for "reference"
under `apps/console/lib` returned nothing. Populating it meant hand-writing `curl`:

```bash
curl -X POST http://localhost:8080/api/v1/reference-documents \
  -H "Authorization: Bearer $CERBERUS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"label":"Internal IBAN list","content":"...","tags":["banking","pii"]}'
```

That is a defensible interface for a research prototype. It stopped being defensible
once the corpus became load-bearing, for three reasons:

1. **An empty corpus silently disables a detection signal.** `findSimilarityMatches`
   compares against the corpus; with nothing in it, the `exfiltrationReport` is always
   empty. An operator who never populates it sees an empty match set and can read that
   as "nothing leaked". The failure is silent and looks like a clean result.
2. **The corpus is content, not configuration.** It is expected to grow, be edited and
   be pruned as an organisation's sensitive material changes. That is a workflow, and
   a workflow behind hand-written HTTP is one that does not happen.
3. **The API is not self-describing about its limits.** Label 200 characters, content
   20 000, 20 tags of 50, 200 documents. A `curl` user discovers those by receiving a
   `400`.

So a small console surface is justified, and the charter's condition for building one
— "if it materially improves the workflow" — is met. It is a panel, not a screen:
the corpus belongs beside telemetry, not in its own navigation branch.

## What the panel does

`apps/console/lib/widgets/reference_corpus_panel.dart`, on the dashboard's wide
layout next to the code workspace and security metrics.

| Capability | Detail |
| --- | --- |
| **List** | Label, tags, character count, a content preview, and when it was last updated |
| **Add** | Label, multi-line content, comma-separated tags |
| **Remove** | Per-document, behind a confirmation |
| **Validate first** | The API's own limits are enforced client-side, so a typo costs a field-level message instead of a `400` |
| **Show capacity** | The corpus is capped at 200 documents; the panel says when it is full rather than letting an add fail |
| **States** | Loading, error, and an empty state that explains what the corpus is for |

Two things the panel states rather than leaving to be inferred, because both are
misreadings an operator could reasonably make:

- **Cerberus never populates the corpus itself.** There is no crawler, no bundled
  corpus and no external reference service. Every row was added by an operator. The
  empty state says so explicitly, because an operator who assumes the corpus is
  already populated would read an empty match set as "nothing leaked".
- **A match is evidence about phrasing, not about copying.** The panel describes what
  the corpus is for; it does not present a match as a finding.

## What the corpus is not

Recorded here because the panel is a surface for a security signal, and a surface that
overstates its signal is worse than none.

| Not claimed | Reality |
| --- | --- |
| Plagiarism detection | A Jaccard similarity over 3-token shingles. It measures shared phrasing, not authorship or intent. |
| Machine-generation detection | `aiCompletionLikelihood` is always `0`. Cerberus does not attempt to determine whether content was machine-generated. |
| Complete coverage of sensitive material | It covers what the operator put in it. An empty or stale corpus is an empty or stale signal. |
| Model-assessed | The comparison is local and deterministic. The model's own `exfiltrationReport` is **replaced**, not merged, because only the local result is reproducible. |
| Effective on short text | Texts under 10 comparable tokens are not compared at all, rather than producing a meaningless score. |

## The API, for automation

The panel is a surface over the same endpoints, so anything it does can be scripted:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/reference-documents` | List, with a preview rather than full content |
| `POST` | `/api/v1/reference-documents` | Add one document |
| `DELETE` | `/api/v1/reference-documents/:referenceId` | Remove one document |

Limits, enforced by the API and mirrored in the console:

| Field | Limit |
| --- | --- |
| `label` | 200 characters |
| `content` | 20 000 characters |
| `tags` | 20 tags, each 50 characters |
| Documents listed and compared | 200 |

**The 200-document figure is a hard ceiling, enforced at the store.** It bounds what the
list endpoint returns, what the similarity loader reads, and — since the ceiling work —
what `POST` will accept. A create past it is refused with `409` and
`REFERENCE_CORPUS_LIMIT_REACHED`, so a document can no longer be stored and then silently
do nothing.

That was the previous behaviour, and it was the worst of the three possible ones: a 201st
document was accepted, stored, and then neither listed nor compared against. The operator
saw a successful add; detection saw nothing. The console disabled its add control at 200,
but the API did not reject the write, so a script against the endpoint could put the
corpus into that state.

The console still validates first — a field-level message beats a rejected request — and
now also surfaces the server's own refusal, which is the one case the client cannot
predict: another operator filling the corpus between the panel loading and the add.

**Updating an existing document is always allowed, at any size.** An update does not grow
the corpus, so the ceiling must not block it — otherwise an operator could not correct a
document once the corpus was full. Only a genuinely new `referenceId` claims a slot, and
deleting a document releases one.

The ceiling is enforced with an atomic conditional `$inc` on a single counter document
(`reference_corpus_meta`), not with a count-then-insert. A count-then-insert would race:
two concurrent creates at one below the limit would both read the same count and both
insert, and the corpus would reach 201. The counter is raised from the real document count
before each claim, so a counter left behind by a restore or a write that bypassed the API
self-heals rather than letting the corpus grow past its ceiling.

The list response carries a **preview**, not full content: the corpus is read in full
on every risk analysis, and echoing it back through the list endpoint would make that
response grow with the corpus for no operational benefit.

## Operating it

1. **Start with the material that matters.** Customer identifiers, account numbers,
   internal-only schemas, the code patterns a departing employee would take. The
   signal is only as good as the corpus.
2. **Label it so a match is actionable.** The label appears in the finding; "Internal
   IBAN list" tells an operator what to do next, "doc1" does not.
3. **Tag consistently.** Tags are for your own retrieval, not for the analysis.
4. **Prune it.** A document that is no longer sensitive produces matches that are no
   longer interesting, and dilutes attention.
5. **Watch the capacity.** At 200 documents the panel reports it is full. That ceiling
   exists because the whole corpus is loaded on every analysis.

## Why the whole corpus is loaded per analysis

`loadReferenceCorpus()` reads the corpus in full on every risk analysis: one bounded
MCP call against a local database, alongside the two or three the analysis path
already makes.

A cache was considered and rejected. Its staleness would be invisible to the operator
who just edited the corpus — they would add a document, run an analysis, and get a
result computed against the previous set, with nothing saying so. The 200-document cap
is what keeps the uncached read bounded, and it is why the cap exists.

## Configuration

| Variable | Effect |
| --- | --- |
| `DATA_LEAKAGE_SIMILARITY_THRESHOLD` | The Jaccard threshold at or above which a pair becomes an `ExfiltrationMatch`. Default `0.75`. |

Lower it to catch looser paraphrase and accept more false positives; raise it for
precision. It is a ratio between 0 and 1, and an unusable value is a startup error
rather than a silent default.
