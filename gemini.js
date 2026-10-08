/* Lift Lens - exercise identification with Gemini (only ~12 small stills are sent, never the video). */
const SIGNALS = ["elbow", "knee", "hip", "shoulder", "wristY", "hipY", "shoulderY"];

export async function identify({ apiKey, model, shots, motion, known, muscles, blurred }) {
  const S = (type, extra) => Object.assign({ type }, extra || {});
  const schema = S("OBJECT", {
    properties: {
      exercise_key: S("STRING", { description: "既知キーに該当すればそれ。無ければ英語snake_caseで新規" }),
      exercise_name_ja: S("STRING"),
      movement_class: S("STRING", { enum: ["lower", "upper", "isolation"] }),
      signal: S("STRING", { enum: SIGNALS }),
      concentric_first: S("BOOLEAN"),
      primary_muscles: S("ARRAY", { items: S("STRING", { enum: muscles }) }),
      secondary_muscles: S("ARRAY", { items: S("STRING", { enum: muscles }) }),
      bodyweight_fraction: S("NUMBER"),
      load_estimate_kg: S("NUMBER", { nullable: true }),
      rir_visual: S("INTEGER", { nullable: true }),
      form_note_ja: S("STRING"),
      confidence: S("NUMBER")
    },
    required: ["exercise_key", "exercise_name_ja", "movement_class", "signal", "concentric_first",
      "primary_muscles", "secondary_muscles", "bodyweight_fraction", "form_note_ja", "confidence"]
  });

  const prompt = [
    "あなたは筋力トレーニングのコーチです。添付は1本のトレーニング動画から時系列順に等間隔で切り出した静止画です。",
    "種目を判定し、指定のJSONで答えてください。",
    blurred ? "※プライバシー保護のため、トレーニングしている本人の周囲以外はぼかしてあります。ぼかし部分は判断材料にしないでください。" : "",
    "",
    "既知の種目キー（該当するなら必ずこのキーを使う）:",
    known.map(k => `- ${k.key}: ${k.name}`).join("\n"),
    "",
    "端末内の骨格推定で測った各信号の動き幅（angleは度、Yは胴の長さ比。repsはその信号で数えた回数）:",
    JSON.stringify(motion),
    "",
    "各フィールドの意味:",
    "- signal: 回数を数えるのに最も適した信号（elbow=肘角度, knee=膝角度, hip=股関節角度, shoulder=肩関節角度, wristY/hipY/shoulderY=手首/腰/肩の高さ）",
    "- concentric_first: 開始姿勢から最初に動く局面が短縮性（持ち上げる）なら true。例: カール・懸垂・デッドリフト=true、スクワット・ベンチプレス=false",
    "- bodyweight_fraction: 自重を負荷として使う割合（腕立て0.64、懸垂1.0、ディップス0.95、バーベル・マシン種目は0）",
    "- load_estimate_kg: プレートやダンベルの表示が読める場合のみ総重量の推定、読めなければ null",
    "- rir_visual: 最後のレップの表情・挙上速度の鈍り・フォームの崩れから見た「あと何回できたか」(0〜5)。判断できなければ null",
    "- form_note_ja: フォームについて一言（40字以内、具体的に）",
    "- confidence: 種目判定の確信度 0〜1"
  ].join("\n");

  const parts = [{ text: prompt }].concat(shots.map(d => ({ inline_data: { mime_type: "image/jpeg", data: d } })));
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema }
  });
  // busy (429/5xx) -> wait and retry once, then fall back to other flash models
  const models = [model].concat(FALLBACK.filter(m => m !== model));
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    for (let attempt = 0; attempt < (i === 0 ? 2 : 1); attempt++) {
      try { const r = await call(apiKey, models[i], body); r._model = models[i]; return r; }
      catch (e) {
        lastErr = e;
        if (!e.retry) throw e;
        await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

const FALLBACK = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-flash-latest"];

async function call(apiKey, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 40000);
  let res;
  try { res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body, signal: ctl.signal }); }
  catch (err) { const e = new Error(err.name === "AbortError" ? "Geminiの応答が遅すぎます" : "Geminiに接続できません"); e.retry = true; throw e; }
  finally { clearTimeout(timer); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Gemini ${res.status}: ${(json.error && json.error.message) || res.statusText}`);
    e.retry = res.status === 429 || res.status >= 500 || res.status === 404;
    throw e;
  }
  const c = json.candidates && json.candidates[0];
  const text = c && c.content && c.content.parts && c.content.parts.map(p => p.text || "").join("");
  if (!text) { const e = new Error("Geminiから応答がありませんでした"); e.retry = true; throw e; }
  return JSON.parse(text);
}
