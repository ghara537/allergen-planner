// Same assertions as the Swift reference implementation (Engine/main.swift).
// If these two ever disagree, one of them has a bug.
import { addDays, daysBetween, day as D } from "./daymath.js";
import { draftLadder, plan, label } from "./planner.js";
import { DEFAULT_CONFIG, type Allergen, type ChildProfile, type Dose,
         type FoodEvent, type Prescription, type RiskTier, type Day,
         ALLERGENS_BY_JURISDICTION } from "./types.js";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

const KID = "kid-1";
const born = D(2026, 1, 14);      // 8 months old on 2026-09-14
const today = D(2026, 9, 14);
let seq = 0;

const profile = (o: Partial<ChildProfile> = {}): ChildProfile => ({
  id: KID, name: "Baby", birthDate: born, riskTier: "standard" as RiskTier,
  jurisdiction: "us", readinessConfirmedOn: D(2026, 7, 1),
  clinicianCleared: [], excluded: [], ...o,
});
const ev = (a: Allergen, d: Day, kind: FoodEvent["kind"] = "exposure",
            dose: Dose | null = null, supersedes: string | null = null): FoodEvent =>
  ({ id: `e${seq++}`, childId: KID, allergen: a, day: d, kind, dose, supersedes });
const one = (p: ChildProfile, h: FoodEvent[], s: Prescription[] = [], on: Day = today) =>
  plan({ profile: p, history: h, prescriptions: s, from: on, through: on })[0]!;

console.log("\n== DayMath ==");
check("leap day", JSON.stringify(addDays(1, D(2028, 2, 28))) === JSON.stringify(D(2028, 2, 29)));
check("non-leap rolls", JSON.stringify(addDays(1, D(2026, 2, 28))) === JSON.stringify(D(2026, 3, 1)));
check("year boundary", JSON.stringify(addDays(1, D(2026, 12, 31))) === JSON.stringify(D(2027, 1, 1)));
check("span across months", daysBetween(D(2026, 1, 14), D(2026, 9, 14)) === 243);
check("negative span", daysBetween(D(2026, 9, 14), D(2026, 9, 1)) === -13);
check("age 8mo ~243d", daysBetween(born, today) === 243);

console.log("\n== Gates ==");
check("too young", one(profile({ birthDate: D(2026, 8, 1), readinessConfirmedOn: D(2026, 8, 2) }), []).blocked === "tooYoung");
check("readiness unconfirmed blocks", one(profile({ readinessConfirmedOn: null }), []).blocked === "readinessNotConfirmed");
check("readiness in future blocks", one(profile({ readinessConfirmedOn: D(2026, 10, 1) }), []).blocked === "readinessNotConfirmed");
check("high risk: no home schedule", one(profile({ riskTier: "severeEczemaOrEggAllergy" }), []).introduce === null);
check("high risk: note tells you why",
  one(profile({ riskTier: "severeEczemaOrEggAllergy" }), []).notes.some((n) => n.includes("allergist")));
check("high risk + per-allergen clearance unblocks that food",
  one(profile({ riskTier: "severeEczemaOrEggAllergy", clinicianCleared: ["peanut"] }), []).introduce?.allergen === "peanut");

console.log("\n== 8mo, peanut established, egg mid-introduction ==");
const real: FoodEvent[] = [
  ev("peanut", D(2026, 8, 2)), ev("peanut", D(2026, 8, 5)), ev("peanut", D(2026, 8, 9)),
  ev("peanut", D(2026, 8, 12)), ev("peanut", D(2026, 8, 15)),   // 5 -> established
  ev("egg", D(2026, 8, 20)), ev("egg", D(2026, 8, 23)),          // 2 -> in progress
];
const g = one(profile(), real);
check("finishes egg before starting anything new", g.introduce?.allergen === "egg", String(g.introduce?.allergen));
check("egg carries no dose by default", g.introduce?.dose === null);
check("peanut is overdue for maintenance", g.maintenanceDue.some((m) => m.allergen === "peanut"));
check("maintenance carries no dose either", g.maintenanceDue.every((m) => m.dose === null));

console.log("\n== Catch-up invariant ==");
const horizon = plan({ profile: profile(), history: real, from: today, through: D(2027, 3, 1) });
check("horizon actually schedules something", horizon.some((p) => p.introduce !== null));
check("at most one new food per day", horizon.every((p) => (p.introduce?.isNew ? 1 : 0) <= 1));
const gapped = one(profile(), real, [], D(2026, 10, 20));
check("long gap does not stack", gapped.introduce !== null && gapped.maintenanceDue.length >= 1);
check("long gap still one new food", (gapped.introduce?.isNew ? 1 : 0) <= 1);

