---
name: testing-better-hub-local
description: How to bring up better-hub locally (docker services, deps, build, dev server) and what can/cannot be exercised without real GitHub OAuth credentials.
---

# Testing better-hub locally

## Bring-up (verified)

1. `docker compose up -d` from the repo root — starts postgres on `127.0.0.1:54320`, redis, and a
   serverless-redis-http proxy on `127.0.0.1:8079`. `apps/web/.env` should point
   `DATABASE_URL` at `postgresql://postgres:postgres@localhost:54320/better_hub`.
2. `bun install` at the repo root.
3. `cd apps/web && bun x prisma generate` — **`bunx` is not installed on the Devin box; use `bun x`.**
4. Production build (what CI runs, and the highest-value smoke check):
   `SKIP_ENV_VALIDATION=true bun run build` from the repo root. Takes ~2–3 min.
   Expect warnings that are normal and not failures: "inferred your workspace root" (two lockfiles),
   `[billing] STRIPE_SECRET_KEY is not set`, and Better Auth `Missing BETTER_AUTH_API_KEY` warnings.
5. Dev server: `bun dev` from the repo root → http://localhost:3000 (ready in ~5s).
6. Unit tests: `cd apps/web && bun x vitest run <path>` (`bun run test` = `vitest` in watch mode).

## Auth wall

- `src/proxy.ts` treats only `/`, `/api/auth`, `/api/inngest` as public. Every other route
  redirects to `/` when there is no session cookie — so without a session you can only assert
  "landing page renders" + "gated routes redirect", not any authed surface.
- Clicking "Continue with GitHub" redirects to github.com with whatever `GITHUB_CLIENT_ID` is in
  `apps/web/.env`. With the placeholder value the OAuth app does not exist.

## Signing in locally with the GitHub emulator (no real OAuth app)

Requires the `GITHUB_EMULATOR_URL` support in `src/lib/github-emulator.ts`. If that file is absent
on your branch, authed UI is unreachable — say so rather than faking it.

1. `npx emulate@latest start --service github --port 4000` (seeded users `admin`, `ghost`).
2. Put `GITHUB_EMULATOR_URL=http://localhost:4000` in `apps/web/.env`, then **start the dev server
   afterwards** — the `fetch` patch installs at server startup from `src/instrumentation.ts`, so a
   server started before the var was set silently talks to real github.com.
3. Confirm the patch installed: the dev log must contain
   `[github-emulator] routing GitHub traffic at http://localhost:4000`. This is the single best
   sanity check.
4. In the browser click "Continue with GitHub" → the authorize page is served by **localhost:4000**
   (green "Sign in to GitHub | emulate" screen) → click the `admin` row → you land signed in.
5. Seed data the app can read, e.g.
   `curl -X POST -H "Authorization: Bearer test_token_admin" -H 'Content-Type: application/json' \
    -d '{"name":"hello-world"}' http://localhost:4000/user/repos` and the same against
   `/repos/admin/hello-world/issues` for an issue. Without seeding every list is empty and proves
   nothing.

### Signing in with NO browser (when computer-use/GUI is unavailable)

The emulator's authorize page is a plain form per user, so the whole OAuth dance is curl-able and
yields a **real** Better Auth session — no cookie forging, no DB row surgery:

```bash
signin() { U=$1; JAR=$2; rm -f $JAR
  URL=$(curl -s -c $JAR -X POST localhost:3000/api/auth/sign-in/social \
        -H 'Content-Type: application/json' -d '{"provider":"github","callbackURL":"/dashboard"}' \
        | python3 -c "import json,sys;print(json.load(sys.stdin)['url'])")
  curl -s -b $JAR -c $JAR "$URL" > /tmp/az.html          # authorize page: one <form> per user
  ST=$(grep -o 'name="state"[^>]*value="[^"]*"' /tmp/az.html | head -1 | grep -o 'value="[^"]*"' | cut -d'"' -f2)
  RU=$(grep -o 'name="redirect_uri"[^>]*value="[^"]*"' /tmp/az.html | head -1 | grep -o 'value="[^"]*"' | cut -d'"' -f2)
  SC=$(grep -o 'name="scope"[^>]*value="[^"]*"' /tmp/az.html | head -1 | grep -o 'value="[^"]*"' | cut -d'"' -f2)
  LOC=$(curl -s -D - -o /dev/null -b $JAR -c $JAR -X POST localhost:4000/login/oauth/callback \
        --data-urlencode "login=$U" --data-urlencode "state=$ST" --data-urlencode "redirect_uri=$RU" \
        --data-urlencode "scope=$SC" --data-urlencode "client_id=your_github_oauth_app_client_id" \
        | grep -i '^location:' | tail -1 | tr -d '\r' | sed 's/^[Ll]ocation: //')
  curl -s -o /dev/null -b $JAR -c $JAR "$LOC"; }          # MUST be a GET
signin ghost /tmp/ghost.jar; signin admin /tmp/admin.jar
curl -s -b /tmp/ghost.jar localhost:3000/api/auth/get-session   # verify identity
```

