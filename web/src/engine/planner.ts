import {
  ALLERGENS_BY_JURISDICTION, DEFAULT_CONFIG,
  type Allergen, type AllergenStatus, type ChildProfile, type Config,
  type Day, type DayPlan, type Dose, type FoodEvent, type PrescribedStep,
  type Prescription, type ScheduledItem,
} from "./types.js";
import { addDays, compareDay, daysBetween } from "./daymath.js";

/** DATA-ENTRY CONVENIENCE, NOT A RECOMMENDATION. Expands values the user typed
 *  into an UNCONFIRMED draft for them to check line by line against their
 *  clinician's sheet. Every step comes back confirmed:false, and the planner
 *  refuses to schedule unconfirmed steps - so nothing this produces can reach
 *  a parent as an instruction without a human having ratified it. */
export function draftLadder(
  start: Dose, multiplier: number, steps: number, holdDays: number,
): PrescribedStep[] {
  if (steps <= 0 || multiplier <= 0 || start.mgProtein <= 0) return [];
  return Array.from({ length: steps }, (_, i) => ({
    index: i,
    dose: { mgProtein: start.mgProtein * Math.pow(multiplier, i), unit: start.unit },
    holdDays,
    confirmed: false,
  }));
}

/** `today` is a PARAMETER, never a clock read. That is what lets one function
 *  answer for past, present and future, and makes every result reproducible. */
export function plan(args: {
  profile: ChildProfile;
  history: FoodEvent[];
  prescriptions?: Prescription[];
  from: Day;
  through: Day;
  config?: Config;
}): DayPlan[] {
  const config = args.config ?? DEFAULT_CONFIG;
  const hist = effective(args.history.filter((e) => e.childId === args.profile.id));
  const scripts = effectiveScripts((args.prescriptions ?? []).filter((p) => p.childId === args.profile.id));
  const realHorizon = hist.length ? hist.map((e) => e.day).reduce(maxDay) : null;

  const projected = [...hist];
  const out: DayPlan[] = [];
  let d = args.from;
  let guard = 0;
  while (compareDay(d, args.through) <= 0 && guard++ < 4000) {
    const p = planOne(args.profile, projected, scripts, d, config);
    out.push(p);
    // Past days use real history. Future days assume the plan is followed -
    // otherwise no forward calendar can exist at all.
    if (realHorizon && compareDay(realHorizon, d) < 0 && p.introduce) {
      projected.push({
        id: `proj-${out.length}`, childId: args.profile.id,
        allergen: p.introduce.allergen, day: d, kind: "exposure",
        dose: p.introduce.dose, supersedes: null,
      });
    }
    d = addDays(1, d);
  }
  return out;
}

function maxDay(a: Day, b: Day): Day { return compareDay(a, b) >= 0 ? a : b; }