console.log("\n== Reaction ==");
const reacted = [...real, ev("egg", D(2026, 8, 26), "reaction")];
const r = one(profile(), reacted);
check("reacted food is not scheduled", r.introduce?.allergen !== "egg");
check("other foods still proceed", r.introduce !== null);
check("reaction note present", r.notes.some((n) => n.includes("paused after a reaction")));
check("note says do not retry without advice", r.notes.some((n) => n.includes("without advice from your clinician")));

console.log("\n== Prescriptions (user-entered, confirmed) ==");
const draft = draftLadder({ mgProtein: 1 }, 2, 5, 14);
check("draft has right length", draft.length === 5);
check("draft doubles", JSON.stringify(draft.map((s) => s.dose.mgProtein)) === JSON.stringify([1, 2, 4, 8, 16]));
check("draft is UNCONFIRMED", draft.every((s) => !s.confirmed));

const script = (steps = draft): Prescription => ({
  id: "rx1", childId: KID, allergen: "egg", enteredOn: D(2026, 9, 1),
  attribution: "Dr N, 1 Sep 2026", steps, supersedes: null,
});
check("unconfirmed steps are never scheduled",
  one(profile({ clinicianCleared: ["egg"] }), reacted, [script()]).introduce?.allergen !== "egg");

const confirmed = script(draft.map((s) => ({ ...s, confirmed: true })));
const onPlan = one(profile({ clinicianCleared: ["egg"] }), reacted, [confirmed]);
check("confirmed plan resumes the food", onPlan.introduce?.allergen === "egg");
check("dose comes from the plan", onPlan.introduce?.dose?.mgProtein === 1);
check("dose is attributed", onPlan.introduce?.attribution === "Dr N, 1 Sep 2026");

const afterStep1 = [...reacted, ev("egg", D(2026, 9, 14), "exposure", { mgProtein: 1 })];
check("holdDays respected - no advance before 14 days",
  one(profile({ clinicianCleared: ["egg"] }), afterStep1, [confirmed], D(2026, 9, 20)).introduce?.allergen !== "egg");
check("advances after holdDays",
  one(profile({ clinicianCleared: ["egg"] }), afterStep1, [confirmed], D(2026, 9, 28)).introduce?.dose?.mgProtein === 2);
check("engine never invents a dose",
  one(profile(), real).introduce?.dose === null && one(profile(), []).introduce?.dose === null);

console.log("\n== Superseding ==");
const bad = ev("soy", D(2026, 9, 1), "reaction");
const fix = ev("soy", D(2026, 9, 1), "exposure", null, bad.id);
check("correction supersedes the reaction",
  !one(profile(), [...real, bad, fix]).notes.some((n) => n.includes("Soy is paused")));

console.log("\n== Exclusions and jurisdiction ==");
const ex = plan({ profile: profile({ excluded: ["peanut", "egg", "cowsMilk"] }), history: [],
                  from: today, through: D(2027, 1, 1) });
check("excluded foods never scheduled",
  ex.every((p) => !["peanut", "egg", "cowsMilk"].includes(p.introduce?.allergen ?? "")));
check("US set excludes celery", !ALLERGENS_BY_JURISDICTION.us.includes("celery"));
check("EU set includes celery", ALLERGENS_BY_JURISDICTION.eu.includes("celery"));

console.log("\n== Maintenance outlives introduction ==");
const all: FoodEvent[] = [];
let d = D(2026, 3, 1);
for (const a of ALLERGENS_BY_JURISDICTION.us) {
  for (let i = 0; i < DEFAULT_CONFIG.exposuresToEstablish; i++) { all.push(ev(a, d)); d = addDays(2, d); }
  d = addDays(5, d);
}
const toddler = one(profile(), all, [], D(2029, 9, 14));
check("nothing left to introduce", toddler.introduce === null);
check("maintenance still due", toddler.maintenanceDue.length > 0);
check("maintenance window closes after 5 years", one(profile(), all, [], D(2032, 9, 14)).maintenanceDue.length === 0);

console.log("\n== Determinism ==");
const a1 = one(profile(), real), a2 = one(profile(), real);
check("same inputs, same output",
  a1.introduce?.allergen === a2.introduce?.allergen && JSON.stringify(a1.notes) === JSON.stringify(a2.notes));
check("labels resolve", label("cowsMilk") === "Cow's milk");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
