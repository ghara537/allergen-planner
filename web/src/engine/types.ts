// Ported from Engine.swift. The Swift version remains the reference
// implementation; both are validated against the same fixtures.
//
// Rule tags:
//   [G] GUIDELINE  - traceable to ASCIA / NIAID / LEAP / FDA
//   [C] CONVENTION - popularised practice, NOT guideline text. Tunable.
//
// THIS ENGINE SHIPS NO RECOMMENDED DOSES. Quantities exist only when a parent
// has entered a clinician's plan and confirmed it step by step.

export type Allergen =
  | "peanut" | "egg" | "cowsMilk" | "wheat" | "soy" | "sesame"
  | "treeNut" | "fish" | "shellfish"
  | "celery" | "mustard" | "lupin" | "mollusc";

export type Jurisdiction = "us" | "eu" | "auNz";

/** [G] The allergen SET differs by market, not just the labelling. */
export const ALLERGENS_BY_JURISDICTION: Record<Jurisdiction, Allergen[]> = {
  // US "Big 9" - sesame added by the FASTER Act, effective 2023-01-01.
  us: ["peanut", "egg", "cowsMilk", "wheat", "soy", "sesame", "treeNut", "fish", "shellfish"],
  auNz: ["peanut", "egg", "cowsMilk", "wheat", "soy", "sesame", "treeNut", "fish", "shellfish", "lupin", "mollusc"],
  eu: ["peanut", "egg", "cowsMilk", "wheat", "soy", "sesame", "treeNut", "fish", "shellfish",
       "celery", "mustard", "lupin", "mollusc"],
};

export type RiskTier =
  | "standard"                    // [G] no eczema, no known allergy
  | "mildEczema"                  // [G] home introduction ~6 months
  | "severeEczemaOrEggAllergy";   // [G] LEAP population - specialist first

/** A calendar day. Deliberately not a Date: a calendar day is not an instant,
 *  and keeping them distinct is what keeps timezone off-by-ones out. */
export interface Day { year: number; month: number; day: number }

export interface ChildProfile {
  id: string;
  name: string;
  birthDate: Day;
  riskTier: RiskTier;
  jurisdiction: Jurisdiction;
  /** [G] Guidelines gate on developmental readiness, which the engine cannot
   *  observe. The app asks; the engine is told. null = not yet confirmed. */
  readinessConfirmedOn: Day | null;
  /** Per-ALLERGEN clinician clearance. Unblocks the high-risk tier for that
   *  food, and permits resuming a food after a reaction. Never inferred. */
  clinicianCleared: Allergen[];
  /** Not eaten in this household. Skipped with no penalty, no nagging. */
  excluded: Allergen[];
  /** Set during the walkthrough, editable later. */
  settings: ChildSettings;
}

/** Minutes from midnight. A nap is a position on a day, not a timestamp -
 *  same reasoning as Day not being a Date. */
export interface NapSlot {
  startMin: number;
  durationMin: number;
  /** Only meaningful on a day override: this nap actually happened. */
  done?: boolean;
}

/** What today looked like, when it differed from the default. Append-only:
 *  an edit writes a new row superseding the old, so two phones adjusting the
 *  same day converge instead of clobbering. */
export interface DayOverride {
  id: string;
  childId: string;
  day: Day;
  naps: NapSlot[];
  supersedes: string | null;
}

export interface ChildSettings {
  /** The usual shape of a day. Today can deviate without changing this. */
  naps: NapSlot[];
  /** Window the timeline draws, minutes from midnight. */
  dayStartMin: number;
  dayEndMin: number;
  /** Days between STARTING new allergens. [C] convention, you choose it. */
  newAllergenCadenceDays: number;
  /** Days of sustained exposure - first to last - before a food counts as
   *  settled. [C] no guideline basis; this is your call. */
  daysToEstablish: number;
}

export const DEFAULT_SETTINGS: ChildSettings = {
  naps: [
    { startMin: 9 * 60, durationMin: 75 },
    { startMin: 13 * 60 + 30, durationMin: 90 },
  ],
  dayStartMin: 6 * 60,
  dayEndMin: 20 * 60,
  newAllergenCadenceDays: 5,
  daysToEstablish: 21,
};

export type BlockKind = "nap" | "feed" | "observation";
export type FeedStatus = "done" | "due" | "missed" | "reacted";

export interface TimelineBlock {
  kind: BlockKind;
  startMin: number;
  endMin: number;
  /** naps only - 1-based, for "nap 2 of 3" */
  napIndex?: number;
  napDone?: boolean;
  /** feeds only */
  allergen?: Allergen;
  dose?: Dose | null;
  isNew?: boolean;
  status?: FeedStatus;
  /** observation only - true when the watch window runs into a nap */
  clashesWithNap?: boolean;
}

