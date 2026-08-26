import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanInput, isSafeOutput } from "../_shared/safety.ts";

// F-PEBLKV · AI 프로젝트 할 일 목록 생성
// OpenAI 키는 Edge Function 시크릿에만 존재한다. 클라이언트로 절대 내려가지 않는다.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIES = ["운동", "공부", "독서", "음악", "교양", "진로", "기타"];

// 대회용 서비스 계정 키가 접근 가능한 유일한 모델. 필요하면 OPENAI_MODEL 시크릿으로 덮어쓴다.
// 이 모델은 커스텀 temperature 를 지원하지 않는다(기본값 1만 허용) — 절대 temperature 를 보내지 않는다.
const DEFAULT_MODEL = "gpt-5.6-luna";

const TASK_RANGES: Record<string, readonly [number, number]> = {
  "1일": [2, 3],
  "1주": [4, 6],
  "1개월": [6, 10],
  "3개월": [10, 16],
  "6개월": [14, 20],
};

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

  let payload: {
    duration?: string;
    category?: string;
    goal?: string;
    survey?: { q?: string; a?: string }[];
    cards?: { title?: string; intro?: string }[];
    days?: number;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const duration = TASK_RANGES[payload.duration ?? ""] ? payload.duration! : "1주";
  const category = CATEGORIES.includes(payload.category ?? "")
    ? payload.category!
    : "기타";
  const goal = cleanInput(payload.goal, 60) ?? "";
  // 할 일이 뜬구름 잡지 않으려면 재료가 필요하다.
  // 설문 답(쓸 수 있는 시간·중단 이유), 이 프로젝트를 만든 카드의 설명, 실제 기간.
  const survey = (payload.survey ?? [])
    .map((item) => ({ q: cleanInput(item?.q, 80), a: cleanInput(item?.a, 40) }))
    .filter((item): item is { q: string; a: string } => Boolean(item.q && item.a))
    .slice(0, 8);
  const cards = (payload.cards ?? [])
    .map((c) => ({ title: cleanInput(c?.title, 40), intro: cleanInput(c?.intro, 120) }))
    .filter((c): c is { title: string; intro: string } => Boolean(c.title))
    .slice(0, 2);
  // 프로젝트는 선택한 카드 한 장의 주제를 깊게 푸는 흐름이다.
  if (cards.length !== 1) return json({ error: "exactly_one_project_card_required" }, 400);
  const days = Number.isFinite(payload.days) ? Math.min(Math.max(Number(payload.days), 1), 400) : null;
  const [minTasks, maxTasks] = TASK_RANGES[duration];

  const system = [
    "너는 한국의 중학생·고등학생·대학생·취업준비생을 돕는 ODOT의 프로젝트 코치다.",
    "사용자가 선택한 프로젝트 카드 한 장을 바탕으로, 정해진 기간 안에 실제로 끝낼 수 있는 작은 프로젝트 하나와 할 일 목록을 만든다.",
    "",
    "규칙:",
    "- 반드시 한국어로 쓴다. 초등학생도 이해할 수 있는 쉬운 문장을 쓴다.",
    "- 할 일은 실행 순서대로 배열하고, 각 항목은 한 문장(40자 이내)으로 쓴다.",
    "- 기간, 설문에서 드러난 시간·선호·중단 이유, 프로젝트 난이도를 보고 필요한 단계 수를 스스로 정한다.",
    "- 단계 수를 적게 만들려고 핵심 과정을 합치거나, 많게 만들려고 의미 없는 쪼개기를 하지 않는다.",
    "",
    "구체적으로 쓰는 규칙(가장 중요):",
    "- 각 할 일에는 '무엇을'이 반드시 들어간다. 대상을 이름으로 부른다. '자료를 찾는다'가 아니라 '누리호 발사 영상 2편을 고른다'.",
    "- 각 할 일에는 분량이나 시간이 들어간다. 몇 개, 몇 쪽, 몇 분 중 하나는 반드시 밝힌다.",
    "- '알아본다', '살펴본다', '공부한다', '연습한다' 처럼 무엇을 얼마나 하는지 알 수 없는 서술어만으로 끝내지 않는다.",
    "- 첫 할 일은 앉은 자리에서 30분 안에 끝낼 수 있어야 한다. 시작 문턱을 낮춘다.",
    "- 사용자가 쓸 수 있다고 답한 시간을 넘지 않게 분량을 정한다.",
    "- '이 프로젝트를 만든 카드'가 주어지면 그 카드의 주제를 할 일 안에서 실제로 다룬다.",
    "- 카드에 없는 다른 주제·기술·교과 개념을 핵심 할 일로 끌어오지 않는다.",
    "",
    "문장이 서로 닮지 않게 하는 규칙(중요):",
    "- 단계마다 역할이 다르다. 준비 → 이해/연습 → 적용 → 점검 → 남기기 순서를 프로젝트에 맞게 쓴다.",
    "- 서술어를 반복하지 않는다. 모든 항목이 '~를 고른다 / ~한다 / ~를 정리한다'로 끝나면 안 된다.",
    "- 주제 명사를 매 문장 되풀이하지 않는다. 첫 항목에서 밝혔으면 이후에는 생략하거나 다르게 부른다.",
    "- 마지막 항목도 이 프로젝트에서만 말이 되는 내용이어야 한다. '마감 전 점검하기' 같은 어느 프로젝트에나 붙는 문장은 쓰지 않는다.",
    "",
    "- 돈이 들거나 준비물이 많이 필요한 활동은 피한다.",
    "- 미성년자가 사용하는 서비스다. 위험한 활동, 의료·투자 조언, 음주·흡연, 성인 주제, 무리한 다이어트나 단식은 절대 제안하지 않는다.",
    "- 외부 앱 결제나 개인정보 입력을 요구하는 활동은 제안하지 않는다.",
    "- 응원하는 말투를 쓰되, 부담을 주는 표현은 쓰지 않는다.",
  ].join("\n");

  const user = [
    goal ? `사용자가 고른 목표: ${goal}` : "",
    goal ? "할 일은 이 목표를 끝내기 위한 단계여야 한다. 목표와 무관한 일반적인 할 일을 쓰지 않는다." : "",
    days ? `마감까지 ${days}일` : `수행 기간: ${duration}`,
    `대표 카테고리: ${category}`,
    cards.length
      ? ["이 프로젝트를 만든 카드:", ...cards.map((c) => `- ${c.title}: ${c.intro}`)].join("\n")
      : "",
    survey.length
      ? ["설문 답변:", ...survey.map((item) => `- ${item.q} → ${item.a}`)].join("\n")
      : "",
    "",
    `할 일은 ${minTasks}~${maxTasks}개로 만든다. 기간과 설문 답에 맞는 정확한 개수는 네가 결정한다.`,
    "JSON을 내기 전에 스스로 검증한다: 카드 주제와 목표에 직접 연결되는지, 필요한 과정이 빠지지 않았는지, 순서가 자연스러운지, 각 단계가 실제로 실행 가능한지 확인한다.",
    "다음 JSON 형태로만 답한다:",
    '{"title":"프로젝트 제목(20자 이내)","category":"카테고리","keywords":["키워드"],"task_count":5,"validation":{"card_aligned":true,"goal_aligned":true,"stages_complete":true,"summary":"카드 주제를 이해하고 적용·점검·기록까지 이어집니다."},"tasks":[{"content":"할 일 한 문장","suggested_when":"권장 시점(예: 첫째 날, 이번 주말)"}]}',
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

  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const validation = parsed.validation as Record<string, unknown> | null;
  const checkedTasks = tasks.slice(0, maxTasks).map((t: Record<string, unknown>, i: number) => ({
    content: String(t?.content ?? "").slice(0, 120).trim(),
    suggested_when: String(t?.suggested_when ?? "").slice(0, 40).trim(),
    position: i,
  })).filter((t) => t.content.length > 0 && isSafeOutput(t.content, t.suggested_when));
  const uniqueTasks = new Set(checkedTasks.map((t) => t.content.replace(/\s+/g, "").toLowerCase()));
  // 모델이 task_count 또는 validation의 자기평가를 빠뜨리는 경우가 있다.
  // 실제로 저장할 할 일 목록을 서버가 직접 검사해야 일시적인 형식 편차가
  // 프로젝트 생성 실패로 이어지지 않는다.
  if (checkedTasks.length < minTasks || checkedTasks.length > maxTasks || uniqueTasks.size !== checkedTasks.length) {
    return json({ error: "invalid_task_plan" }, 502);
  }

  return json({
    title: goal || String(parsed.title ?? "작은 시작 프로젝트").slice(0, 40),
    category: CATEGORIES.includes(String(parsed.category)) ? parsed.category : category,
    duration,
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords.map(String).slice(0, 5)
      : [],
    validation: {
      summary: String(validation?.summary ?? "").slice(0, 160),
      task_count: checkedTasks.length,
      card_aligned: validation?.card_aligned === true,
      goal_aligned: validation?.goal_aligned === true,
      stages_complete: validation?.stages_complete === true,
    },
    tasks: checkedTasks,
  });
});
