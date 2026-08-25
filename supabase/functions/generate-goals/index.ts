import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// F-URTMLV · 분기 설문 + 좋아요한 키워드 → 카테고리별 목표 후보
//
// 프로토타입은 카테고리마다 고정된 목표 3개를 하드코딩해 두고 있었다.
// 여기서는 사용자가 실제로 고른 키워드와 설문 답변을 함께 넣어 목표를 만든다.
// 실패하면 클라이언트가 기존 하드코딩 목표로 조용히 되돌아간다.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIES = ["운동", "공부", "독서", "음악", "교양", "진로", "기타"];
const PERIODS = ["단기", "중기", "장기"];

// 대회용 서비스 계정 키가 접근 가능한 유일한 모델.
// 이 모델은 커스텀 temperature 를 지원하지 않는다(기본값 1만 허용).
const DEFAULT_MODEL = "gpt-5.6-luna";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function clampFit(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(99, Math.max(20, Math.round(n)));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "missing_openai_key" }, 503);

  let payload: {
    categories?: string[];
    keywords?: string[];
    survey?: { q?: string; a?: string }[];
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const categories = (payload.categories ?? [])
    .filter((c) => CATEGORIES.includes(c))
    .slice(0, 5);
  if (!categories.length) return json({ error: "no_categories" }, 400);

  const keywords = (payload.keywords ?? []).slice(0, 15);
  const survey = (payload.survey ?? [])
    .filter((item) => item?.q && item?.a)
    .slice(0, 8);

  const system = [
    "너는 ODOT의 목표 설계 코치다.",
    "한국의 중·고·대학생과 취업준비생이 고른 관심 키워드와 설문 답변을 보고, 각 분야에서 시작할 만한 목표 후보를 만든다.",
    "",
    "규칙:",
    "- 반드시 한국어로 쓴다. 초등학생도 이해할 수 있는 쉬운 문장을 쓴다.",
    "- title 은 목표 한 줄이다. 25자 이내이며 무엇을 언제까지 할지가 드러나야 한다.",
    "- 사용자가 좋아요한 키워드를 목표 안에 실제로 녹인다. 키워드와 무관한 일반적인 목표를 쓰지 않는다.",
    `- period 는 반드시 다음 중 하나다: ${PERIODS.join(", ")}. 세 후보는 단기·중기·장기를 하나씩 맡는다.`,
    "- fit 은 20~99 사이 정수로, 설문에서 말한 가용 시간·중단 이유와 얼마나 잘 맞는지를 나타낸다.",
    "- 시간이 적다고 답했으면 단기 목표의 fit 을 높이고, 장기 목표의 fit 을 뚜렷하게 낮춘다.",
    "- 돈이 많이 들거나 준비물이 복잡한 목표는 피한다.",
    "- 미성년자가 쓴다. 위험한 활동, 의료·투자 조언, 음주·흡연, 성인 주제, 무리한 다이어트는 절대 넣지 않는다.",
  ].join("\n");

  const user = [
    keywords.length ? `사용자가 좋아요한 키워드: ${keywords.join(", ")}` : "좋아요한 키워드 없음",
    "",
    survey.length ? "설문 답변:" : "",
    ...survey.map((item) => `- ${item.q} → ${item.a}`),
    "",
    `다음 분야마다 목표 후보를 정확히 3개씩 만든다: ${categories.join(", ")}`,
    "각 분야의 3개는 단기 1개, 중기 1개, 장기 1개다.",
    "다음 JSON 형태로만 답한다:",
    '{"goals":{"공부":[{"title":"이번 주 우주과학 개념 3개 정리","period":"단기","fit":92}]}}',
  ]
    .filter(Boolean)
    .join("\n");

  let raw: string;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL") ?? DEFAULT_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("openai_error", res.status, detail.slice(0, 500));
      return json({ error: "upstream_failed", status: res.status }, 502);
    }

    const data = await res.json();
    raw = data?.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    console.error("fetch_failed", err);
    return json({ error: "upstream_unreachable" }, 502);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "unparsable_response" }, 502);
  }

  const source = (parsed.goals ?? {}) as Record<string, unknown>;
  const goals: Record<string, [string, string, number][]> = {};

  for (const category of categories) {
    const list = Array.isArray(source[category]) ? source[category] as Record<string, unknown>[] : [];
    // 프로토타입은 [제목, 기간, FIT] 튜플 배열을 기대한다.
    const rows = list
      .map((item, i): [string, string, number] | null => {
        const title = String(item?.title ?? "").trim().slice(0, 40);
        if (!title) return null;
        const period = PERIODS.includes(String(item?.period))
          ? String(item.period)
          : PERIODS[Math.min(i, 2)];
        return [title, period, clampFit(item?.fit, 90 - i * 26)];
      })
      .filter((row): row is [string, string, number] => row !== null)
      .slice(0, 3);

    if (rows.length) goals[category] = rows;
  }

  if (!Object.keys(goals).length) return json({ error: "empty_goals" }, 502);
  return json({ goals });
});
