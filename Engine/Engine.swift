import Foundation

// =========================================================================
// PURE MODULE. No I/O, no UI, nothing read from the environment.
// Same inputs -> same outputs, always.
//
// Rule tags:
//   [G] GUIDELINE  - traceable to ASCIA / NIAID / LEAP / FDA
//   [C] CONVENTION - popularised practice, NOT guideline text. Tunable.
//                    Every [C] value needs clinician sign-off.
//
// THIS ENGINE SHIPS NO RECOMMENDED DOSES. It schedules WHICH allergen and
// WHEN. Amounts exist only when a parent has entered a clinician's plan and
// confirmed it step by step. There is no code path that invents a quantity.
// =========================================================================

// MARK: - Calendar day (deliberately not a Date)

public struct Day: Codable, Hashable, Comparable, CustomStringConvertible {
    public let year: Int, month: Int, dayOfMonth: Int
    public init(_ y: Int, _ m: Int, _ d: Int) { year = y; month = m; dayOfMonth = d }
    public static func < (a: Day, b: Day) -> Bool {
        if a.year != b.year { return a.year < b.year }
        if a.month != b.month { return a.month < b.month }
        return a.dayOfMonth < b.dayOfMonth
    }
    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, dayOfMonth)
    }
}

/// Calendar arithmetic, isolated so the engine stays pure and so DST /
/// month-length bugs have one place to live and one place to be tested.
public struct DayMath {
    private let cal: Calendar
    public init() {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(secondsFromGMT: 0)!   // fixed: "today" is a calendar day
        self.cal = c
    }
    private func date(_ d: Day) -> Date {
        cal.date(from: DateComponents(year: d.year, month: d.month, day: d.dayOfMonth))!
    }
    public func addDays(_ n: Int, to d: Day) -> Day {
        day(from: cal.date(byAdding: .day, value: n, to: date(d))!)
    }
    public func daysBetween(_ a: Day, and b: Day) -> Int {
        cal.dateComponents([.day], from: date(a), to: date(b)).day!
    }
    public func day(from date: Date) -> Day {
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return Day(c.year!, c.month!, c.day!)
    }
}

// MARK: - Domain

public enum Allergen: String, CaseIterable, Codable {
    case peanut, egg, cowsMilk, wheat, soy, sesame, treeNut, fish, shellfish
    case celery, mustard, lupin, mollusc          // EU-only additions
}

public enum Jurisdiction: String, Codable {
    case us, eu, auNz
    /// [G] The allergen SET differs by market, not just the labelling.
    /// US "Big 9" - sesame added by the FASTER Act, effective 2023-01-01.
    public var allergens: [Allergen] {
        switch self {
        case .us:   return [.peanut, .egg, .cowsMilk, .wheat, .soy, .sesame, .treeNut, .fish, .shellfish]
        case .auNz: return [.peanut, .egg, .cowsMilk, .wheat, .soy, .sesame, .treeNut, .fish, .shellfish, .lupin, .mollusc]
        case .eu:   return Allergen.allCases
        }
    }
}

public enum RiskTier: String, Codable {
    case standard                      // [G] no eczema, no known allergy
    case mildEczema                    // [G] home introduction ~6 months
    case severeEczemaOrEggAllergy      // [G] LEAP population - specialist first
}

public struct ChildProfile: Codable {
    public let id: UUID
    public let name: String
    public let birthDate: Day
    public let riskTier: RiskTier
    public let jurisdiction: Jurisdiction
    /// [G] Guidelines gate on developmental readiness, which the engine cannot
    /// observe. The app asks; the engine is told. Nil means "not yet confirmed".
    public let readinessConfirmedOn: Day?
    /// Per-ALLERGEN clinician clearance. Unblocks the high-risk tier for that
    /// food, and permits resuming a food after a reaction. Never inferred.
    public let clinicianCleared: Set<Allergen>
    /// Not eaten in this household. Skipped with no penalty and no nagging.
    public let excluded: Set<Allergen>

    public init(id: UUID = UUID(), name: String, birthDate: Day, riskTier: RiskTier,
                jurisdiction: Jurisdiction = .us, readinessConfirmedOn: Day? = nil,
                clinicianCleared: Set<Allergen> = [], excluded: Set<Allergen> = []) {
        self.id = id; self.name = name; self.birthDate = birthDate
        self.riskTier = riskTier; self.jurisdiction = jurisdiction
        self.readinessConfirmedOn = readinessConfirmedOn
        self.clinicianCleared = clinicianCleared; self.excluded = excluded
    }
}

