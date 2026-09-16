import type { ChildProfile, FoodEvent, Prescription, Allergen, Day } from "../engine/types.js";
import { formatDay, parseDay } from "../engine/daymath.js";

/** Local-first. The device copy is the source of truth for rendering; the
 *  server is a merge point, not an authority. Everything works offline. */

const KEY = "allergen-planner/v1";

export interface Store {
  familyKey: string;
  children: ChildProfile[];
  events: FoodEvent[];
  prescriptions: Prescription[];
  activeChildId: string | null;
  lastSync: number;
  /** ids already accepted by the server, so we only push what is new. */
  pushed: string[];
}

const empty = (): Store => ({
  familyKey: "", children: [], events: [], prescriptions: [],
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
  updated_at: Date.now(),
});

export const rowToChild = (r: any): ChildProfile => ({
  id: r.id, name: r.name, birthDate: parseDay(r.birth_date),
  riskTier: r.risk_tier, jurisdiction: r.jurisdiction,
  readinessConfirmedOn: r.readiness_confirmed_on ? parseDay(r.readiness_confirmed_on) : null,
  clinicianCleared: JSON.parse(r.clinician_cleared ?? "[]") as Allergen[],
  excluded: JSON.parse(r.excluded ?? "[]") as Allergen[],
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

export const rxToRow = (p: Prescription) => ({
  id: p.id, child_id: p.childId, allergen: p.allergen, entered_on: formatDay(p.enteredOn),
  attribution: p.attribution, steps_json: JSON.stringify(p.steps),
  supersedes: p.supersedes, created_at: Date.now(),
});

export const rowToRx = (r: any): Prescription => ({
  id: r.id, childId: r.child_id, allergen: r.allergen, enteredOn: parseDay(r.entered_on),
  attribution: r.attribution, steps: JSON.parse(r.steps_json),
  supersedes: r.supersedes ?? null,
});

export const newDay = (d: Day) => d;