export type EventKind = "exposure" | "reaction" | "skippedDeliberate";

export interface FoodEvent {
  id: string;
  childId: string;
  allergen: Allergen;
  day: Day;
  kind: EventKind;
  /** What was actually served, if the parent chose to record it.
   *  Optional by design: the default experience records no quantity. */
  dose: Dose | null;
  /** Corrections supersede by id. Nothing is ever mutated or deleted. */
  supersedes: string | null;
}

/** Whatever the parent measures in. The app stores what they typed and never
 *  converts, because it has no table of conversions to be wrong about. */
export interface Dose {
  amount: number;
  unit: string;
}

/** How a food's amount changes over time. Entirely user-entered - the engine
 *  never authors one and never suggests a number. A food with no DosePlan is
 *  scheduled by name only, which is the default experience.
 *
 *  Immutable. Editing creates a new plan effective today that supersedes this
 *  one, so "start amount" always means "the amount when this rule began". */
export interface DosePlan {
  id: string;
  childId: string;
  allergen: Allergen;
  /** The rule starts here. Editing later creates a new plan from that day. */
  effectiveFrom: Day;
  startAmount: number;
  unit: string;
  /** Add this much, or multiply by it - see mode. Zero or one means "hold". */
  increment: number;
  incrementMode: "add" | "multiply";
  /** Days at an amount before the next step becomes available. */
  everyDays: number;
  /** This child reacts to this food, so the plan is a careful build-up rather
   *  than an introduction. Changes tone and pacing, not the maths. */
  reactive: boolean;
  /** Free text, e.g. "Dr Nguyen, 14 Sep" - shown beside the amount if set. */
  source: string;
  supersedes: string | null;
}

export interface Config {
  solidsFloorDays: number;          // [G] not before ~4 months
  solidsDefaultDays: number;        // [G] ~6 months
  allergensInDietByDays: number;    // [G] by 12 months
  maxNewAllergensPerDay: number;    // [G] one NEW food per meal
  /** Fallbacks. Per-child settings on the profile win. */
  minDaysBetweenNewAllergens: number;
  daysToEstablish: number;
  maintenanceIntervalDays: number;  // [G] at least weekly, ongoing
  maintenanceThroughDays: number;   // [G] LEAP studied duration
  observationWindowMinutes: number; // [G] minutes to two hours
  preferMorning: boolean;           // [C] practice, not guideline
  /** [C] Serial finishes one allergen before starting the next. Overlapping
   *  only requires that no more than one be NEW on a given day, which is all
   *  the guideline actually asks. Late starters need overlapping to fit. */
  serialIntroduction: boolean;
  /** [G] Strongest trial evidence (LEAP, EAT) is for peanut and egg. */
  priority: Allergen[];
}

export const DEFAULT_CONFIG: Config = {
  solidsFloorDays: 17 * 7,
  solidsDefaultDays: 182,
  allergensInDietByDays: 365,
  maxNewAllergensPerDay: 1,
  minDaysBetweenNewAllergens: 5,
  daysToEstablish: 21,
  maintenanceIntervalDays: 7,
  maintenanceThroughDays: 5 * 365,
  observationWindowMinutes: 120,
  preferMorning: true,
  serialIntroduction: true,
  priority: ["peanut", "egg", "cowsMilk", "wheat", "soy", "sesame",
             "treeNut", "fish", "shellfish", "celery", "mustard", "lupin", "mollusc"],
};

export type BlockReason =
  | "tooYoung" | "readinessNotConfirmed"
  | "needsSpecialistEvaluation" | "maintenanceComplete";

export type AllergenStatus =
  | { kind: "notStarted" }
  | { kind: "inProgress"; exposures: number }
  | { kind: "established"; on: Day }
  | { kind: "pausedAfterReaction"; on: Day }
  | { kind: "onDosePlan"; step: number; amount: number; unit: string; reactive: boolean }
  | { kind: "excluded" };

export interface ScheduledItem {
  allergen: Allergen;
  isNew: boolean;
  /** Present ONLY when the parent has set up a dose plan for this food.
   *  null in the default experience, which is the whole point. */
  dose: Dose | null;
  source: string | null;
  reactive: boolean;
}

export interface DayPlan {
  day: Day;
  ageInDays: number;
  introduce: ScheduledItem | null;
  maintenanceDue: ScheduledItem[];
  blocked: BlockReason | null;
  notes: string[];
}
