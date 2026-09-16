# Allergen Planner

Local-first PWA. The scheduling engine is a pure module; the UI is a thin
renderer over it. Nothing derived is ever stored — the plan is always
recomputed from profile + prescriptions + event history.

**This app never suggests an amount.** A food carries a dose only when you have
created a DosePlan for it; otherwise it is scheduled by name alone, which is
the default. There is no code path that invents a quantity.

A DosePlan is a rule, not a table: start amount, increment, add-or-multiply,
every N days. The amount on any date is derived. Steps advance on elapsed days
**and** at least one logged exposure since the last step, so forgetting for a
fortnight holds the amount rather than silently jumping two rungs.

Editing never rewrites a rule. It writes a new one effective today that
supersedes the old, so the edit screen can pre-fill with where you actually
are now, and history still explains itself. Asking about a past date returns
the rule that was in force then.

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
    ../Engine/      Swift original - FROZEN, see below

The Swift version was the first implementation and the fixtures proved the
port. It is now frozen: the model has moved on (dose plans, per-child pacing,
day-based settling) and maintaining two copies of a changing spec is pure
cost. Keep it for reference or delete it.

## Known gaps

- Backfill still uses `prompt()`. The per-food editor is a real screen now.
- Local storage is `localStorage`, fine for thousands of events; move to
  IndexedDB before it gets big.
- Nap blocks and the day timeline are not built. Deliberate — tap-to-edit
  first, drag only if still wanted after real use.
- No reaction triage content. That screen needs a clinician to write it.

## Migrating an existing database

The schema changed: `prescriptions` became `dose_plans`, and `children` gained
a `settings` column. `schema.sql` creates the new table on its own, but the
column has to be added:

    npx wrangler d1 execute allergen-planner --remote \
      --command "ALTER TABLE children ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'"
    npm run db:remote

Repeat with `--local` for the emulated database. If you have no real data yet,
dropping `children` and `prescriptions` and re-running `schema.sql` is fine too.
