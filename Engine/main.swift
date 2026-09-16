import Foundation

var passed = 0, failed = 0
func check(_ name: String, _ cond: Bool, _ detail: @autoclosure () -> String = "") {
    if cond { passed += 1; print("  ok   \(name)") }
    else { failed += 1; print("  FAIL \(name) \(detail())") }
}

let M = DayMath()
let kid = UUID()
let born = Day(2026, 1, 14)          // 8 months old on 2026-09-14
let today = Day(2026, 9, 14)

func profile(_ tier: RiskTier = .standard,
             cleared: Set<Allergen> = [],
             excluded: Set<Allergen> = [],
             ready: Day? = Day(2026, 7, 1)) -> ChildProfile {
    ChildProfile(id: kid, name: "Baby", birthDate: born, riskTier: tier,
                 jurisdiction: .us, readinessConfirmedOn: ready,
                 clinicianCleared: cleared, excluded: excluded)
}
func ev(_ a: Allergen, _ d: Day, _ k: EventKind = .exposure, dose: Dose? = nil) -> FoodEvent {
    FoodEvent(childID: kid, allergen: a, day: d, kind: k, dose: dose)
}
func one(_ p: ChildProfile, _ h: [FoodEvent], _ s: [Prescription] = [], on d: Day = today) -> DayPlan {
    Planner.plan(profile: p, history: h, prescriptions: s, from: d, through: d)[0]
}

print("\n== DayMath ==")
check("leap day", M.addDays(1, to: Day(2028, 2, 28)) == Day(2028, 2, 29))
check("non-leap rolls", M.addDays(1, to: Day(2026, 2, 28)) == Day(2026, 3, 1))
check("year boundary", M.addDays(1, to: Day(2026, 12, 31)) == Day(2027, 1, 1))
check("span across months", M.daysBetween(Day(2026, 1, 14), and: Day(2026, 9, 14)) == 243)
check("negative span", M.daysBetween(Day(2026, 9, 14), and: Day(2026, 9, 1)) == -13)
check("age 8mo ~243d", M.daysBetween(born, and: today) == 243)

print("\n== Gates ==")
check("too young", one(ChildProfile(id: kid, name: "N", birthDate: Day(2026, 8, 1),
                                    riskTier: .standard, readinessConfirmedOn: Day(2026,8,2)),
                       []).blocked == .tooYoung)
check("readiness unconfirmed blocks",
      one(profile(ready: nil), []).blocked == .readinessNotConfirmed)
check("readiness in future blocks",
      one(profile(ready: Day(2026,10,1)), []).blocked == .readinessNotConfirmed)
check("high risk: no home schedule",
      one(profile(.severeEczemaOrEggAllergy), []).introduce == nil)
check("high risk: note tells you why",
      one(profile(.severeEczemaOrEggAllergy), []).notes.contains { $0.contains("allergist") })
check("high risk + per-allergen clearance unblocks that food",
      one(profile(.severeEczemaOrEggAllergy, cleared: [.peanut]), []).introduce?.allergen == .peanut)

print("\n== Garrett's case: 8mo, peanut established, egg mid-introduction ==")
let real: [FoodEvent] = [
    ev(.peanut, Day(2026,8,2)),  ev(.peanut, Day(2026,8,5)),  ev(.peanut, Day(2026,8,9)),
    ev(.peanut, Day(2026,8,12)), ev(.peanut, Day(2026,8,15)),      // 5 -> established
    ev(.egg,    Day(2026,8,20)), ev(.egg,    Day(2026,8,23)),      // 2 -> in progress
]
let g = one(profile(), real)
check("finishes egg before starting anything new", g.introduce?.allergen == .egg,
      "got \(String(describing: g.introduce?.allergen))")
check("egg carries no dose by default", g.introduce?.dose == nil)
check("peanut is overdue for maintenance", g.maintenanceDue.contains { $0.allergen == .peanut })
check("maintenance carries no dose either", g.maintenanceDue.allSatisfy { $0.dose == nil })

print("\n== Catch-up invariant ==")
let horizon = Planner.plan(profile: profile(), history: real, from: today, through: Day(2027, 3, 1))
check("horizon actually schedules something", horizon.contains { $0.introduce != nil })
let newPerDay = horizon.map { $0.introduce?.isNew == true ? 1 : 0 }
check("at most one new food per day", newPerDay.allSatisfy { $0 <= 1 })
let gapped = one(profile(), real, on: Day(2026, 10, 20))     // ~2 months of nothing
check("long gap does not stack", gapped.introduce != nil && gapped.maintenanceDue.count >= 1)
check("long gap still one new food", (gapped.introduce?.isNew == true ? 1 : 0) <= 1)