// MARK: - Events (append-only; corrections supersede, never mutate)

public enum EventKind: String, Codable {
    case exposure, reaction, skippedDeliberate
}

public struct FoodEvent: Codable, Identifiable {
    public let id: UUID
    public let childID: UUID
    public let allergen: Allergen
    public let day: Day
    public let kind: EventKind
    /// What was actually served, if the parent chose to record it. Optional by
    /// design: the default experience records no quantity at all.
    public let dose: Dose?
    public let supersedes: UUID?
    public init(id: UUID = UUID(), childID: UUID, allergen: Allergen, day: Day,
                kind: EventKind, dose: Dose? = nil, supersedes: UUID? = nil) {
        self.id = id; self.childID = childID; self.allergen = allergen
        self.day = day; self.kind = kind; self.dose = dose; self.supersedes = supersedes
    }
}

// MARK: - Doses and prescriptions (100% user-entered)

/// Canonical unit is milligrams of ALLERGEN PROTEIN - the clinically
/// meaningful quantity, and what OIT protocols are written in. Display
/// conversion happens at the UI edge, never here.
public struct Dose: Codable, Equatable {
    public let mgProtein: Double
    public init(mgProtein: Double) { self.mgProtein = mgProtein }
}

public struct PrescribedStep: Codable, Equatable {
    public let index: Int
    public let dose: Dose
    /// Days to hold at this dose before the next step becomes available.
    public let holdDays: Int
    /// The parent ticked this line against their clinician's sheet.
    /// The engine will not schedule an unconfirmed step. No exceptions.
    public let confirmed: Bool
    public init(index: Int, dose: Dose, holdDays: Int, confirmed: Bool) {
        self.index = index; self.dose = dose; self.holdDays = holdDays; self.confirmed = confirmed
    }
}

/// A plan the PARENT entered, attributed to their clinician. Stored, immutable,
/// superseding. The engine never authors one of these.
public struct Prescription: Codable, Identifiable {
    public let id: UUID
    public let childID: UUID
    public let allergen: Allergen
    public let enteredOn: Day
    public let attribution: String        // shown on every dose, e.g. "Dr Nguyen, 14 Sep 2026"
    public let steps: [PrescribedStep]
    public let supersedes: UUID?
    public init(id: UUID = UUID(), childID: UUID, allergen: Allergen, enteredOn: Day,
                attribution: String, steps: [PrescribedStep], supersedes: UUID? = nil) {
        self.id = id; self.childID = childID; self.allergen = allergen
        self.enteredOn = enteredOn; self.attribution = attribution
        self.steps = steps; self.supersedes = supersedes
    }
}

/// DATA-ENTRY CONVENIENCE, NOT A RECOMMENDATION. Expands values the user typed
/// into an UNCONFIRMED draft table for them to check line by line against their
/// clinician's sheet. Every step comes back confirmed:false, and the engine
/// refuses to schedule unconfirmed steps - so nothing this produces can reach a
/// parent as an instruction without a human having ratified it.
public enum LadderDraft {
    public static func draft(start: Dose, multiplier: Double, steps: Int, holdDays: Int) -> [PrescribedStep] {
        guard steps > 0, multiplier > 0, start.mgProtein > 0 else { return [] }
        return (0..<steps).map { i in
            PrescribedStep(index: i,
                           dose: Dose(mgProtein: start.mgProtein * pow(multiplier, Double(i))),
                           holdDays: holdDays,
                           confirmed: false)
        }
    }
}

// MARK: - Config (every CONVENTION lives here, not in the logic)

