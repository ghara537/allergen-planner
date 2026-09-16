# Allergen Planner

Local-first PWA. The scheduling engine is a pure module; the UI is a thin
renderer over it. Nothing derived is ever stored — the plan is always
recomputed from profile + prescriptions + event history.

**This app ships no recommended doses.** Amounts appear only when a parent has
entered a clinician's plan and confirmed every step. `draftLadder` returns
steps with `confirmed: false`, and the planner refuses to schedule them.

## Run it locally

    npm install
    npm test          # 43 assertions, mirrors the Swift reference impl
    npm run dev

## Deploy to Cloudflare (free tier)

1. `npx wrangler login`

2. Create the database and paste the printed id into `wrangler.toml`:

       npx wrangler d1 create allergen-planner

3. Create the tables, locally and remotely:

       npm run db:local
       npm run db:remote

4. Create the Pages project once, then deploy:

       npx wrangler pages project create allergen-planner --production-branch main
       npm run deploy

5. In the Cloudflare dashboard, bind the database to the Pages project:
   **Workers & Pages → allergen-planner → Settings → Bindings → D1**,
   variable name `DB`, database `allergen-planner`. Redeploy after binding.

You get `https://allergen-planner.pages.dev`. Open it on a phone, Share →
Add to Home Screen. It launches full-screen with its own icon and works offline.

## Sharing between parents

There are no accounts. The family key is the identity. Set it in Setup, or
open the app with `?family=your-key` and it is remembered.

Anyone with the URL and key can read and write, so choose something not
guessable. Events are append-only and immutable, so two phones syncing is a
merge, never a conflict — retries are safe and order does not matter.

## Layout

    src/engine/     types, daymath, planner, tests    <- the pure module
    src/store/      local.ts (device copy), sync.ts   <- local-first
    src/ui/app.ts   rendering and interaction
    functions/api/  state.ts (pull), sync.ts (push)   <- Pages Functions
    schema.sql      D1 tables
    ../Engine/      Swift reference implementation

Both implementations assert the same behaviour. If they ever disagree, one has
a bug.

## Known gaps

- Backfill and the per-food sheet use `prompt()`. Works, ugly. Real sheets next.
- Local storage is `localStorage`, fine for thousands of events; move to
  IndexedDB before it gets big.
- Nap blocks and the day timeline are not built. Deliberate — tap-to-edit
  first, drag only if still wanted after real use.
- No reaction triage content. That screen needs a clinician to write it.
