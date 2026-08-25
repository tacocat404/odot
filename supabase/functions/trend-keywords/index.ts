import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanInputs, isSafeOutput } from "../_shared/safety.ts";

// F-OVNIBD · 실시간 트렌드 기반 "키워드" 카드 생성
//
// 카드에 적히는 것은 할 일이 아니라 키워드다(수학, 과학, 국어, 체육, 미술 …).
// 사용자가 좋아요한 키워드들을 조합해 나중에 to-do 를 만든다.
//
// 트렌드 소스: Google Trends 일간 인기 검색어 RSS (한국, 인증 불필요, 실시간).
// 원본 트렌드는 인물/연예 뉴스가 많으므로, LLM 이 이를 "배울 수 있는 키워드"로 옮긴다.
//   예) 장원영 → K팝 보컬(음악)
// 트렌드 호출이 실패하면 관심사 기반 키워드 생성으로 조용히 대체한다.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIES = ["운동", "공부", "독서", "음악", "교양", "진로", "기타"];

// 대회용 서비스 계정 키가 접근 가능한 유일한 모델.
// 이 모델은 커스텀 temperature 를 지원하지 않는다(기본값 1만 허용).
const DEFAULT_MODEL = "gpt-5.6-luna";

const TRENDS_RSS = "https://trends.google.com/trending/rss?geo=KR";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function slugify(seed: string, index: number) {
  const hash = Array.from(seed).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `kw-${hash.toString(36)}-${index}`;
}

