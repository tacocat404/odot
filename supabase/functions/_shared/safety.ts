/**
 * ODOT 안전 검증
 *
 * PRD 4절 리스크: "미성년자도 사용하는 서비스이므로 연령에 부적절하거나
 * 검증되지 않은 활동 추천을 방지할 기준이 필요하다."
 *
 * 프롬프트에 "쓰지 마라"고 적어 두는 것만으로는 부족하다. 모델이 어기면
 * 그대로 통과하고, 사용자가 직접 입력한 '기타' 관심사는 아예 검사 없이
 * 프롬프트로 들어간다. 그래서 두 방향을 모두 코드로 막는다.
 *
 *   들어오는 값 — 부적절어 차단 + 프롬프트 인젝션 차단
 *   나가는 값   — 부적절어가 섞인 결과물 제거
 *
 * 완벽한 필터는 없다. 프롬프트 규칙을 대체하는 게 아니라 겹쳐 두는 층이다.
 */

/** 미성년자 대상 서비스에서 걸러야 할 표현. 자모 분리·띄어쓰기 우회를 감안해 압축 비교한다. */
const BLOCKED_TERMS = [
  // 욕설·비속어
  "시발", "씨발", "ㅅㅂ", "병신", "ㅂㅅ", "지랄", "좆", "새끼", "개새", "니미", "썅",
  "fuck", "shit", "bitch", "asshole",
  // 성인·선정
  "섹스", "야동", "포르노", "성인물", "자위", "원나잇", "조건만남", "성매매", "유흥업소",
  "sex", "porn", "nude", "hentai",
  // 약물·음주·흡연·도박
  "마약", "대마", "필로폰", "히로뽕", "코카인", "술먹", "음주", "폭음", "소주", "담배",
  "흡연", "전자담배", "도박", "베팅", "토토", "카지노",
  "weed", "cocaine", "gambling",
  // 폭력·자해
  "자살", "자해", "죽여", "죽고싶", "살인", "폭행", "칼부림", "테러", "폭탄",
  "suicide", "selfharm", "self-harm", "kill myself",
  // 혐오
  "한남", "김치녀", "장애인비하", "틀딱", "급식충", "맘충",
  // 무리한 신체 목표
  "굶기", "단식원", "먹토", "프로아나", "거식",
];

/** 프롬프트를 가로채려는 시도. 사용자 입력이 그대로 프롬프트에 들어가므로 필요하다. */
const INJECTION_PATTERNS: RegExp[] = [
  /이전\s*(의)?\s*(지시|명령|규칙)/,
  /위\s*(의)?\s*(지시|명령|규칙)/,
  /무시\s*(하고|해|하라|해라)/,
  /시스템\s*(프롬프트|메시지)/,
  /너는\s*이제/,
  /역할을?\s*(바꿔|변경)/,
  /ignore\s+(all\s+|the\s+)?(previous|above|prior)/i,
  /disregard\s+(all\s+|the\s+)?(previous|above)/i,
  /system\s*(prompt|message)/i,
  /you\s+are\s+now/i,
  /act\s+as\s+(a|an)\s/i,
  /jailbreak|dan\s+mode/i,
];

/** 비교 전에 공백·기호·대소문자를 없앤다. "시 발", "s.e.x" 같은 우회를 잡기 위해서다. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s​._\-*+/\\|()[\]{}'"`~!@#$%^&,?:;<>]/g, "");
}

/** 부적절한 표현이 들어 있는가. */
export function hasBlockedTerm(text: string): boolean {
  if (!text) return false;
  const squashed = squash(text);
  return BLOCKED_TERMS.some((term) => squashed.includes(squash(term)));
}

/** 프롬프트를 조작하려는 문장인가. */
export function hasInjection(text: string): boolean {
  if (!text) return false;
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 프롬프트에 넣어도 되는 사용자 입력인지 판단한다.
 * 통과하면 정리된 문자열을, 막히면 null 을 돌려준다.
 */
export function cleanInput(raw: unknown, maxLength = 40): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (text.length > maxLength) return null;
  if (hasBlockedTerm(text) || hasInjection(text)) return null;
  // 줄바꿈은 프롬프트 구조를 흐트러뜨린다. 한 줄로 만든다.
  return text.replace(/[\r\n]+/g, " ");
}

/** 사용자 입력 목록을 통째로 정리한다. 막힌 항목은 조용히 빠진다. */
export function cleanInputs(list: unknown, maxLength = 40, limit = 15): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => cleanInput(item, maxLength))
    .filter((item): item is string => item !== null)
    .slice(0, limit);
}

/** AI 결과물을 내보내도 되는가. 인젝션은 출력에서 문제되지 않으므로 부적절어만 본다. */
export function isSafeOutput(...parts: unknown[]): boolean {
  return !parts.some((part) => hasBlockedTerm(String(part ?? "")));
}