Gotcha: `curl -L` re-POSTs the emulator's redirect to `/api/auth/callback/github` and gets **415** —
capture the `Location` and GET it. Verify identities via `/api/auth/get-session` before trusting a
jar; two jars in parallel give you owner + outsider without incognito windows.

### If the whole GUI dies mid-session

Symptom: `~/.vnc/*.log` ends with `The X11 connection broke: I/O error` / `XIO: fatal IO error`, and
every `computer` call says "Computer-use engine is not yet initialized". You can restore X yourself:

```bash
vncserver :0 -rfbport 5901 -geometry 1600x1122 -depth 24 \
  -SecurityTypes VncAuth -passwd /opt/.devin/package/vnc_client/passwd
DISPLAY=:0 setsid nohup startplasma-x11 >/tmp/plasma.log 2>&1 &
```

(the display must be `:0` on rfbport **5901** — the platform's original layout). That brings back
`xdotool`/`wmctrl`/Chrome, but it does **not** revive the computer-use engine, which is platform-side:
expect to need a box reboot. Plan for a shell-only fallback rather than losing the whole pass.

### What works vs. breaks against the emulator

- Works: sign-in/sign-out, `/issues`, `/pulls`, `/search` (Repos/Issues/Users tabs), the navbar user
  menu, `/repos/:o/:r/issues`.
- Works: also `/dashboard` (since `next.config.ts` derives an `images.remotePatterns` entry from
  `GITHUB_EMULATOR_URL`). That config is read **at server start**, so the var must be exported/present
  in `.env` before `bun dev` — a server started first will still show
  `Invalid src prop (http://localhost:4000/avatars/...)` and the app's error boundary. If you see that
  error, restart the dev server rather than assuming a code bug.
- Cosmetic: the emulator has no avatar bytes — `GET /avatars/u/<login>` returns 404 JSON, so avatars
  render blank and the dev log shows `upstream image response failed ... 404`. Harmless.
- **The emulator DOES implement `GET /repos/{owner}/{repo}`** (returns 200 for a seeded repo, 404 for
  an unknown one) and `POST /user/repos` (`{"name":"x","private":true}` seeds a private repo, useful
  for exercising "private" badges). Don't assume it is missing — curl it before deciding a flow is
  untestable. Only GraphQL is absent.
- **HMR silently drops the `fetch` patch.** After editing a server file while `bun dev` runs, GitHub
  traffic can revert to the real github.com: symptoms are `GitHub OAuth token exchange failed:
  { status: 404 }` → `/api/auth/error?error=invalid_code` on sign-in, and `GET /user - 401` /
  "Unauthorized" on authed API routes. Fix: restart the dev server (do not chase it as an app bug).
  Emulator access tokens also die when the emulator restarts — sign out and back in after restarting it.
- Breaks, and why: repo overview pages fail with "Unable to load repository / GraphQL request
  failed: 404" because `lib/github.ts` uses `https://api.github.com/graphql` and the emulator has
  **no** `/graphql` endpoint. `/notifications`, `/users/:u/events` and `/user/starred` are also 404
  on the emulator.
- `next build` sets `NODE_ENV=production`, but `github-emulator.ts` exempts
  `NEXT_PHASE=phase-production-build`, so `SKIP_ENV_VALIDATION=true bun run build` succeeds with
  `GITHUB_EMULATOR_URL` in `.env` (verified). A real production **server** still refuses to start
  unless `ALLOW_GITHUB_EMULATOR_IN_PRODUCTION=1`.
- Only one `next dev` may hold `.next/lock`, and a build conflicts with a running dev server: kill
  dev (`pkill -f "next dev"`, wait ~5s) before building, and note `bun dev` backgrounded via `&`
  inside a subshell may not survive — use `nohup bun dev > /tmp/dev.log 2>&1 &`.
- No `psql` on the box; query Postgres with
  `docker exec $(docker ps --format '{{.Names}}' | grep -i postgres | head -1) psql -U postgres -d better_hub -c '...'`.

## Proving a repo-scoped GitHub call did NOT happen (hidden hosted repos)

For the `hostedButHidden`/`upstreamOctokit` family of gates, the only real evidence is the emulator
proxy's request log, and a "zero requests" result is worthless without a positive control.

- Instrument `~/emu-proxy.mjs` with `console.log(\`REQ ${req.method} ${req.url}\`)` plus the GraphQL
  `variables` (never headers), redirect to a log file, truncate it before each case. Remember to
  revert this patch during cleanup.
- Seed the adversarial pair: a **private hosted** Postgres repo `admin/<name>` with real Code Storage
  content, **and** a same-named emulator repo carrying obvious markers
  (`description`, plus `POST /repos/admin/<name>/releases` with a marker `name`). Verify the decoy is
  genuinely readable via curl first — otherwise "nothing leaked" proves nothing.
- **Empty `github_cache_entries` before every case** (`delete from github_cache_entries;`). A cached
  row makes the code skip the upstream call and fakes a pass. Next's own fetch cache also hides
  requests, so a name already fetched in this server lifetime cannot be reused for a control — use a
  **fresh repo name** for the private→public differential.
- Control that makes the zero meaningful: same outsider, same URL, `isPrivate=true` → expect **zero**
  `/repos/admin/<name>…`; flip `isPrivate=false` → expect the call to appear *and* the decoy marker to
  render. If the public case is also zero, your test is dead and proves nothing.
- Which routes enter which seam (as of cc2f923): overview = `repos/[owner]/[repo]/page.tsx` +
  `layout.tsx` → `getRepoPageData` → `hostedPageDataResult`; releases = `releases/page.tsx` →
  `getRepoReleases` (its "empty ⇒ try fresh" fallback is the historically ungated one), also reached
  from `tags/page.tsx` and `releases/[tag]/page.tsx`; `releases/actions.ts` uses the already-gated
  `getRepoReleasesPage`.
- Also assert the **background revalidation** path: load the hidden page twice, wait ~30 s, then check
  both the log and `select count(*) from github_cache_entries where "cacheKey" like '%<name>%'` — a
  gate that only covers the request path can still refill GitHub-derived caches later.
- A *visible* hosted repo makes **no** GraphQL call (it is served from Postgres/Code Storage), so the
  positive control for the GraphQL seam must be a **non-hosted** repo, not a public hosted one.

## Stubbing API responses in the browser

- Playwright `connect_over_cdp("http://localhost:29229")` **works for reading state** (e.g.
  `page.evaluate`, and `context.grant_permissions(["clipboard-read"])` +
  `navigator.clipboard.readText()` is the reliable way to assert copy-button behavior — there is no
  `xclip`/`xsel` on the box).
- But `page.route`/`context.route` interception does **not** take effect against the shared Chrome
  used by computer-use (another CDP client owns the Fetch domain). Worse, killing the script mid-run
  can leave requests hanging forever. If you need a stubbed API response, prefer a **temporary
  server-side switch**: patch the route handler to read a mode from a file (e.g. `/tmp/x-stub.txt`)
  and return canned payloads, flip the file between cases with no restart, then restore the original
  file from a backup copy when done.

## Known pre-existing DB drift (not caused by whatever you are testing)

`prisma migrate status` reports "up to date" yet several schema.prisma fields/models have no
migration, so authed pages log 500s: `userSettings.colorMode` (P2022, `PATCH /api/user-settings`)
and table `user_theme_store_installs` (P2021, `GET /api/theme-store/installed`). Expect these in the
log and do not attribute them to the branch under test. `user.githubLogin` had the same problem
until the `20260809210000_add_user_github_login` migration.

## The `lib/git` provider seam (`apps/web/src/lib/git/`)

- Nothing in the app imports it yet; to confirm inertness grep the built output:
  `grep -rl "PIERRE_STORAGE\|code-storage\|getGitProvider" apps/web/.next/server` should return nothing.
- `getGitProvider()` constructs `CodeStorageProvider` eagerly, and its constructor calls
  `readCodeStorageConfig()`, so **`getGitProvider()` itself throws `GitError: PIERRE_STORAGE_NAME is
  not set` when the env vars are absent** — it is not lazy. Any future consumer must either set
  `PIERRE_STORAGE_NAME`/`PIERRE_STORAGE_KEY` or call it inside a try/catch.
- `src/lib/git/contract.test.ts` is a live suite gated on `PIERRE_STORAGE_NAME` + `PIERRE_STORAGE_KEY`;
  without them it reports as skipped (18 skipped), which is the correct non-vacuous behavior.
- When testing "unset env" behavior, note that `PIERRE_STORAGE_KEY` may already be present in the
  Devin shell environment as a session secret — use `env -u PIERRE_STORAGE_KEY -u PIERRE_STORAGE_NAME`
  to genuinely simulate the default deployment.

## Devin Secrets Needed

- None for build/boot testing.
- `PIERRE_STORAGE_KEY` + `PIERRE_STORAGE_NAME` (session-scoped) only for the live Code Storage
  contract suite.
- Real `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are **not** needed to reach authenticated UI if
  the GitHub emulator path above is available; the placeholder values in `.env` work fine with it.
  They are only needed to exercise real GitHub data (e.g. GraphQL-backed repo pages).

## Testing hosted (Code Storage-backed) repositories locally

Repos with a row in the Postgres `repositories` table are served from the git backend instead of
GitHub for code reads (contents/tree/branches/tags/file/commits). To exercise this locally:

1. Create a real repo through the provider (`new CodeStorageProvider()` with `PIERRE_STORAGE_NAME`
   + `PIERRE_STORAGE_KEY` in the env) — `createRepo`, then `commitFiles` for content, `createBranch`
   and `createTag`. **`createTag` needs a 40-char commit SHA**, not a branch name: read it from
   `listBranches` first.
2. Insert a `repositories` row (`owner`, `name`, `defaultBranch`, `gitBackend: "code-storage"`,
   `gitRepoId`, `ownerUserId` = your signed-in user id). Note reads resolve the repo by
   `row.owner`/`row.name`, not by `gitRepoId`, so the row casing must match the Code Storage repo
   or every page throws `repository not found`.
3. Two local blockers you will hit, both environment-only:
   - emulate.dev reports `size: 0` for every repo and the app treats `size === 0` as "This
     repository is empty", hiding all code/commits. Workaround: run the emulator on another port and
     put a tiny node proxy on the port in `GITHUB_EMULATOR_URL` that rewrites `size` on
     `GET /repos/{o}/{r}` (also rewrite the upstream port inside JSON bodies, otherwise emulator
     `avatar_url`s point at the hidden port and `next/image` throws `Invalid src prop`).
   - repo layout metadata comes from GraphQL, which emulate.dev lacks. Seed the Redis keys
     `repo_page_data:<userId>:<owner>/<repo>` and `gh:<userId>:repo:<owner>/<repo>` to render pages.
   - after changing either, delete the stale `*<repo>*` Redis keys (`docker exec better-hub-redis
     redis-cli --scan --pattern '*<repo>*' | xargs ... del`) or you will keep seeing old data.
4. Best proof that bytes come from Code Storage and not GitHub: load a hosted page, delete the
   Postgres row, reload the same URL — the listing must collapse to the GitHub-backed view — then
   re-insert the row and confirm the content returns.

### Hosted repo *overview/metadata* surfaces (Postgres-backed)

Once repo overviews are served from Postgres (`repositories.description/homepage/topics/isPrivate/
archived/sizeKb` + `forkOfId` + `ownerUserId`), the Redis `repo_page_data:*` / `gh:*:repo:*`
fixtures above are no longer needed — and deleting them is the best adversarial check that the
overview really comes from Postgres + the git backend rather than a stale cache.

Things that will otherwise waste your time:
- **`/repos` can be masked by a stale GitHub-list cache.** `getUserRepos` is cached in Redis under
  `gh:<userId>:user_repos:updated:<n>`. Postgres-only rows are merged in only when they are *not*
  in that list, so a stale cached list makes a hosted repo show GitHub's old description (or the
  repo appear twice / not at all). Delete `*user_repos*` keys before asserting on `/repos`.
- **Repo URLs "stick" to the last visited tab.** Typing `/repos/<owner>/<repo>` often lands on
  `/code` (and typing `/repos` once may re-land on the repo). Click the `Overview` tab in the nav,
  or re-enter the URL, and verify the address bar before asserting.
- **Maintainer vs read-only overview:** the overview dashboard panels are gated on
  `permissions.push|admin|maintain`. To test a read-only viewer without a second account, set the
  row's `ownerUserId = NULL` (no collaborator/org-member rows) and reload; the `Preview public view`
  button on the overview shows the same non-maintainer content for the owner. Restore the column
  afterwards.
- **Not every repo surface is hosted-aware — audit the log per page.** The short-circuit lives in
  `lib/github.ts`/`hosted-source.ts`, but sibling server actions can bypass it. Two that did (both
  fixed in `c2cb806`, so treat them as a *pattern* to re-check rather than known-broken): the
  overview README via `revalidateReadme` (`repos/[owner]/[repo]/readme-actions.ts`) and the
  `RepoRevalidator` action via `fetchAndCacheRepoPageData` (`revalidate-actions.ts`). Symptoms: a
  hosted repo renders its code-tab README but shows none on the overview (and a non-maintainer sees
  a *completely blank* overview), plus `[fetchAndCacheRepoPageData] Failed for <repo>` in the log.
  Useful greps after a page load: `api\.github\.com/repos/<owner>/<repo>/readme`,
  `fetchAndCacheRepoPageData\] Failed`, `api\.github\.com/graphql`. Note that a couple of GraphQL
  POSTs may still appear for hosted repos from surfaces that are legitimately still GitHub-backed
  (PR/issue stat enrichment, notifications), so attribute them before calling it a regression.
- **Upstream metadata copied onto the row** (`repositories.stars/watchers/openIssues/language/
  licenseName/licenseSpdx/languagesJson/metadataSyncedAt`, `lib/repos/upstream-metadata.ts`): nothing
  in that path runs unless the row has `upstreamHost='github.com'` + `upstreamOwner`/`upstreamName`,
  so set them before concluding a sync/star/starred path is broken. Useful fixtures: point
  `upstreamOwner/Name` at a repo the emulator does **not** have (every GitHub call 404s → proves the
  stored copy survives an outage and `viewerHasStarred` degrades to false), then at a seeded emulator
  repo created with a distinctive description (`POST /user/repos` with `{"name":..,"description":..}`)
  → proves the background `waitUntil` sync really writes (`description`/`homepage`/`sizeKb` change and
  `metadataSyncedAt` becomes non-NULL). Set `metadataSyncedAt=NULL` to force a refresh; the TTL is 1h.
  Note a successful sync legitimately **overwrites** hand-seeded values with the upstream's, so run
  the "stored values render" checks before the sync-success check.
- The sidebar **Languages bar** is fed by the Redis `repo_languages` key + the client action
  `revalidateLanguages` (`readme-actions.ts`), neither of which is hosted-aware — so a hosted repo
  can have `languagesJson` populated and still show a skeleton that then disappears. Check the
  sidebar *after* hydration, not just the server HTML.
- The overview README card only renders in the **public** view (`Preview public view` button, or any
  non-maintainer viewer); the maintainer overview is a dashboard of panels. Don't conclude the README
  is missing from the maintainer view without checking the public view first.
- **`size` semantics:** `hostedRepoData` uses `record.sizeKb || (head ? 1 : 0)`, so a repo with
  commits shows `1 KB` and never the "This repository is empty" state, while a Code Storage repo
  with *zero commits* does. Seed both (a populated repo and a `createRepo`-only one) to cover it.

## Testing hosted pull requests (PRs owned in Postgres, `lib/pulls/*`)

- New migrations land in `apps/web/prisma/migrations`; run `bun x prisma migrate deploy` **and**
  `bun x prisma generate` in `apps/web` before starting the dev server, otherwise the new
  tables/columns (`pull_requests`, `repositories.nextNumber`, …) are missing and every hosted PR read
  fails in a way that looks like a product bug.
- **Fixture prep matters more than the assertions.** `admin/hosted-lab`'s `main` and
  `codestorage-branch` have identical tips, so a compare between them shows `0 files` whether the
  plumbing works or not. Create a discriminating branch first with the provider directly, e.g. a
  throwaway script in `apps/web` run as
  `env PIERRE_STORAGE_NAME=orchid PIERRE_STORAGE_KEY=... bun run seed-pr-branch.ts`:
  `import { getGitProvider } from "./src/lib/git/index"` (note: `index`, **not** `provider` — the
  factory is only exported from `git/index.ts`), then `git.createBranch(ref, name, "main")` and
  `git.commitFiles(ref, { branch, message, author, files: [{ path, content }] })`
  (the input field is `files` with `content`, there is no `changes`/`action` shape). Record the
  provider's own `git.compare(...)` `stats` and `git.previewMerge(...)` `status` — those exact numbers
  are what the UI must show, which makes wrong plumbing show wrong digits instead of a plausible page.
  Clean up afterwards with `git.deleteBranch(ref, name)`.
- Discriminating signals for "hosted PRs come from Postgres": the emulator has no `/graphql` and no
  such repo, so a GitHub fallthrough renders `Unable to load repository — GraphQL request failed: 404`
  rather than degrading quietly. Also check the repo nav `PRs` badge (previously hardcoded `0`, now
  `hostedOpenPullCount`) *together with* the list — a broken count shows `0` while the list still
  shows the PR.
- The PR detail route is `/{owner}/{repo}/pull/{n}` (singular, no `/repos` prefix) even though the
  list links from `/repos/{owner}/{repo}/pulls`; the create form is
  `/repos/{owner}/{repo}/pulls/new` and accepts `?base=&head=&title=` query params, which is the only
  way to drive adversarial cases the pickers won't let you build (nonexistent branch, prefilled title).
- Server-side create guards live in `lib/pulls/create.ts` and are partly unreachable from the UI: the
  client disables the form when `head === base` (`Choose different branches to compare`) and won't
  submit when the compare fails, so `The head and base branches are the same` /
  `Branch X does not exist` may never render. Report them as client-guarded rather than as passes.
  A nonexistent branch surfaces the provider's generic `requested resource not found` inline.
- Permission refusals are best exercised by `update repositories set "ownerUserId"=NULL where …` then
  clearing the hosted Redis keys; expect the inline `You do not have write access to this repository`
  and verify no row was created and `nextNumber` was not burned. Restore `ownerUserId` afterwards.
- Even with hosted PR reads intercepted, the **detail page still calls GitHub in-band** for surfaces
  this seam doesn't cover: `isBranchBehindBase` (`/compare/...`), `getAuthorDossier` (one GraphQL
  POST), `/api/check-status` (`commits/{sha}/status` + `check-runs`) and the issue timeline. They all
  404 harmlessly against the emulator, so grep the dev log per page load and attribute each call
  before calling it a regression.
- Viewing a hosted PR fires `void inngest.send(...)` from the detail page; without an Inngest event
  key this logs `Error: Inngest API Error: 401 Event key not found` and an `unhandledRejection` in the
  dev log. Local-env noise, not a hosted-PR defect — but expect it and don't count it as a clean log.
- Cleanup after a PR run: `delete from pull_requests where "repositoryId" = …` (cascades to
  events/reviews/comments), `update repositories set "nextNumber"=1 …`, restore `ownerUserId`, delete
  the temporary Code Storage branch, and delete the throwaway `*.ts` scripts from `apps/web`.

### Devin Secrets Needed
- `PIERRE_STORAGE_KEY` (with `PIERRE_STORAGE_NAME=orchid`) in the dev-server env for any hosted read
  or provider script.

## Hosted repo permissions, archiving and settings (PR #10 / #8)

### The single read gate
`hostedRepo(owner, name)` in `apps/web/src/lib/repos/hosted-source.ts` returns **null** when
`record.isPrivate && !repositoryPermission(record, viewerId())`. Every hosted read resolves through
it, so testing private isolation means hitting many surfaces but reasoning about one gate.

Denied hosted pages render `Unable to load repository` / `GraphQL request failed: 404` (the
non-hosted fallback failing), **not** a bespoke "private" page. Do not read that as a crash.

**Always grep the delivered HTML, not just the screenshot.** A page can look empty while shipping
data in the RSC flight payload. The `computer` tool saves each load to `/tmp/page_html_*.html`;
grep it for file names, file contents, branch names, tag names, PR titles and commit subjects.

### Two-window setup for permission testing
Use a normal window signed in as the owner and an **incognito** window signed in as a second user.
Caveats that will waste time otherwise:
- The tool's returned HTML/DOM sometimes belongs to the *other* window. Trust the screenshot and the
  `/tmp/page_html_*.html` whose URL matches; re-take a screenshot if they disagree.
- `browser_console` / `read_dom` attach to only one target, so DOM queries may silently return empty
  for the window you are looking at. Prefer visual checks plus HTML greps.
- Signed-out checks are fine with plain `curl` (no session involved).

### Granting/revoking collaborators
There is no collaborator UI; use `grantCollaborator(repositoryId, userId, permission)` from
`lib/repos/registry` in a throwaway script, and `prisma.repositoryCollaborator.deleteMany` to revoke.
Test the **flip back** — revoking must deny again — otherwise you have not proven the gate keys on
the grant rather than on a cache.

### Archived writes
`writeRefusal()` checks `archived` **before** permission, so the owner/admin must also be refused
with exactly `This repository is archived`. Drive it as the owner, or the test proves nothing.
The seven paths worth covering: `createHostedPull`, `mergeHostedPull`, `updateHostedPullBranch`,
`setHostedPullState` (closed *and* open), `resolveHostedConflicts`, `commitHostedResolution`.
In the UI, `Update branch` is merely *disabled* when archived — check the server layer too.
Always finish with unarchive + a real write, or a build that broke all writes would also "pass".

### Known traps in hosted settings
- **Rename breaks a hosted repo.** `providerRef(record)` falls back to `{owner, name}` when
  `gitRepoId` contains no `/` (Code Storage ids are opaque, e.g. `HMZ2NNp13deleRLM4qIWG`). After a
  rename every git call targets a repo the backend does not have → `repository not found` on every
  page. Restore with `update repositories set name='<old>'`. Verify with a probe comparing
  `git.listBranches(providerRef(rec))` against `git.listBranches({owner, repo: oldName})`.
- The rename redirect goes to `/repos/<owner>/<new>/settings`, not the canonical `/<owner>/<new>`.
- **A soft reload (F5) can serve a stale settings page** — the value shown may lag one save behind
  the database. Always confirm with `ctrl+shift+r` before calling a save broken.
- Saves can sit on `Saving…` far longer than the request takes; check the DB and the dev log
  (`POST /<owner>/<repo>/settings 200`) before concluding it hung.
- Visibility changes need a **second** click on Save (an inline confirm step).

### Verifying "no GitHub call for a hosted repo"
Tail the emulator and proxy logs and `grep -c "repos/<owner>/<repo>"` after a settings load+save;
it must be 0. `api.github.com/user` and `/notifications` still appear — those are not repo calls.

### The non-hosted settings path cannot be tested on the emulator
Since #8, `getRepo()` for a non-hosted repo goes through `readLocalFirstGitData` → **GraphQL**, and
the GitHub emulator has no `/graphql` endpoint (returns 404 for any query). Seeding a repo via
`POST /user/repos` is not enough; the settings page still shows `Unable to load repository`.
Treat the non-hosted regression as untested locally unless a real GitHub token is available.

### Server actions that need a request scope
`readme-actions.ts` (`revalidateBranches`, `revalidateTags`, `fetchReadmeMarkdown`,
`revalidateLanguages`) call `headers()`, so they throw
`` `headers` was called outside a request scope `` when invoked from a script. They are only
reachable through the browser, and a denied viewer never gets them shipped. Note the residual risk:
these actions **fall through to octokit** when `hostedRepo` returns null, so a same-named public
GitHub repo could be served in place of a private hosted one.
