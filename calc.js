/* Lift Lens - calories / hypertrophy stimulus / e1RM (pure functions, browser + node). */
(function (root) {
  "use strict";

  var MUSCLES = {
    chest: "胸", lats: "広背筋", upper_back: "背中上部", traps: "僧帽筋", front_delts: "肩前部",
    side_delts: "肩中部", rear_delts: "肩後部", biceps: "上腕二頭筋", triceps: "上腕三頭筋",
    forearms: "前腕", quads: "大腿四頭筋", hamstrings: "ハムストリング", glutes: "臀部",
    adductors: "内転筋", calves: "ふくらはぎ", abs: "腹筋", lower_back: "脊柱起立筋"
  };

  // k: [name, class, signal hint, concentricFirst, primary, secondary, bodyweight fraction (0 = loaded)]
  var EX = {
    squat: ["スクワット", "lower", "knee", false, ["quads", "glutes"], ["adductors", "lower_back"], 0],
    front_squat: ["フロントスクワット", "lower", "knee", false, ["quads"], ["glutes", "upper_back"], 0],
    deadlift: ["デッドリフト", "lower", "hip", true, ["glutes", "hamstrings", "lower_back"], ["quads", "traps", "forearms"], 0],
    romanian_deadlift: ["ルーマニアンデッドリフト", "lower", "hip", false, ["hamstrings", "glutes"], ["lower_back"], 0],
    leg_press: ["レッグプレス", "lower", "knee", false, ["quads", "glutes"], ["adductors"], 0],
    lunge: ["ランジ", "lower", "knee", false, ["quads", "glutes"], ["adductors"], 0],
    bulgarian_split_squat: ["ブルガリアンスクワット", "lower", "knee", false, ["quads", "glutes"], ["adductors"], 0],
    hip_thrust: ["ヒップスラスト", "lower", "hip", true, ["glutes"], ["hamstrings"], 0],
    leg_extension: ["レッグエクステンション", "isolation", "knee", true, ["quads"], [], 0],
    leg_curl: ["レッグカール", "isolation", "knee", true, ["hamstrings"], ["calves"], 0],
    calf_raise: ["カーフレイズ", "isolation", "hipY", true, ["calves"], [], 0],
    bench_press: ["ベンチプレス", "upper", "elbow", false, ["chest", "triceps"], ["front_delts"], 0],
    incline_bench_press: ["インクラインベンチプレス", "upper", "elbow", false, ["chest", "front_delts"], ["triceps"], 0],
    dumbbell_bench_press: ["ダンベルベンチプレス", "upper", "elbow", false, ["chest"], ["triceps", "front_delts"], 0],
    chest_fly: ["チェストフライ", "isolation", "shoulder", false, ["chest"], ["front_delts"], 0],
    push_up: ["腕立て伏せ", "upper", "elbow", false, ["chest", "triceps"], ["front_delts", "abs"], 0.64],
    dip: ["ディップス", "upper", "elbow", false, ["chest", "triceps"], ["front_delts"], 0.95],
    overhead_press: ["ショルダープレス", "upper", "elbow", true, ["front_delts", "triceps"], ["side_delts", "upper_back"], 0],
    lateral_raise: ["サイドレイズ", "isolation", "shoulder", true, ["side_delts"], ["traps"], 0],
    rear_delt_fly: ["リアレイズ", "isolation", "shoulder", true, ["rear_delts"], ["upper_back"], 0],
    pull_up: ["懸垂", "upper", "elbow", true, ["lats", "biceps"], ["upper_back", "rear_delts", "forearms"], 1.0],
    lat_pulldown: ["ラットプルダウン", "upper", "elbow", true, ["lats"], ["biceps", "upper_back", "rear_delts"], 0],
    barbell_row: ["ベントオーバーロウ", "upper", "elbow", true, ["lats", "upper_back"], ["biceps", "rear_delts", "lower_back"], 0],
    dumbbell_row: ["ワンハンドロウ", "upper", "elbow", true, ["lats", "upper_back"], ["biceps", "rear_delts"], 0],
    cable_row: ["シーテッドロウ", "upper", "elbow", true, ["lats", "upper_back"], ["biceps", "rear_delts"], 0],
    biceps_curl: ["アームカール", "isolation", "elbow", true, ["biceps"], ["forearms"], 0],
    hammer_curl: ["ハンマーカール", "isolation", "elbow", true, ["biceps", "forearms"], [], 0],
    triceps_pushdown: ["プッシュダウン", "isolation", "elbow", true, ["triceps"], [], 0],
    triceps_extension: ["トライセプスエクステンション", "isolation", "elbow", true, ["triceps"], [], 0],
    shrug: ["シュラッグ", "isolation", "shoulderY", true, ["traps"], ["forearms"], 0],
    crunch: ["クランチ", "isolation", "hip", true, ["abs"], [], 0.3],
    kettlebell_swing: ["ケトルベルスイング", "lower", "hip", true, ["glutes", "hamstrings"], ["lower_back", "front_delts"], 0],
    wall_ball: ["ウォールボール", "lower", "knee", false, ["quads", "glutes"], ["front_delts", "triceps"], 0],
    burpee: ["バーピー", "lower", "hipY", false, ["quads", "chest"], ["triceps", "glutes"], 0.7]
  };

  function exInfo(key, custom) {
    if (custom && custom[key]) return custom[key];
    var e = EX[key];
    if (!e) return null;
    return { key: key, name: e[0], cls: e[1], signal: e[2], concentricFirst: e[3], primary: e[4], secondary: e[5], bwFrac: e[6] };
  }
  function allExercises(custom) {
    var keys = Object.keys(EX).concat(Object.keys(custom || {}).filter(function (k) { return !EX[k]; }));
    return keys.map(function (k) { return exInfo(k, custom); });
  }

  /* MET values from the Compendium of Physical Activities (resistance training entries):
     vigorous multi-joint lifting 6.0, general/other 5.0, light isolation work 3.5. Rest between sets ~1.8. */
  var MET = { lower: 6.0, upper: 5.0, isolation: 3.5, rest: 1.8 };
  // ACSM: kcal/min = MET * 3.5 * kg / 200
  function kcal(met, kg, sec) { return met * 3.5 * kg / 200 * (sec / 60); }

  // set "work time" = time under tension plus ~1.5 s per rep for setup/lockout, at least 10 s
  function setKcal(cls, bodyKg, tut, reps) {
    var sec = Math.max(10, (tut || reps * 2.5) + reps * 1.5);
    return { sec: Math.round(sec), kcal: kcal(MET[cls] || 5.0, bodyKg, sec) };
  }
  function restKcal(bodyKg, sec) { return kcal(MET.rest, bodyKg, sec); }

  /* Stimulating ("effective") reps: roughly the last 5 reps before failure.
     RIR >= 5 -> no effective reps; to failure -> 5 (or all reps if the set was shorter). */
  function effectiveReps(reps, rir) {
    if (rir == null) rir = 2;
    return Math.max(0, Math.min(reps, 5 - rir));
  }
  // hard set credit for weekly volume (fractional: secondary muscles count half)
  function hardSet(rir, reps) { return reps >= 3 && (rir == null ? 2 : rir) <= 4 ? 1 : 0; }

  function rirLabel(rir) {
    if (rir == null) return "不明";
    if (rir === 0) return "限界";
    if (rir <= 2) return "高刺激";
    if (rir <= 4) return "有効";
    return "軽すぎ";
  }

  // estimated 1RM: Epley with reps-to-failure (reps + RIR)
  function e1rm(loadKg, reps, rir) {
    if (!(loadKg > 0) || !reps) return null;
    var rtf = reps + (rir == null ? 2 : rir);
    if (rtf > 20) return null; // too far from 1RM to be meaningful
    return loadKg * (1 + rtf / 30);
  }
  function effLoad(ex, weightKg, bodyKg) {
    if (!ex) return weightKg || 0;
    return (ex.bwFrac ? ex.bwFrac * bodyKg : 0) + (weightKg || 0);
  }

  /* weekly per-muscle sets -> zone. 10-20 hard sets/week per muscle is the commonly
     cited range for hypertrophy (Schoenfeld 2017 dose-response; Pelland 2024 diminishing returns). */
  function weeklyMuscles(sets, exLookup) {
    var m = {};
    Object.keys(MUSCLES).forEach(function (k) { m[k] = 0; });
    sets.forEach(function (s) {
      var ex = exLookup(s.exKey); if (!ex) return;
      var h = hardSet(s.rir, s.reps) * (s.setCount || 1);
      ex.primary.forEach(function (k) { if (k in m) m[k] += h; });
      ex.secondary.forEach(function (k) { if (k in m) m[k] += h * 0.5; });
    });
    return m;
  }
  function zone(n) {
    if (n < 4) return { id: "low", label: "不足" };
    if (n < 10) return { id: "mid", label: "維持〜成長" };
    if (n <= 20) return { id: "opt", label: "筋肥大ゾーン" };
    return { id: "over", label: "多すぎ注意" };
  }
  /* overall hypertrophy potential (0-100): average fulfilment of 10 sets for each muscle
     trained this week, penalised for muscles above 20 sets, plus a bonus for overload progress */
  function weeklyScore(muscleSets) {
    var keys = Object.keys(muscleSets).filter(function (k) { return muscleSets[k] > 0; });
    if (!keys.length) return 0;
    var s = keys.reduce(function (acc, k) {
      var n = muscleSets[k];
      return acc + (n <= 20 ? Math.min(1, n / 10) : Math.max(0.7, 1 - (n - 20) / 30));
    }, 0) / keys.length;
    var coverage = Math.min(1, keys.length / 10); // whole-body coverage
    return Math.round(100 * (0.75 * s + 0.25 * coverage));
  }

  var api = {
    MUSCLES: MUSCLES, EX: EX, exInfo: exInfo, allExercises: allExercises, MET: MET,
    setKcal: setKcal, restKcal: restKcal, effectiveReps: effectiveReps, hardSet: hardSet, rirLabel: rirLabel,
    e1rm: e1rm, effLoad: effLoad, weeklyMuscles: weeklyMuscles, zone: zone, weeklyScore: weeklyScore
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Calc = api;
})(this);