public struct Config: Codable {
    public var solidsFloorDays: Int = 17 * 7          // [G] not before ~4 months
    public var solidsDefaultDays: Int = 182           // [G] ~6 months
    public var allergensInDietByDays: Int = 365       // [G] by 12 months
    public var maxNewAllergensPerDay: Int = 1         // [G] one NEW food per meal
    public var minDaysBetweenNewAllergens: Int = 5    // [C] convention, not guideline
    public var exposuresToEstablish: Int = 5          // [C] no guideline basis found
    public var maintenanceIntervalDays: Int = 7       // [G] at least weekly, ongoing
    public var maintenanceThroughDays: Int = 5 * 365  // [G] LEAP studied duration
    public var observationWindowMinutes: Int = 120    // [G] minutes to two hours
    public var preferMorning: Bool = true             // [C] practice, not guideline
    /// [C] Serial finishes one allergen before starting the next. Overlapping
    /// only requires that no more than one be NEW on a given day, which is all
    /// the guideline actually asks. Late starters need overlapping to fit.
    public var serialIntroduction: Bool = true
    /// [G] Strongest trial evidence (LEAP, EAT) is for peanut and egg.
    public var priority: [Allergen] = [.peanut, .egg, .cowsMilk, .wheat, .soy, .sesame,
                                       .treeNut, .fish, .shellfish, .celery, .mustard,
                                       .lupin, .mollusc]
    public init() {}
}

// MARK: - Output

public enum BlockReason: String, Codable {
    case tooYoung
    case readinessNotConfirmed
    case needsSpecialistEvaluation
    case maintenanceComplete
}

public enum AllergenStatus: Equatable {
    case notStarted
    case inProgress(exposures: Int)
    case established(on: Day)
    case pausedAfterReaction(on: Day)
    case onPrescribedPlan(step: Int, holding: Bool)
    case excluded
}

public struct ScheduledItem {
    public let allergen: Allergen
    public let isNew: Bool
    /// Present ONLY when the parent entered and confirmed a clinician's plan.
    /// nil in the default experience, which is the whole point.
    public let dose: Dose?
    public let attribution: String?
}

public struct DayPlan {
    public let day: Day
    public let ageInDays: Int
    public let introduce: ScheduledItem?
    public let maintenanceDue: [ScheduledItem]
    public let blocked: BlockReason?
    public let notes: [String]
}

// MARK: - Engine

public enum Planner {

    /// `today` is a PARAMETER, never a clock read. That is what lets one
    /// function answer for past, present and future - and what makes every
    /// result reproducible.
    public static func plan(profile: ChildProfile,
                            history: [FoodEvent],
                            prescriptions: [Prescription] = [],
                            from start: Day,
                            through end: Day,
                            config: Config = Config(),
                            math: DayMath = DayMath()) -> [DayPlan] {
        let hist = effective(history.filter { $0.childID == profile.id })
        let scripts = effectiveScripts(prescriptions.filter { $0.childID == profile.id })
        let realHorizon = hist.map(\.day).max()

        var projected = hist
        var out: [DayPlan] = []
        var day = start
        while !(end < day) {
            let p = planOne(profile: profile, history: projected, scripts: scripts,
                            on: day, config: config, math: math)
            out.append(p)
            // Past days use real history. Future days assume the plan is
            // followed - otherwise no forward calendar can exist at all.
            if let h = realHorizon, h < day, let item = p.introduce {
                projected.append(FoodEvent(childID: profile.id, allergen: item.allergen,
                                           day: day, kind: .exposure, dose: item.dose))
            }
            day = math.addDays(1, to: day)
        }
        return out
    }

    // MARK: one day