/** Google Trends RSS 에서 인기 검색어만 뽑아 온다. 실패는 빈 배열로 흡수한다. */
async function fetchTrends(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(TRENDS_RSS, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];

    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    return items
      .map((item) => item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "")
      .map((t) => t.replace(/<!\[CDATA\[|\]\]>/g, "").trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch (err) {
    console.warn("trends_unreachable", String(err));
    return [];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "missing_openai_key" }, 503);

  let payload: {
    interests?: string[];
    likedKeywords?: string[];
    seenKeywords?: string[];
    doneProjects?: string[];
    savedCards?: string[];
    count?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // 사용자가 직접 친 '기타' 관심사가 여기 섞여 들어온다. 그대로 프롬프트에 넣지 않는다.
  const interests = cleanInputs(payload.interests, 20, 5);
  const liked = cleanInputs(payload.likedKeywords, 30, 15);
  const seen = cleanInputs(payload.seenKeywords, 30, 40);
  const doneProjects = cleanInputs(payload.doneProjects, 60, 10);
  const savedCards = cleanInputs(payload.savedCards, 40, 12);
  const count = Math.min(Math.max(payload.count ?? 5, 1), 8);

  const trends = await fetchTrends();

  /**
   * 소스를 명시적으로 배분한다. 트렌드는 넷 중 하나일 뿐이다.
   * 카드 수가 5장보다 적으면 앞쪽 소스부터 채운다.
   */
  const plan: string[] = [];
  const hasHistory = doneProjects.length > 0;
  const hasLiked = liked.length > 0 || savedCards.length > 0;

  if (hasHistory) plan.push("나의 궤적", "나의 궤적");
  if (hasLiked) plan.push("취향 심화");
  if (trends.length) plan.push("실시간 트렌드");
  plan.push("넓히기");
  // 남는 자리는 취향 심화 → 넓히기 순으로 메운다.
  while (plan.length < count) plan.push(hasLiked ? "취향 심화" : "넓히기");
  plan.length = count;

  const planLines = plan
    .map((source, i) => `${i + 1}번 카드 — ${source}`)
    .join("\n");

  const system = [
    "너는 ODOT의 키워드 카드 추천기다.",
    "한국의 중·고·대학생과 취업준비생에게 '배우거나 해볼 만한 주제'를 키워드 형태로 보여 준다.",
    "",
    "가장 중요한 규칙:",
    "- keyword 는 할 일 문장이 아니라 '명사 키워드'다. 예: 수학, 물리, 한국사, 클래식 기타, 사진 구도, 면접 스피치.",
    "- keyword 는 2~10자 사이의 짧은 한국어 명사구다. 문장이나 동사로 끝내지 않는다.",
    "- '~하기', '~해보기', '~읽기' 같은 할 일 표현은 절대 쓰지 않는다.",
    "",
    "그 밖의 규칙:",
    "- 반드시 한국어로 쓴다.",
    `- category 는 반드시 다음 중 하나다: ${CATEGORIES.join(", ")}`,
    "- intro 는 그 키워드가 무엇인지 한 문장(30자 이내)으로 설명한다.",
    "- easy 는 초등학생도 이해할 수 있는 1~2문장 설명이다.",
    "- 미성년자가 쓴다. 위험한 활동, 의료·투자 조언, 음주·흡연, 성인 주제, 무리한 다이어트, 특정 인물 비방은 절대 넣지 않는다.",
    "- 실존 인물 이름 자체를 keyword 로 쓰지 않는다. 그 인물과 연결되는 '배울 수 있는 분야'로 바꾼다. 예: 축구 선수 → 축구 전술.",
    "",
    "카드마다 정해진 소스가 있다. 소스를 지켜서 만들고 reason 에 그 소스를 밝힌다:",
    "- 나의 궤적 → 사용자가 이미 끝낸 프로젝트에서 자연스럽게 이어질 다음 주제. reason: '끝낸 프로젝트에서 이어져 · <프로젝트 제목>'",
    "- 취향 심화 → 좋아요한 키워드나 관심 카드함에 보관 중인 카드보다 한 단계 깊거나 구체적인 키워드. reason: '좋아한 <키워드>에서 한 걸음 더'",
    "- 실시간 트렌드 → 지금 검색되는 말에서 배울 거리로 옮긴 것. reason: '실시간 트렌드 · <원본 검색어>'",
    "- 넓히기 → 아직 반응이 없던 분야에서 하나. reason: '아직 안 본 분야 · <분야>'",
  ].join("\n");

  const user = [
    doneProjects.length ? `사용자가 끝낸 프로젝트: ${doneProjects.join(" / ")}` : "",
    savedCards.length ? `관심 카드함에 보관 중인 카드: ${savedCards.join(" / ")}` : "",
    interests.length ? `사용자가 고른 관심 분야: ${interests.join(", ")}` : "",
    liked.length ? `사용자가 좋아요한 키워드: ${liked.join(", ")}` : "",
    trends.length ? `지금 한국에서 실시간으로 많이 검색되는 말: ${trends.join(", ")}` : "",
    seen.length ? `이미 보여 준 키워드(중복 금지): ${seen.join(", ")}` : "",
    "",
    `서로 다른 키워드 카드 ${count}개를 만든다. 각 카드의 소스는 다음과 같이 정해져 있다:`,
    planLines,
    "",
    "다음 JSON 형태로만 답한다:",
    '{"cards":[{"keyword":"한국사","category":"공부","intro":"우리나라의 지난 이야기를 다루는 과목.","reason":"실시간 트렌드 · 광복절","easy":"옛날에 우리나라에서 있었던 일을 배우는 거예요."}]}',
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
      const keyword = String(c?.keyword ?? "").trim().slice(0, 20);
      if (!keyword) return null;
      const category = CATEGORIES.includes(String(c?.category)) ? String(c.category) : "기타";
      // 프롬프트 규칙을 어긴 결과가 화면과 DB 로 나가지 않게 마지막으로 한 번 더 거른다.
      if (!isSafeOutput(keyword, c?.intro, c?.easy, c?.reason)) {
        console.warn("blocked_output", keyword);
        return null;
      }
      return {
        slug: slugify(keyword, i),
        keyword,
        category,
        intro: String(c?.intro ?? "").slice(0, 120),
        reason: String(c?.reason ?? `새로운 추천 · ${category}`).slice(0, 60),
        easy: String(c?.easy ?? "").slice(0, 300),
      };
    })
    .filter(Boolean);

  if (!cards.length) return json({ error: "empty_cards" }, 502);
  return json({ cards, trendCount: trends.length });
});
