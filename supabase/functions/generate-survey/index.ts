import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanInput, cleanInputs, isSafeOutput } from "../_shared/safety.ts";

// F-URTMLV · 좋아요한 키워드로 분기 설문 문항 만들기
//
// 프로토타입은 6문항을 상수로 들고 있었고, 첫 문항만 "첫 번째 카드"의 제목을
// 끼워 넣었다. 카드를 몇 장 고르든 나머지 5문항은 늘 같은 문장이었다.
// 여기서는 좋아요한 키워드 전체를 넣어 문항을 다시 쓴다.
//
// 공통 축(가용 시간·중단 이유)은 유지한다. 목표의 FIT 계산이 이 답에 기댄다.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 대회용 서비스 계정 키가 접근 가능한 유일한 모델.
// 이 모델은 커스텀 temperature 를 지원하지 않는다(기본값 1만 허용).
const DEFAULT_MODEL = "gpt-5.6-luna";

const QUESTION_COUNT = 6;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "missing_openai_key" }, 503);

  let payload: { keywords?: string[]; categories?: string[]; focus?: string; focusIntro?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const keywords = cleanInputs(payload.keywords, 30, 10);
  const categories = cleanInputs(payload.categories, 20, 5);
  // 사용자가 "지금 가장 끌린다"고 직접 고른 주제. 있으면 질문을 여기로 파고든다.
  const focus = cleanInput(payload.focus, 40);
  const focusIntro = cleanInput(payload.focusIntro, 120) ?? "";
  if (!keywords.length) return json({ error: "no_keywords" }, 400);

  const system = [
    "너는 ODOT의 설문 설계자다.",
    "사용자가 발견 탭에서 좋아요한 키워드를 보고, 어떤 목표가 맞을지 알아내는 질문 6개를 만든다.",
    "",
    "반드시 지킬 것:",
    `- 질문은 정확히 ${QUESTION_COUNT}개, 보기는 질문마다 정확히 4개다.`,
    "- 반드시 한국어로 쓴다. 중·고등학생이 바로 이해할 수 있는 문장을 쓴다.",
    "- 질문은 40자 이내, 보기는 각 15자 이내다.",
    "",
    "질문 구성:",
    focus
      ? `- 사용자는 '${focus}'를 지금 가장 끌리는 주제로 직접 골랐다. 질문은 이 주제 안으로 파고든다.`
      : "- 키워드가 2개 이상이면 비교 질문을 최소 1개 넣는다. 보기에 실제 키워드를 쓴다.",
    focus
      ? "- 이미 고른 주제를 다시 묻지 않는다. '무엇에 끌리나요' 같은 질문은 넣지 않는다."
      : "",
    focus
      ? [
        "- 다음 네 가지를 이 주제에 맞게 구체적으로 묻는다:",
        `  · '${focus}' 안에서 어느 갈래가 더 궁금한지 (보기는 실제 세부 갈래 이름)`,
        "  · 지금 어느 정도까지 아는지 (처음 → 익숙함 순서)",
        "  · 어떤 방식으로 하고 싶은지 (읽기·보기·직접 해보기·기록하기 등 실제 방법)",
        "  · 끝났을 때 무엇이 남으면 좋을지 (이 주제에서 실제로 남을 수 있는 것)",
      ].join("\n")
      : "",
    "- 다음 두 축은 반드시 포함한다. 다만 문장은 주제에 맞게 다시 쓴다.",
    "  · 일주일에 쓸 수 있는 시간 (보기는 적은 시간 → 많은 시간 순서)",
    "  · 중간에 멈추게 되는 이유 (보기는 이 주제에서 실제로 막힐 만한 지점)",
    "- 어느 주제에나 붙는 일반적인 질문은 쓰지 않는다.",
    "- 6개 질문이 서로 같은 형식으로 시작하지 않게 한다.",
    "",
    "- 미성년자가 쓴다. 위험한 활동, 의료·투자 조언, 음주·흡연, 성인 주제, 외모·체중 평가는 절대 넣지 않는다.",
  ].join("\n");

  const user = [
    focus ? `지금 가장 끌리는 주제: ${focus}${focusIntro ? ` (${focusIntro})` : ""}` : "",
    `이번 프로젝트 카드: ${keywords.join(", ")}`,
    categories.length ? `해당 분야: ${categories.join(", ")}` : "",
    "",
    `질문 ${QUESTION_COUNT}개를 만든다.`,
    "다음 JSON 형태로만 답한다:",
    '{"questions":[{"q":"질문 한 줄","options":["보기1","보기2","보기3","보기4"]}]}',
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

  const list = Array.isArray(parsed.questions) ? parsed.questions : [];
  const questions = list
    .map((item: Record<string, unknown>) => {
      const q = String(item?.q ?? "").trim().slice(0, 60);
      const options = Array.isArray(item?.options)
        ? item.options.map((o: unknown) => String(o).trim().slice(0, 24)).filter(Boolean)
        : [];
      // 화면이 보기 4개를 그리므로 개수가 어긋나면 버린다.
      if (!q || options.length !== 4) return null;
      if (!isSafeOutput(q, ...options)) { console.warn("blocked_question", q); return null; }
      return { q, options };
    })
    .filter(Boolean)
    .slice(0, QUESTION_COUNT);

  // 일부만 온 설문은 흐름을 망가뜨린다. 전부 갖췄을 때만 쓴다.
  if (questions.length !== QUESTION_COUNT) return json({ error: "incomplete_survey" }, 502);
  return json({ questions });
});
