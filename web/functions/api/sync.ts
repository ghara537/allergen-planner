/// <reference types="@cloudflare/workers-types" />
interface Env { DB: D1Database }

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

interface Payload {
  family: string;
  children?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  dosePlans?: Array<Record<string, unknown>>;
  dayOverrides?: Array<Record<string, unknown>>;
}

/** POST /api/sync
 *  Events and prescriptions are append-only and immutable, so pushing them is
 *  INSERT OR IGNORE keyed on id - idempotent, order-independent, and safe to
 *  retry. Child profiles are mutable, so they are last-writer-wins on
 *  updated_at. There is nothing here that two phones can clobber. */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: Payload;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!body.family) return json({ error: "family required" }, 400);
  const fam = body.family;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  for (const c of body.children ?? []) {
    stmts.push(env.DB.prepare(
      `INSERT INTO children (id, family_id, name, birth_date, risk_tier, jurisdiction,
         readiness_confirmed_on, clinician_cleared, excluded, settings, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, birth_date=excluded.birth_date, risk_tier=excluded.risk_tier,
         jurisdiction=excluded.jurisdiction, readiness_confirmed_on=excluded.readiness_confirmed_on,
         clinician_cleared=excluded.clinician_cleared, excluded=excluded.excluded,
         settings=excluded.settings, updated_at=excluded.updated_at
       WHERE excluded.updated_at > children.updated_at`
    ).bind(c.id, fam, c.name, c.birth_date, c.risk_tier, c.jurisdiction,
           c.readiness_confirmed_on ?? null, c.clinician_cleared ?? "[]",
           c.excluded ?? "[]", c.settings ?? "{}", Number(c.updated_at ?? now)));
  }

  for (const e of body.events ?? []) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO events
         (id, family_id, child_id, allergen, day, kind, dose_json, supersedes, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    ).bind(e.id, fam, e.child_id, e.allergen, e.day, e.kind,
           e.dose_json ?? null, e.supersedes ?? null, Number(e.created_at ?? now)));
  }

  for (const p of body.dosePlans ?? []) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO dose_plans
         (id, family_id, child_id, allergen, effective_from, start_amount, unit,
          increment, increment_mode, every_days, reactive, source, supersedes, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`
    ).bind(p.id, fam, p.child_id, p.allergen, p.effective_from, p.start_amount,
           p.unit ?? "", p.increment ?? 0, p.increment_mode ?? "add", p.every_days ?? 7,
           p.reactive ?? 0, p.source ?? "", p.supersedes ?? null, Number(p.created_at ?? now)));
  }

  for (const o of body.dayOverrides ?? []) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO day_overrides
         (id, family_id, child_id, day, naps_json, supersedes, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    ).bind(o.id, fam, o.child_id, o.day, o.naps_json,
           o.supersedes ?? null, Number(o.created_at ?? now)));
  }

  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, applied: stmts.length, now });
};
