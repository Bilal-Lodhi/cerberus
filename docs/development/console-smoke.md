# The console smoke

`npm run verify:console-smoke` builds the Flutter web console, starts a disposable
MongoDB-backed stack, serves the bundle, drives **headless Chrome** over the DevTools
Protocol, and asserts what a machine can assert. It writes screenshots for the part a
machine cannot.

It exists because the `v0.2.0` and `v0.3.0` browser passes were **sessions**: the driver
shipped, the step script did not, and the pass was judged from screenshots nobody could
reproduce. Two real defects were caught that way — a false claim on the identity gate
(PR #45) and a retired read-ceiling claim on the corpus panel (PR #46) — which is exactly
the value of the pass, and exactly the value that was being lost.

## Running it

```bash
npm run verify:console-smoke

# Keep the container and the screenshots for inspection.
node scripts/release/console-smoke.mjs --keep --out ./smoke
```

It needs Docker (a disposable `mongo:7`), Flutter (to build the bundle) and Chrome. Each is
checked, and its absence is a **skip with the reason** rather than a failure.

It is also a step in `npm run verify:release`.

## What is automated, and what is not

Flutter web renders into a **canvas**, so the page's text is not in the DOM and a
selector-based assertion cannot read it. A check that pretended to read the canvas would be
a check that lied. So the work is split three ways, and the split is stated rather than
implied.

| Coverage | Where | Notes |
| --- | --- | --- |
| The page renders, not a blank canvas | **This smoke** | A canvas that never rendered compresses to a few kilobytes; a rendered dashboard is an order of magnitude larger |
| No browser console error | **This smoke** | Collected over CDP |
| No layout overflow | **This smoke** | Flutter reports one to the console as `A RenderFlex overflowed by N pixels` — the same signal a human looks for |
| The identity gate, the dashboard, the corpus panel at a narrow and a wide viewport | **Screenshots**, inspected by a human | `01-identity-gate`, `02-identity-filled`, `03-dashboard`, `04-narrow`, `05-wide` |
| An empty corpus is an empty list, not an error | `apps/console/test/reference_corpus_test.dart` | Machine-verifiable |
| The corpus ceiling the server enforces | Same | The console's constant is asserted equal to the API's |
| Add validation (label, content, tags, blank fields) | Same | Rejected locally without a request |
| A rejected delete surfaces as an error | Same | |
| The current terminology, on screen | **Screenshots** | What the two historical defects were |

The widget tests are the machine-verifiable half and run in CI on every pull request
(`npm run console:test`). This smoke is the browser-level half, and it is the one that
catches a claim that is wrong only once it is rendered.

## What to look for in the screenshots

1. **The identity gate.** It must ask who the operator is, and it must not claim any
   integration that does not exist. The footer should still say *"This is a local operator
   label, not an account: there is no sign-in, no roles and no per-user attribution."* — the
   owner decision that accounts and RBAC are out of scope.
2. **The dashboard shell.** Both empty panels — *"Employee Terminal Workspace"* and
   *"Security metrics appear here"* — and the header.
3. **The reference corpus panel.** It must say `0 of 200 document(s) compared`, describe the
   corpus as **empty** rather than unavailable, state the honest local-similarity wording,
   and show the three input bounds (200 characters, 20 000 characters, 20 tags × 50).
   It must **not** describe the retired read-ceiling behaviour.
4. **The narrow viewport.** Nothing clipped, nothing overlapping, no scrollbar where there
   should be none.

## Two couplings this smoke found by failing

Both were found by the smoke's own first runs, and both are things an operator would hit:

- **The console must be served from an origin the API allows.** The API's development CORS
  allow-list is `localhost`/`127.0.0.1` on 8080 and **5173** only. Served from 8090, the
  browser blocks the call and the identity gate reports *"Failed to connect to identity
  service"* — which looks like an API outage and is a CORS rejection. The smoke serves on
  5173 for that reason.
- **A default release build fetches CanvasKit from `gstatic.com`.** Without network access
  to it the canvas never renders, and every check passes on a blank page. The smoke builds
  with `--no-web-resources-cdn`, and the "rendered content" check is what would catch it
  again.

## The driver

`scripts/qa/cdp.mjs` is a dependency-free CDP driver (Node's global `WebSocket`), and
`scripts/qa/console-smoke.json` is the checked-in step script — that is what makes the pass
reproducible rather than ad hoc. Steps:

| Step | Effect |
| --- | --- |
| `{ "screenshot": "name" }` | Write `<outDir>/name.png` |
| `{ "click": [x, y] }` | Click at viewport coordinates |
| `{ "type": "text" }` | `Input.insertText` — **does not reach Flutter's hidden input** |
| `{ "typetext": "text" }` | Per-character key events — the one that does |
| `{ "key": "Tab" }` | Press a key |
| `{ "viewport": [w, h] }` | Resize the emulated viewport |
| `{ "wait": 1500 }` | Wait |
| `{ "eval": "expr" }` | Evaluate JS and print the result |
| `{ "console": true }` | Dump the console messages collected so far |

`typetext` rather than `type` is not a preference: Flutter web routes text through a hidden
DOM input, and `Input.insertText` does not reach it. The first version of the step script
used `type`, and the identity fields stayed empty.