    static func planOne(profile: ChildProfile, history: [FoodEvent],
                        scripts: [Prescription], on day: Day,
                        config: Config, math: DayMath) -> DayPlan {

        let age = math.daysBetween(profile.birthDate, and: day)
        var notes: [String] = []

        func blocked(_ r: BlockReason, _ n: String) -> DayPlan {
            DayPlan(day: day, ageInDays: age, introduce: nil, maintenanceDue: [],
                    blocked: r, notes: [n])
        }

        // --- Gates -------------------------------------------------------
        if age < config.solidsFloorDays {
            return blocked(.tooYoung, "Guidelines advise against starting solids before about four months.")
        }
        if let r = profile.readinessConfirmedOn, day < r {
            return blocked(.readinessNotConfirmed, "Readiness signs were confirmed on \(r).")
        }
        if profile.readinessConfirmedOn == nil {
            return blocked(.readinessNotConfirmed,
                "Guidelines gate starting solids on developmental readiness - sitting with support, "
              + "steady head control, interest in food. Confirm these before starting.")
        }

        let status = statuses(profile: profile, history: history, scripts: scripts,
                              config: config, math: math, on: day)

        // --- Maintenance [G] --------------------------------------------
        // Several at once is fine: these foods are already tolerated, so there
        // is no attribution problem. Only NEW foods are capped.
        var due: [(Allergen, Int)] = []
        if age <= config.maintenanceThroughDays {
            for a in profile.jurisdiction.allergens {
                guard case .established = status[a] else { continue }
                guard let last = lastExposure(a, in: history, onOrBefore: day) else { continue }
                let gap = math.daysBetween(last, and: day)
                if gap >= config.maintenanceIntervalDays { due.append((a, gap)) }
            }
        }
        let maintenanceDue = due.sorted { $0.1 > $1.1 }
            .map { ScheduledItem(allergen: $0.0, isNew: false, dose: nil, attribution: nil) }

        // --- Introduction ------------------------------------------------
        var introduce: ScheduledItem? = nil

        // A food on a confirmed clinician plan takes precedence: it is the only
        // path by which a food carries a dose, and the only path by which a
        // food resumes after a reaction.
        if let (script, step) = dueOnPrescription(profile: profile, scripts: scripts,
                                                  history: history, status: status,
                                                  on: day, math: math) {
            introduce = ScheduledItem(allergen: script.allergen, isNew: false,
                                      dose: step.dose, attribution: script.attribution)
        } else if let active = inProgressAllergen(status, config: config),
                  readyForNextExposure(active, history: history, on: day, math: math) {
            introduce = ScheduledItem(allergen: active, isNew: false, dose: nil, attribution: nil)
        } else {
            let blockedBySerial = config.serialIntroduction && inProgressAllergen(status, config: config) != nil
            let gapOK = lastNewStart(in: history, before: day).map {
                math.daysBetween($0, and: day) >= config.minDaysBetweenNewAllergens
            } ?? true
            if !blockedBySerial, gapOK {
                let next = config.priority.first { a in
                    profile.jurisdiction.allergens.contains(a)
                    && !profile.excluded.contains(a)
                    && status[a] == .notStarted
                    && !(profile.riskTier == .severeEczemaOrEggAllergy && !profile.clinicianCleared.contains(a))
                }
                if let n = next {
                    introduce = ScheduledItem(allergen: n, isNew: true, dose: nil, attribution: nil)
                }
            }
        }

        // --- Catch-up invariant ------------------------------------------
        // Falling behind EXTENDS the plan; it never compresses it. There is
        // exactly one assignment site for a NEW food and it assigns one value.
        assert(config.maxNewAllergensPerDay == 1)

        // --- Notes ---------------------------------------------------------
        if profile.riskTier == .severeEczemaOrEggAllergy {
            let ungated = profile.jurisdiction.allergens.filter {
                !profile.excluded.contains($0) && !profile.clinicianCleared.contains($0)
                && status[$0] == .notStarted
            }
            if !ungated.isEmpty {
                notes.append("Guidelines for infants with severe eczema or existing egg allergy "
                           + "contemplate specialist evaluation before introduction at home. "
                           + "Talk to your pediatrician or allergist first.")
            }
        }
        for a in profile.jurisdiction.allergens {
            if case .pausedAfterReaction = status[a] {
                notes.append("\(a.rawValue) is paused after a reaction. Other foods continue as normal. "
                           + "Do not retry it without advice from your clinician.")
            }
            if case .onPrescribedPlan(_, let holding) = status[a], holding {
                notes.append("\(a.rawValue) is holding at its current step. A missed dose means the plan "
                           + "does not advance on its own - check with your clinician before resuming.")
            }
        }
        let remaining = profile.jurisdiction.allergens.filter {
            !profile.excluded.contains($0) && status[$0] == .notStarted
        }
        if age < config.allergensInDietByDays, !remaining.isEmpty {
            let daysLeft = config.allergensInDietByDays - age
            if remaining.count * config.minDaysBetweenNewAllergens > daysLeft {
                notes.append("\(remaining.count) foods left and \(daysLeft) days to twelve months. "
                           + "Guidelines require only one new food per meal, so these can be spaced "
                           + "more closely. Worth raising with your pediatrician.")
            }
        }
        if let i = introduce, i.isNew, config.preferMorning {
            notes.append("Serve earlier in the day and watch for about "
                       + "\(config.observationWindowMinutes / 60) hours.")
        }

        return DayPlan(day: day, ageInDays: age, introduce: introduce,
                       maintenanceDue: maintenanceDue, blocked: nil, notes: notes)
    }

