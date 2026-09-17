import { DEFAULT_SETTINGS, type ChildProfile, type DayOverride, type DosePlan,
         type FoodEvent, type Allergen, type Day } from "../engine/types.js";
import { formatDay, parseDay } from "../engine/daymath.js";

/** Local-first. The device copy is the source of truth for rendering; the
 *  server is a merge point, not an authority. Everything works offline. */

const KEY = "allergen-planner/v1";

export interface Store {
  familyKey: string;
  children: ChildProfile[];
  events: FoodEvent[];
  dosePlans: DosePlan[];
  dayOverrides: DayOverride[];
  activeChildId: string | null;
  lastSync: number;
  /** ids already accepted by the server, so we only push what is new. */
  pushed: string[];
}

const empty = (): Store => ({
  familyKey: "", children: [], events: [], dosePlans: [], dayOverrides: [],
  activeChildId: null, lastSync: 0, pushed: [],
});

export function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    return { ...empty(), ...JSON.parse(raw) as Store };
  } catch { return empty(); }
}

export function save(s: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota: ignore */ }
}

export const uid = (): string =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// --- row <-> object mapping (the wire format D1 stores) -------------------

export const childToRow = (c: ChildProfile) => ({
  id: c.id, name: c.name, birth_date: formatDay(c.birthDate),
  risk_tier: c.riskTier, jurisdiction: c.jurisdiction,
  readiness_confirmed_on: c.readinessConfirmedOn ? formatDay(c.readinessConfirmedOn) : null,
  clinician_cleared: JSON.stringify(c.clinicianCleared),
  excluded: JSON.stringify(c.excluded),
  scheduled: JSON.stringify(c.scheduled ?? []),
  exposure_counts: JSON.stringify(c.exposureCounts ?? {}),
  settings: JSON.stringify(c.settings ?? DEFAULT_SETTINGS),
  updated_at: c.updatedAt ?? 0,
});

export const rowToChild = (r: any): ChildProfile => ({
  id: r.id, name: r.name, birthDate: parseDay(r.birth_date),
  riskTier: r.risk_tier, jurisdiction: r.jurisdiction,
  readinessConfirmedOn: r.readiness_confirmed_on ? parseDay(r.readiness_confirmed_on) : null,
  clinicianCleared: JSON.parse(r.clinician_cleared ?? "[]") as Allergen[],
  excluded: JSON.parse(r.excluded ?? "[]") as Allergen[],
  scheduled: JSON.parse(r.scheduled ?? "[]") as Allergen[],
  exposureCounts: JSON.parse(r.exposure_counts ?? "{}"),
  settings: r.settings ? JSON.parse(r.settings) : { ...DEFAULT_SETTINGS },
  updatedAt: Number(r.updated_at) || 0,
});

export const eventToRow = (e: FoodEvent) => ({
  id: e.id, child_id: e.childId, allergen: e.allergen, day: formatDay(e.day),
  kind: e.kind, dose_json: e.dose ? JSON.stringify(e.dose) : null,
  supersedes: e.supersedes, created_at: Date.now(),
});

export const rowToEvent = (r: any): FoodEvent => ({
  id: r.id, childId: r.child_id, allergen: r.allergen, day: parseDay(r.day),
  kind: r.kind, dose: r.dose_json ? JSON.parse(r.dose_json) : null,
  supersedes: r.supersedes ?? null,
});

export const planToRow = (p: DosePlan) => ({
  id: p.id, child_id: p.childId, allergen: p.allergen,
  effective_from: formatDay(p.effectiveFrom), start_amount: p.startAmount, unit: p.unit,
  increment: p.increment, increment_mode: p.incrementMode, every_days: p.everyDays,
  feed_every_days: p.feedEveryDays,
  reactive: p.reactive ? 1 : 0, source: p.source, supersedes: p.supersedes,
  created_at: Date.now(),
});

export const rowToPlan = (r: any): DosePlan => ({
  id: r.id, childId: r.child_id, allergen: r.allergen,
  effectiveFrom: parseDay(r.effective_from), startAmount: Number(r.start_amount),
  unit: r.unit ?? "", increment: Number(r.increment), incrementMode: r.increment_mode,
  everyDays: Number(r.every_days), feedEveryDays: Number(r.feed_every_days) || 1,
  reactive: !!r.reactive, source: r.source ?? "",
  supersedes: r.supersedes ?? null,
});

export const newDay = (d: Day) => d;

export const overrideToRow = (o: DayOverride) => ({
  id: o.id, child_id: o.childId, day: formatDay(o.day),
  naps_json: JSON.stringify(o.naps), supersedes: o.supersedes, created_at: Date.now(),
});

export const rowToOverride = (r: any): DayOverride => ({
  id: r.id, childId: r.child_id, day: parseDay(r.day),
  naps: JSON.parse(r.naps_json ?? "[]"), supersedes: r.supersedes ?? null,
});