function planOne(
  profile: ChildProfile, history: FoodEvent[], scripts: Prescription[],
  day: Day, config: Config,
): DayPlan {
  const age = daysBetween(profile.birthDate, day);
  const notes: string[] = [];
  const set = ALLERGENS_BY_JURISDICTION[profile.jurisdiction];
  const blocked = (b: DayPlan["blocked"], note: string): DayPlan => ({
    day, ageInDays: age, introduce: null, maintenanceDue: [], blocked: b, notes: [note],
  });

  // --- Gates --------------------------------------------------------------
  if (age < config.solidsFloorDays) {
    return blocked("tooYoung", "Guidelines advise against starting solids before about four months.");
  }
  if (!profile.readinessConfirmedOn) {
    return blocked("readinessNotConfirmed",
      "Guidelines gate starting solids on developmental readiness - sitting with support, "
      + "steady head control, interest in food. Confirm these before starting.");
  }
  if (compareDay(day, profile.readinessConfirmedOn) < 0) {
    return blocked("readinessNotConfirmed", "Readiness signs were not yet confirmed on this date.");
  }

  const status = statuses(profile, history, scripts, day, config);

  // --- Maintenance [G] ----------------------------------------------------
  // Several at once is fine: these foods are already tolerated, so there is no
  // attribution problem. Only NEW foods are capped.
  const due: Array<[Allergen, number]> = [];
  if (age <= config.maintenanceThroughDays) {
    for (const a of set) {
      if (status[a]?.kind !== "established") continue;
      const last = lastExposure(a, history, day);
      if (!last) continue;
      const gap = daysBetween(last, day);
      if (gap >= config.maintenanceIntervalDays) due.push([a, gap]);
    }
  }
  const maintenanceDue: ScheduledItem[] = due
    .sort((x, y) => y[1] - x[1])
    .map(([a]) => ({ allergen: a, isNew: false, dose: null, attribution: null }));

  // --- Introduction -------------------------------------------------------
  let introduce: ScheduledItem | null = null;

  // A food on a confirmed clinician plan takes precedence: it is the only path
  // by which a food carries a dose, and the only path by which a food resumes
  // after a reaction.
  const onScript = dueOnPrescription(profile, scripts, history, day);
  if (onScript) {
    introduce = {
      allergen: onScript.script.allergen, isNew: false,
      dose: onScript.step.dose, attribution: onScript.script.attribution,
    };
  } else {
    const active = config.priority.find((a) => status[a]?.kind === "inProgress") ?? null;
    if (active && readyForNextExposure(active, history, day)) {
      introduce = { allergen: active, isNew: false, dose: null, attribution: null };
    } else {
      const blockedBySerial = config.serialIntroduction && active !== null;
      const lastStart = lastNewStart(history, day);
      const gapOK = !lastStart || daysBetween(lastStart, day) >= config.minDaysBetweenNewAllergens;
      if (!blockedBySerial && gapOK) {
        const next = config.priority.find((a) =>
          set.includes(a)
          && !profile.excluded.includes(a)
          && status[a]?.kind === "notStarted"
          && !(profile.riskTier === "severeEczemaOrEggAllergy" && !profile.clinicianCleared.includes(a)));
        if (next) introduce = { allergen: next, isNew: true, dose: null, attribution: null };
      }
    }
  }

  // --- Catch-up invariant -------------------------------------------------
  // Falling behind EXTENDS the plan; it never compresses it. There is exactly
  // one assignment site for a NEW food and it assigns one value.
  if (config.maxNewAllergensPerDay !== 1) throw new Error("invariant: one new food per day");

  // --- Notes --------------------------------------------------------------
  if (profile.riskTier === "severeEczemaOrEggAllergy") {
    const ungated = set.filter((a) =>
      !profile.excluded.includes(a) && !profile.clinicianCleared.includes(a)
      && status[a]?.kind === "notStarted");
    if (ungated.length) {
      notes.push("Guidelines for infants with severe eczema or existing egg allergy contemplate "
        + "specialist evaluation before introduction at home. Talk to your pediatrician or allergist first.");
    }
  }
  for (const a of set) {
    const s = status[a];
    if (s?.kind === "pausedAfterReaction") {
      notes.push(`${label(a)} is paused after a reaction. Other foods continue as normal. `
        + "Do not retry it without advice from your clinician.");
    }
    if (s?.kind === "onPrescribedPlan" && s.holding) {
      notes.push(`${label(a)} is holding at its current step. A missed dose means the plan does not `
        + "advance on its own - check with your clinician before resuming.");
    }
  }
  const remaining = set.filter((a) => !profile.excluded.includes(a) && status[a]?.kind === "notStarted");
  if (age < config.allergensInDietByDays && remaining.length) {
    const daysLeft = config.allergensInDietByDays - age;
    if (remaining.length * config.minDaysBetweenNewAllergens > daysLeft) {
      notes.push(`${remaining.length} foods left and ${daysLeft} days to twelve months. Guidelines `
        + "require only one new food per meal, so these can be spaced more closely. "
        + "Worth raising with your pediatrician.");
    }
  }
  if (introduce?.isNew && config.preferMorning) {
    notes.push(`Serve earlier in the day and watch for about ${Math.round(config.observationWindowMinutes / 60)} hours.`);
  }

  return { day, ageInDays: age, introduce, maintenanceDue, blocked: null, notes };
}

// --- derivation -----------------------------------------------------------

export function effective(h: FoodEvent[]): FoodEvent[] {
  const superseded = new Set(h.map((e) => e.supersedes).filter(Boolean) as string[]);
  return h.filter((e) => !superseded.has(e.id));
}
export function effectiveScripts(p: Prescription[]): Prescription[] {
  const superseded = new Set(p.map((x) => x.supersedes).filter(Boolean) as string[]);
  return p.filter((x) => !superseded.has(x.id));
}

