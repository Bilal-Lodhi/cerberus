# Console polling and request frequency

How often the Flutter console calls the API, which endpoints it calls, and what that means for
the read-path cost this cycle is trying to price.

This is a **read-only audit** of `apps/console` at commit `e80dec7`. It exists because the
read-path cycle's central question — *is the live session detail's durable read expensive enough
to cache?* — depends on how often a client actually reads it, and that is a fact about the
console rather than about the API. The answer was not what the charter assumed, so it is
recorded with `file:line` evidence rather than summarised.

The freshness consequence is in
[live-read-freshness-policy.md](live-read-freshness-policy.md) §6.2; the measured cost of the
endpoints it calls is in [read-path-performance.md](read-path-performance.md) §4.

## 1. The poll loop, and its interval

There is **no `Timer.periodic`** anywhere in `apps/console/lib`. The only periodic mechanism is
an infinite `while (true)` with a trailing `Future.delayed`, and its interval is **5 seconds**:

`apps/console/lib/services/api_service.dart:212-230`

```dart
  Stream<RiskAssessmentPayload> streamAuditEvents(
    String sessionId, {
    Duration pollInterval = const Duration(seconds: 5),
  }) async* {
    // ── Polling ─────────────────────────────────────────────────────────────
    while (true) {
      try {
        final review = await fetchAuditRecord(sessionId);
        final payload = review.lastRiskPayload;
        if (payload != null && _isNewPolledPayload(payload)) {
          _lastPolledRiskPayload = payload;
          yield payload;
        }
      } catch (_) {
        // Silently swallow polling errors to keep the stream alive
      }
      await Future.delayed(pollInterval);
    }
  }
```

`streamAuditEvents` has exactly one call site, `guardian_provider.dart:55`, and it passes only
`sessionId` — so the 5-second default always applies and no caller overrides it.

The interval is a **floor, not a period**: the delay sits *after* the fetch (`:219` then `:228`),
so a tick takes `fetch duration + 5 s`.

Started and stopped by the provider:

- `apps/console/lib/providers/guardian_provider.dart:46-55` — `startStreaming`
- `apps/console/lib/providers/guardian_provider.dart:73-78` — `stopStreaming`, which does not
  await the cancellation future

The only other `Timer` in the app is a 500 ms ingest debounce
(`apps/console/lib/widgets/code_workspace_panel.dart:349`), which is not a poll.

## 2. What each tick calls

**One logical endpoint per tick — the review detail — and a live-detail fallback only when the
primary does not answer.**

`apps/console/lib/services/api_service.dart:299-308` (primary):

```dart
    try {
      final reviewUri = Uri.parse('$baseUrl/api/v1/sessions/$sessionId');
      final reviewRes = await _client
          .get(reviewUri, headers: _commonHeaders())
          .timeout(const Duration(seconds: 15));

      if (reviewRes.statusCode == 200) {
        final reviewBody = jsonDecode(reviewRes.body) as Map<String, dynamic>;
        final data = reviewBody['data'] as Map<String, dynamic>?;
        if (data != null) {
```

`apps/console/lib/services/api_service.dart:367-371` (fallback, same tick, sequential):

```dart
    // ── Fallback: guardian session endpoint ──
    final uri = Uri.parse('$baseUrl/api/v1/guardian/sessions/$sessionId');
    final response = await _client
        .get(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
```

The two are **sequential, not concurrent**: the `await` at `:219` blocks the loop body, and the
fallback's `await` at `:369` runs only after the first has completed or thrown. There is no
`Future.wait` in `fetchAuditRecord`.

So a tick is **one request** against `GET /api/v1/sessions/{id}` when the primary answers `200`
with a non-null `data`, and **two** when it does not.

Not on the timer: the list, health, the reference corpus, and every mutation endpoint.

## 3. The live list is not polled

`GET /api/v1/guardian/sessions` is fetched on **five explicit triggers** and on no timer:

| Trigger | Evidence |
| --- | --- |
| Dashboard mount | `dashboard_screen.dart:40-45` (`addPostFrameCallback` → `review.loadSessions()`) |
| Drawer refresh button | `dashboard_screen.dart:333` |
| Drawer error-state retry | `dashboard_screen.dart:447` |
| After a delete | `review_provider.dart:75-81` |
| After a successful deploy | `scenario_panel.dart:1682-1684` |

One `loadSessions()` call is **two sequential requests** — `GET /api/v1/sessions` then
`GET /api/v1/guardian/sessions` (`api_service.dart:473` then `:491`) — despite a comment at
`api_service.dart:466` reading *"Fetch from BOTH endpoints concurrently"*. The comment does not
describe the code; the two `await`s are in source order with no `Future.wait`.

Steady-state load on the live list is therefore **zero**.

## 4. There is no N+1

Rows render from summaries already in memory (`dashboard_screen.dart:505-507`, `:800-807`), and
the detail is fetched once for the tapped session (`dashboard_screen.dart:853-860`). Nothing
fetches detail per row.

## 5. Panel visibility is not consulted

The loop lives in `GuardianProvider`/`ApiService`, outside the widget tree, and reads nothing
about visibility: `api_service.dart:217-229` contains only the fetch, the change check, the
catch and the delay.

The single lifecycle observer in the app does not touch the stream — it emits a telemetry event:

`apps/console/lib/widgets/code_workspace_panel.dart:153-160`

```dart
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      _sendTabSwitchEvent();
    }
  }
```

`documentVisibilityState()` is used only to label that event
(`services/document_visibility.dart:13-14`). `_tabController` has no listener and is unused
outside `build`.

**Consequence:** closing the drawer, switching to the Terminal or Corpus tab, or backgrounding
the browser does not stop the 5-second detail poll. The only stops are the `stopStreaming()`
call sites.

## 6. Duplicate concurrent requests

- **No intra-stream overlap.** The fetch is awaited before the delay (`:219`, `:228`), so two
  ticks of one stream cannot overlap.
- **No in-flight guard anywhere.** `review_provider.dart:24-27` and `:41-44` set `_isLoading =
  true` and notify, but never test it before proceeding. There is no `_isPolling` flag in `lib`.
  The drawer's refresh and retry buttons are not disabled while loading.
- **Two concurrent identical detail requests on every session selection.** One tap handler does
  both:

  `apps/console/lib/screens/dashboard_screen.dart:856-859`

  ```dart
                    context.read<GuardianProvider>().resetForNewSession(
                      session.sessionId,
                    );
                    review.selectSession(session.sessionId);
  ```

  `resetForNewSession` starts the stream, whose first iteration immediately calls
  `fetchAuditRecord` (`api_service.dart:217-219`); `selectSession` calls `loadAuditRecord` →
  the same endpoint (`review_provider.dart:58-61`). Both are fire-and-forget.

  The same duplication happens on the telemetry refresh button
  (`security_metrics_panel.dart:394-401`).

- **`stopStreaming` does not abort the in-flight request.** `guardian_provider.dart:73-75`
  discards the `cancel()` future, and `Future.timeout` does not cancel the underlying
  `http.Client` request. So during a stop→start the old request can still be outstanding when
  the replacement stream issues its first.

## 7. No test constrains any of this

Grep over `apps/console/test` for `poll`, `interval`, `streamAuditEvents`, `fetchAuditRecord`,
`fetchSessions`, `Timer` or `fakeAsync` returns no matches. `widget_test.dart:20-22` states that
all HTTP fails harmlessly and no server is required. The only request-count assertion in the
suite covers scenario authoring (`api_service_scenario_test.dart:53-60`).

So the interval, the per-tick request count, the absence of a visibility guard and the duplicate
on selection are **unasserted by any test**.

## 8. Steady-state request rates

Assumptions: dashboard open, one session selected (stream active), 5-second interval, negligible
latency.

| Endpoint | Healthy primary | Primary non-200 / no `data` | Primary timing out at 15 s |
| --- | --- | --- | --- |
| `GET /api/v1/sessions/{id}` (review detail) | **12 /min** | 12 /min | 3 /min |
| `GET /api/v1/guardian/sessions/{id}` (live detail) | **0 /min** | 12 /min | 3 /min |
| `GET /api/v1/guardian/sessions` (live list) | **0 /min** | 0 /min | 0 /min |
| `GET /api/v1/sessions` (review list) | 0 /min | 0 /min | 0 /min |
| `GET /health` | 0 /min | 0 /min | 0 /min |

Arithmetic: `60 s ÷ 5 s = 12 ticks/min`; one request per tick on the healthy path, two when the
primary does not answer. A 15-second timeout makes a tick 20 s, so the rate *falls* to 3/min
while each tick holds a connection for 15 s.

**Mount burst:** 4 requests (2 list + 1 health + 1 corpus), plus one extra concurrent detail
`GET` on the selection that starts the stream.

**Total steady state: 12 requests/minute**, all of them to the **review** detail.

## 9. What this means for the read-path cycle

Three consequences, and together they decide the cache question:

1. **The surface the console polls is the review detail, which this cycle keeps durable
   on purpose.** It is the evidentiary surface; a review answer that is a cache is not evidence.
   See [live-read-freshness-policy.md](live-read-freshness-policy.md) §7.5.
2. **The live detail's steady-state load from the console is zero.** A cache in front of it
   would optimise a path no shipped client polls while the primary endpoint is healthy. The
   fallback path is real but it is a *degraded* path, and the case for making a degraded path
   faster is weaker than the case for making the healthy one correct.
3. **12 requests/minute is not over-polling.** Against the measured 6.55 ms review detail that is
   about 79 ms of work per minute, or 0.13 % of one process's capacity
   ([read-path-performance.md](read-path-performance.md) §4.1). There is no wasteful client
   behaviour here that a server cache would be masking, and nothing in the polling model needs
   fixing before a server-side change.

### Things this audit found that are not read-path performance

They are recorded because they were found, not because this cycle fixes them:

- **No visibility guard.** Polling continues while the browser is backgrounded or another tab is
  selected. On a long-lived console that is a real, if small, waste — and it is a *client* fix,
  not a server one.
- **Two concurrent identical detail requests per session selection.** Harmless at 12/min; worth
  removing when the console is next touched.
- **A comment that contradicts its code** (`api_service.dart:466` says "concurrently"; the code
  is sequential).
- **`stopStreaming` does not await cancellation**, so a request can outlive its stream.
- **No test asserts the polling model**, so any of the above could change silently.
