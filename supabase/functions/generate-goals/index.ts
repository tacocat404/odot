import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanInput, isSafeOutput } from "../_shared/safety.ts";

// F-URTMLV · 프로젝트 카드 + 설문 → 카테고리별 목표 후보
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
    survey?: { q?: string; a?: string }[];
    cards?: { title?: string; category?: string; intro?: string }[];
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // 이번 프로젝트를 만드는 카드. 분야별 목표는 그 분야의 카드에서만 나와야 한다.
  const cards = (payload.cards ?? [])
    .map((c) => ({
      title: cleanInput(c?.title, 40),
      category: CATEGORIES.includes(String(c?.category)) ? String(c.category) : null,
      intro: cleanInput(c?.intro, 120) ?? "",
    }))
    .filter((c): c is { title: string; category: string; intro: string } =>
      Boolean(c.title && c.category))
    .slice(0, 12);
  if (!cards.length) return json({ error: "no_project_cards" }, 400);

  // 요청한 분야도 실제 프로젝트 카드가 가진 분야 안에서만 허용한다.
  const cardCategories = new Set(cards.map((card) => card.category));
  const categories = (payload.categories ?? [])
    .filter((c) => CATEGORIES.includes(c) && cardCategories.has(c))
    .slice(0, 5);
  if (!categories.length) return json({ error: "no_project_card_categories" }, 400);

  const cardLines = CATEGORIES
    .map((cat) => {
      const mine = cards.filter((c) => c.category === cat);
      if (!mine.length) return "";
      return `${cat}: ${mine.map((c) => (c.intro ? `${c.title}(${c.intro})` : c.title)).join(", ")}`;
    })
    .filter(Boolean);
  // 설문 문항·답도 사용자 입력에서 파생되므로 함께 검사한다.
  const survey = (payload.survey ?? [])
    .map((item) => ({ q: cleanInput(item?.q, 80), a: cleanInput(item?.a, 40) }))
    .filter((item): item is { q: string; a: string } => Boolean(item.q && item.a))
    .slice(0, 8);

  const system = [
    "너는 ODOT의 목표 설계 코치다.",
    "한국의 중·고·대학생과 취업준비생이 고른 관심 키워드와 설문 답변을 보고, 각 분야에서 시작할 만한 목표 후보를 만든다.",
    "",
    "규칙:",
    "- 반드시 한국어로 쓴다. 초등학생도 이해할 수 있는 쉬운 문장을 쓴다.",
    "- title 은 목표 한 줄이다. 25자 이내이며 무엇을 언제까지 할지가 드러나야 한다.",
    "- 분야별 카드가 주어지면, 그 분야의 목표는 반드시 '그 분야의 카드'에서만 만든다.",
    "- 다른 분야의 카드나 예전에 좋아요한 주제를 끌어와 쓰지 않는다. 이번에 고른 카드가 전부다.",
    "- 카드 주제를 목표 안에 실제로 녹인다. 카드와 무관한 일반적인 목표를 쓰지 않는다.",
    "- source_card 에는 이 목표를 만든 프로젝트 카드 제목을 원문 그대로 하나 넣는다. 다른 카드 제목은 쓰지 않는다.",
    "",
    "제목이 서로 닮지 않게 하는 규칙(가장 중요):",
    "- 한 분야의 세 후보는 아래 세 형태를 '하나씩' 맡는다. 셋 다 같은 형태면 실패다.",
    "  · 수량형 — 무엇을 몇 개. 예: '이번 주 물리 공식 5개 손으로 풀기'",
    "  · 상태형 — 어떤 상태에 이르기. 예: '한 달 뒤 코드 없이 회로도 읽기'",
    "  · 산출물형 — 무엇을 만들어 남기기. 예: '3개월 뒤 나만의 관측 일지 한 권'",
    "- 한 분야 안에서 세 제목의 마지막 낱말이 서로 달라야 한다. 셋 다 '정리', 셋 다 '배포'처럼 끝나면 안 된다.",
    "- 설문에서 원하는 결과물을 말했더라도, 그 낱말을 세 후보에 모두 붙이지 않는다. 한 후보에만 쓴다.",
    "- '이번 주 <주제> <숫자>개 정리' 한 가지 틀만 반복하면 안 된다.",
    `- period 는 반드시 다음 중 하나다: ${PERIODS.join(", ")}. 세 후보는 단기·중기·장기를 하나씩 맡는다.`,
    "- fit 은 20~99 사이 정수로, 설문에서 말한 가용 시간·중단 이유와 얼마나 잘 맞는지를 나타낸다.",
    "- 시간이 적다고 답했으면 단기 목표의 fit 을 높이고, 장기 목표의 fit 을 뚜렷하게 낮춘다.",
    "- 돈이 많이 들거나 준비물이 복잡한 목표는 피한다.",
    "- 미성년자가 쓴다. 위험한 활동, 의료·투자 조언, 음주·흡연, 성인 주제, 무리한 다이어트는 절대 넣지 않는다.",
  ].join("\n");

  const user = [
    ["이번 프로젝트를 만드는 카드(분야별):", ...cardLines].join("\n"),
    "",
    survey.length ? "설문 답변:" : "",
    ...survey.map((item) => `- ${item.q} → ${item.a}`),
    "",
    `다음 분야마다 목표 후보를 정확히 3개씩 만든다: ${categories.join(", ")}`,
    "각 분야의 3개는 단기 1개, 중기 1개, 장기 1개다.",
    "다음 JSON 형태로만 답한다:",
    '{"goals":{"공부":[{"title":"이번 주 우주과학 개념 3개 정리","period":"단기","fit":92,"source_card":"우주과학 다큐 한 편 보기"}]}}',
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
    const sourceTitles = new Set(cards.filter((card) => card.category === category).map((card) => card.title));
    // 프로토타입은 [제목, 기간, FIT] 튜플 배열을 기대한다.
    const rows = list
      .map((item, i): [string, string, number] | null => {
        const title = String(item?.title ?? "").trim().slice(0, 40);
        if (!title) return null;
        if (!sourceTitles.has(String(item?.source_card ?? "").trim())) return null;
        if (!isSafeOutput(title)) { console.warn("blocked_goal", title); return null; }
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