function statuses(
  profile: ChildProfile, history: FoodEvent[], scripts: Prescription[],
  day: Day, config: Config,
): Partial<Record<Allergen, AllergenStatus>> {
  const out: Partial<Record<Allergen, AllergenStatus>> = {};
  for (const a of ALLERGENS_BY_JURISDICTION[profile.jurisdiction]) {
    if (profile.excluded.includes(a)) { out[a] = { kind: "excluded" }; continue; }
    const events = history
      .filter((e) => e.allergen === a && compareDay(e.day, day) <= 0)
      .sort((x, y) => compareDay(x.day, y.day));
    const exposures = events.filter((e) => e.kind === "exposure");

    const script = scripts.find((s) => s.allergen === a);
    if (script && profile.clinicianCleared.includes(a)) {
      const since = exposures.filter((e) => compareDay(e.day, script.enteredOn) >= 0);
      const last = since[since.length - 1];
      const prev = script.steps[Math.max(0, since.length - 1)];
      const holding = !!(last && prev && daysBetween(last.day, day) < prev.holdDays);
      out[a] = { kind: "onPrescribedPlan", step: since.length, holding };
      continue;
    }
    // [G] ASCIA: a reaction pauses THAT food only. Others proceed.
    const reaction = [...events].reverse().find((e) => e.kind === "reaction");
    if (reaction) { out[a] = { kind: "pausedAfterReaction", on: reaction.day }; continue; }

    if (!exposures.length) out[a] = { kind: "notStarted" };
    else if (exposures.length >= config.exposuresToEstablish) {
      out[a] = { kind: "established", on: exposures[config.exposuresToEstablish - 1]!.day };
    } else out[a] = { kind: "inProgress", exposures: exposures.length };
  }
  return out;
}

function dueOnPrescription(
  profile: ChildProfile, scripts: Prescription[], history: FoodEvent[], day: Day,
): { script: Prescription; step: PrescribedStep } | null {
  for (const script of scripts) {
    if (!profile.clinicianCleared.includes(script.allergen)) continue;
    const exposures = history
      .filter((e) => e.allergen === script.allergen && e.kind === "exposure"
        && compareDay(e.day, script.enteredOn) >= 0 && compareDay(e.day, day) < 0)
      .sort((x, y) => compareDay(x.day, y.day));
    const idx = exposures.length;
    const step = script.steps[idx];
    if (!step) continue;
    // The engine will not schedule an unconfirmed step. No exceptions.
    if (!step.confirmed) continue;
    const last = exposures[exposures.length - 1];
    if (last) {
      const prev = script.steps[Math.min(idx - 1, script.steps.length - 1)];
      if (prev && daysBetween(last.day, day) < prev.holdDays) continue;
    }
    return { script, step };
  }
  return null;
}

function readyForNextExposure(a: Allergen, history: FoodEvent[], day: Day): boolean {
  const last = lastExposure(a, history, day);
  return !last || daysBetween(last, day) >= 1;
}

function lastExposure(a: Allergen, h: FoodEvent[], onOrBefore: Day): Day | null {
  const days = h.filter((e) => e.allergen === a && e.kind === "exposure"
    && compareDay(e.day, onOrBefore) <= 0).map((e) => e.day);
  return days.length ? days.reduce(maxDay) : null;
}

function lastNewStart(h: FoodEvent[], before: Day): Day | null {
  const firsts = new Map<Allergen, Day>();
  for (const e of h) {
    if (e.kind !== "exposure" || compareDay(e.day, before) >= 0) continue;
    const cur = firsts.get(e.allergen);
    firsts.set(e.allergen, cur && compareDay(cur, e.day) <= 0 ? cur : e.day);
  }
  const vals = [...firsts.values()];
  return vals.length ? vals.reduce(maxDay) : null;
}

const LABELS: Record<Allergen, string> = {
  peanut: "Peanut", egg: "Egg", cowsMilk: "Cow's milk", wheat: "Wheat", soy: "Soy",
  sesame: "Sesame", treeNut: "Tree nut", fish: "Fish", shellfish: "Shellfish",
  celery: "Celery", mustard: "Mustard", lupin: "Lupin", mollusc: "Mollusc",
};
export function label(a: Allergen): string { return LABELS[a]; }
