import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// F-OVNIBD · 추천 키워드 카드 생성
// 시드 카드를 모두 소진한 사용자에게 새 카드를 계속 만들어 준다.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIES = ["운동", "공부", "독서", "음악", "교양", "진로", "기타"];

// 대회용 서비스 계정 키가 접근 가능한 유일한 모델. 필요하면 OPENAI_MODEL 시크릿으로 덮어쓴다.
// 이 모델은 커스텀 temperature 를 지원하지 않는다(기본값 1만 허용) — 절대 temperature 를 보내지 않는다.
const DEFAULT_MODEL = "gpt-5.6-luna";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function slugify(seed: string, index: number) {
  const hash = Array.from(seed).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `ai-${hash.toString(36)}-${index}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "missing_openai_key" }, 503);

  let payload: {
    interests?: string[];
    likedCategories?: string[];
    seenTitles?: string[];
    count?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const interests = (payload.interests ?? []).slice(0, 5);
  const liked = (payload.likedCategories ?? []).slice(0, 10);
  const seenTitles = (payload.seenTitles ?? []).slice(0, 24);
  const count = Math.min(Math.max(payload.count ?? 5, 1), 8);

  const system = [
    "너는 ODOT의 키워드 카드 추천기다.",
    "한국의 중·고·대학생과 취업준비생이 '지금 해볼 만한 일'을 발견하도록 짧고 구체적인 활동 주제를 제안한다.",
    "",
    "규칙:",
    "- 반드시 한국어로 쓴다.",
    `- category는 반드시 다음 중 하나다: ${CATEGORIES.join(", ")}`,
    "- title은 두 줄로 나누며 줄바꿈(\\n) 하나를 포함한다. 한 줄은 12자 이내.",
    "- intro는 한 문장(30자 이내), easy는 초등학생도 이해하는 1~2문장 설명이다.",
    "- reason은 '선택한 관심사 · 운동' 처럼 추천 근거를 짧게 쓴다.",
    "- 돈이 많이 들거나 준비물이 복잡한 활동은 피한다.",
    "- 미성년자가 사용한다. 위험한 활동, 의료·투자 조언, 음주·흡연, 성인 주제, 무리한 다이어트는 절대 제안하지 않는다.",
  ].join("\n");

  const user = [
    interests.length ? `사용자가 고른 관심 분야: ${interests.join(", ")}` : "관심 분야 정보 없음",
    liked.length ? `최근 좋아요한 카테고리: ${liked.join(", ")}` : "",
    seenTitles.length ? `이미 본 주제(중복 금지): ${seenTitles.join(" / ")}` : "",
    "",
    `서로 다른 카드 ${count}개를 만든다. 관심 분야를 중심으로 하되 한 개는 새로운 분야를 섞는다.`,
    "다음 JSON 형태로만 답한다:",
    '{"cards":[{"category":"운동","title":"첫줄\\n둘째줄","intro":"한 문장","reason":"추천 근거","easy":"쉬운 설명"}]}',
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

  const list = Array.isArray(parsed.cards) ? parsed.cards : [];
  const cards = list
    .map((c: Record<string, unknown>, i: number) => {
      const category = CATEGORIES.includes(String(c?.category)) ? String(c.category) : "기타";
      const title = String(c?.title ?? "").slice(0, 60);
      if (!title) return null;
      return {
        slug: slugify(title, i),
        category,
        title,
        intro: String(c?.intro ?? "").slice(0, 120),
        reason: String(c?.reason ?? `새로운 추천 · ${category}`).slice(0, 60),
        easy: String(c?.easy ?? "").slice(0, 300),
      };
    })
    .filter(Boolean);

  if (!cards.length) return json({ error: "empty_cards" }, 502);
  return json({ cards });
});