    // MARK: derivation

    static func effective(_ h: [FoodEvent]) -> [FoodEvent] {
        let superseded = Set(h.compactMap(\.supersedes))
        return h.filter { !superseded.contains($0.id) }
    }
    static func effectiveScripts(_ p: [Prescription]) -> [Prescription] {
        let superseded = Set(p.compactMap(\.supersedes))
        return p.filter { !superseded.contains($0.id) }
    }

    static func statuses(profile: ChildProfile, history: [FoodEvent], scripts: [Prescription],
                         config: Config, math: DayMath, on day: Day) -> [Allergen: AllergenStatus] {
        var out: [Allergen: AllergenStatus] = [:]
        for a in profile.jurisdiction.allergens {
            if profile.excluded.contains(a) { out[a] = .excluded; continue }
            let events = history.filter { $0.allergen == a && !(day < $0.day) }.sorted { $0.day < $1.day }
            let exposures = events.filter { $0.kind == .exposure }

            if let script = scripts.first(where: { $0.allergen == a }),
               profile.clinicianCleared.contains(a) {
                let done = exposures.filter { !($0.day < script.enteredOn) }.count
                let holding = !readyForNextPrescribedStep(script, doneCount: done,
                                                          history: exposures, on: day, math: math)
                out[a] = .onPrescribedPlan(step: done, holding: holding)
                continue
            }
            // [G] ASCIA: a reaction pauses THAT food only. Others proceed.
            if let r = events.last(where: { $0.kind == .reaction }) {
                out[a] = .pausedAfterReaction(on: r.day); continue
            }
            if exposures.isEmpty { out[a] = .notStarted }
            else if exposures.count >= config.exposuresToEstablish {
                out[a] = .established(on: exposures[config.exposuresToEstablish - 1].day)
            } else { out[a] = .inProgress(exposures: exposures.count) }
        }
        return out
    }

    static func dueOnPrescription(profile: ChildProfile, scripts: [Prescription],
                                  history: [FoodEvent], status: [Allergen: AllergenStatus],
                                  on day: Day, math: DayMath) -> (Prescription, PrescribedStep)? {
        for script in scripts where profile.clinicianCleared.contains(script.allergen) {
            let exposures = history.filter {
                $0.allergen == script.allergen && $0.kind == .exposure
                && !($0.day < script.enteredOn) && $0.day < day
            }.sorted { $0.day < $1.day }
            let idx = exposures.count
            guard idx < script.steps.count else { continue }
            let step = script.steps[idx]
            // The engine will not schedule an unconfirmed step. No exceptions.
            guard step.confirmed else { continue }
            if let last = exposures.last {
                let prev = script.steps[min(idx - 1, script.steps.count - 1)]
                if math.daysBetween(last.day, and: day) < prev.holdDays { continue }
            }
            return (script, step)
        }
        return nil
    }

    static func readyForNextPrescribedStep(_ s: Prescription, doneCount: Int,
                                           history: [FoodEvent], on day: Day, math: DayMath) -> Bool {
        guard doneCount > 0, doneCount - 1 < s.steps.count else { return true }
        guard let last = history.last else { return true }
        return math.daysBetween(last.day, and: day) >= s.steps[doneCount - 1].holdDays
    }

    static func inProgressAllergen(_ s: [Allergen: AllergenStatus], config: Config) -> Allergen? {
        config.priority.first { a in
            if case .inProgress = s[a] { return true }
            return false
        }
    }

    static func readyForNextExposure(_ a: Allergen, history: [FoodEvent],
                                     on day: Day, math: DayMath) -> Bool {
        guard let last = lastExposure(a, in: history, onOrBefore: day) else { return true }
        return math.daysBetween(last, and: day) >= 1
    }

    static func lastExposure(_ a: Allergen, in h: [FoodEvent], onOrBefore d: Day) -> Day? {
        h.filter { $0.allergen == a && $0.kind == .exposure && !(d < $0.day) }.map(\.day).max()
    }

    static func lastNewStart(in h: [FoodEvent], before d: Day) -> Day? {
        var firsts: [Allergen: Day] = [:]
        for e in h where e.kind == .exposure && e.day < d {
            if let cur = firsts[e.allergen] { firsts[e.allergen] = min(cur, e.day) }
            else { firsts[e.allergen] = e.day }
        }
        return firsts.values.max()
    }
}