print("\n== Reaction ==")
let reacted = real + [ev(.egg, Day(2026,8,26), .reaction)]
let r = one(profile(), reacted)
check("reacted food is not scheduled", r.introduce?.allergen != .egg)
check("other foods still proceed", r.introduce != nil, "expected a different allergen")
check("reaction note present", r.notes.contains { $0.contains("paused after a reaction") })
check("note says do not retry without advice",
      r.notes.contains { $0.contains("without advice from your clinician") })

print("\n== Prescriptions (user-entered, confirmed) ==")
let draft = LadderDraft.draft(start: Dose(mgProtein: 1), multiplier: 2, steps: 5, holdDays: 14)
check("draft has right length", draft.count == 5)
check("draft doubles", draft.map { $0.dose.mgProtein } == [1, 2, 4, 8, 16])
check("draft is UNCONFIRMED", draft.allSatisfy { !$0.confirmed })

let unconfirmed = Prescription(childID: kid, allergen: .egg, enteredOn: Day(2026,9,1),
                               attribution: "Dr N, 1 Sep 2026", steps: draft)
check("unconfirmed steps are never scheduled",
      one(profile(cleared: [.egg]), reacted, [unconfirmed]).introduce?.allergen != .egg)

let confirmed = Prescription(childID: kid, allergen: .egg, enteredOn: Day(2026,9,1),
                             attribution: "Dr N, 1 Sep 2026",
                             steps: draft.map { PrescribedStep(index: $0.index, dose: $0.dose,
                                                               holdDays: $0.holdDays, confirmed: true) })
let onPlan = one(profile(cleared: [.egg]), reacted, [confirmed])
check("confirmed plan resumes the food", onPlan.introduce?.allergen == .egg)
check("dose comes from the plan", onPlan.introduce?.dose == Dose(mgProtein: 1))
check("dose is attributed", onPlan.introduce?.attribution == "Dr N, 1 Sep 2026")

let afterStep1 = reacted + [ev(.egg, Day(2026,9,14), dose: Dose(mgProtein: 1))]
let tooSoon = one(profile(cleared: [.egg]), afterStep1, [confirmed], on: Day(2026,9,20))
check("holdDays respected - no advance before 14 days", tooSoon.introduce?.allergen != .egg)
let onTime = one(profile(cleared: [.egg]), afterStep1, [confirmed], on: Day(2026,9,28))
check("advances after holdDays", onTime.introduce?.dose == Dose(mgProtein: 2))
check("engine never invents a dose",
      one(profile(), real).introduce?.dose == nil && one(profile(), []).introduce?.dose == nil)

print("\n== Superseding ==")
let bad = ev(.soy, Day(2026,9,1), .reaction)
let fix = FoodEvent(childID: kid, allergen: .soy, day: Day(2026,9,1), kind: .exposure, supersedes: bad.id)
let corrected = one(profile(), real + [bad, fix])
check("correction supersedes the reaction",
      !corrected.notes.contains { $0.contains("soy is paused") })

print("\n== Exclusions and jurisdiction ==")
let ex = Planner.plan(profile: profile(excluded: [.peanut, .egg, .cowsMilk]),
                      history: [], from: today, through: Day(2027, 1, 1))
check("excluded foods never scheduled",
      ex.allSatisfy { ![Allergen.peanut, .egg, .cowsMilk].contains($0.introduce?.allergen ?? .fish) })
check("US set excludes celery", !Jurisdiction.us.allergens.contains(.celery))
check("EU set includes celery", Jurisdiction.eu.allergens.contains(.celery))

print("\n== Maintenance outlives introduction ==")
var all: [FoodEvent] = []
var d = Day(2026, 3, 1)
for a in Jurisdiction.us.allergens {
    for _ in 0..<5 { all.append(ev(a, d)); d = M.addDays(2, to: d) }
    d = M.addDays(5, to: d)
}
let toddler = one(profile(), all, on: Day(2029, 9, 14))     // child is 3.7
check("nothing left to introduce", toddler.introduce == nil)
check("maintenance still due", !toddler.maintenanceDue.isEmpty)
let grown = one(profile(), all, on: Day(2032, 9, 14))       // child is 6.7
check("maintenance window closes after 5 years", grown.maintenanceDue.isEmpty)

print("\n== Determinism ==")
let a1 = one(profile(), real), a2 = one(profile(), real)
check("same inputs, same output",
      a1.introduce?.allergen == a2.introduce?.allergen && a1.notes == a2.notes)

print("\n\(passed) passed, \(failed) failed\n")
exit(failed == 0 ? 0 : 1)
