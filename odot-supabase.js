/**
 * ODOT · Supabase 연동 레이어
 *
 * 설계 원칙 — "미러 + 증강"
 *  1) localStorage 는 렌더링의 source of truth 로 그대로 둔다.
 *  2) 이 모듈은 사용자의 행동을 Supabase 에 함께 기록(미러)한다.
 *  3) AI 호출(Edge Function)에 성공하면 결과를 얹고(증강), 실패하면 기존 목업으로 조용히 되돌아간다.
 *
 * → Supabase 나 OpenAI 가 죽어도 프로토타입은 오늘과 똑같이 동작한다.
 *
 * 공개 키(publishable)는 브라우저에 노출되는 것이 정상이며, 방어선은 RLS 다.
 * OpenAI 키는 이 파일에 없다. Edge Function 시크릿에만 존재한다.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://hqbbynkwxavatfariycj.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_5FIr1LRtmXwGjkJDw9G2Ug_3yqqcKFi';
const MIGRATION_FLAG = 'odot-cloud-migrated-v1';

// 초기 트렌드 카드 장수, 그리고 항상 확보해 둘 "앞선 카드" 수.
// 5장으로 시작하고, 2번 카드를 볼 때(current=1, 남은 카드 4장) 6번째를 미리 만든다.
const INITIAL_CARDS = 5;
const BUFFER_AHEAD = 4;

const Cloud = {
  client: null,
  userId: null,
  online: false,
  ai: true,
  cardIds: new Map(),        // slug -> keyword_cards.id
  keywordBySlug: new Map(),  // slug -> 키워드 문자열
  prefetching: false,

  interests() {
    return globalThis.Storage?.read?.()?.interests || [];
  },
  /** 좋아요한 카드의 키워드 목록 (to-do 생성의 재료) */
  likedKeywords() {
    const reactions = globalThis.Storage?.read?.()?.reactions || [];
    return reactions
      .filter((r) => r.type === 'like')
      .map((r) => Cloud.keywordBySlug.get(r.topicId)
        || globalThis.Catalog?.topics?.find((t) => t.id === r.topicId)?.title?.replace('\n', ' '))
      .filter(Boolean);
  },
};

/** Supabase 호출을 감싸 실패를 삼킨다. UI 흐름은 절대 막지 않는다. */
async function safe(label, run, fallback = null) {
  if (!Cloud.online) return fallback;
  try {
    return await run();
  } catch (err) {
    console.warn(`[odot-cloud] ${label} 실패`, err?.message || err);
    return fallback;
  }
}

/* ────────────────────────────── 부팅 ────────────────────────────── */

async function boot() {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'odot-auth' },
  });

  let { data: { session } } = await client.auth.getSession();

  if (!session) {
    const { data, error } = await client.auth.signInAnonymously();
    if (error) throw error;
    session = data.session;
  }
  if (!session?.user) throw new Error('세션을 만들지 못했습니다.');

  Cloud.client = client;
  Cloud.userId = session.user.id;
  Cloud.online = true;

  await cacheGlobalCards();
  await migrateLocalDataOnce();

  console.info('[odot-cloud] 연결됨 · user', Cloud.userId.slice(0, 8));
}

/** 전역 시드 카드의 slug → id 매핑을 미리 받아 둔다. */
async function cacheGlobalCards() {
  const { data, error } = await Cloud.client
    .from('keyword_cards')
    .select('id, slug')
    .is('user_id', null);
  if (error) throw error;
  data.forEach((row) => Cloud.cardIds.set(row.slug, row.id));
}

/**
 * 카드 슬러그에 해당하는 DB 행을 보장한다.
 * 시드에 없는 카드(AI 추천, 데모 카드)는 사용자 소유 카드로 만들어 준다.
 */
async function ensureCard(topic) {
  const slug = topic?.id || topic?.slug;
  if (!slug) return null;
  if (Cloud.cardIds.has(slug)) return Cloud.cardIds.get(slug);

  // 이전 세션에서 이미 만들어 둔 카드일 수 있다. 중복 행을 만들지 않는다.
  const { data: existing } = await Cloud.client
    .from('keyword_cards')
    .select('id')
    .eq('user_id', Cloud.userId)
    .eq('slug', slug)
    .maybeSingle();
  if (existing) {
    Cloud.cardIds.set(slug, existing.id);
    return existing.id;
  }

  const { data, error } = await Cloud.client
    .from('keyword_cards')
    .insert({
      user_id: Cloud.userId,
      slug,
      category: knownCategory(topic.category),
      title: topic.keyword || topic.title || Cloud.keywordBySlug.get(slug) || slug,
      intro: topic.intro || '',
      reason: topic.reason || '',
      easy: topic.easy || topic.intro || '',
      source: 'ai',
    })
    .select('id')
    .single();
  if (error) throw error;

  Cloud.cardIds.set(slug, data.id);
  return data.id;
}

function knownCategory(name) {
  const names = (globalThis.Catalog?.categories || []).map((c) => c.name);
  return names.includes(name) ? name : '기타';
}

/* ─────────────────────── localStorage 1회 이관 ─────────────────────── */

async function migrateLocalDataOnce() {
  if (localStorage.getItem(MIGRATION_FLAG)) return;

  const local = globalThis.Storage?.read?.() || {};
  await saveInterests(local.interests || []);

  const reactions = (local.reactions || []).filter((r) => r.topicId && r.type);
  for (const reaction of reactions) {
    const topic = (globalThis.Catalog?.topics || []).find((t) => t.id === reaction.topicId)
      || { id: reaction.topicId, category: reaction.category, title: reaction.topicId };
    await saveReaction(topic, reaction.type);
  }

  localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
  console.info(`[odot-cloud] 기존 기록 이관 완료 · 반응 ${reactions.length}건`);
}

/* ────────────────────────── 쓰기 (미러) ────────────────────────── */

/** F-YNUHQI · 초기 관심사 */
async function saveInterests(names) {
  return safe('saveInterests', async () => {
    await Cloud.client.from('user_interests').delete().eq('user_id', Cloud.userId);
    const rows = (names || []).slice(0, 5).map((name, position) => ({
      user_id: Cloud.userId,
      name,
      is_custom: !(globalThis.Catalog?.categories || []).some((c) => c.name === name),
      position,
    }));
    if (!rows.length) return;
    const { error } = await Cloud.client.from('user_interests').insert(rows);
    if (error) throw error;
    await Cloud.client
      .from('profiles')
      .update({ onboarding_completed: true })
      .eq('id', Cloud.userId);
  });
}

/** F-ZSDXRA · 카드 반응 */
async function saveReaction(topic, type) {
  return safe('saveReaction', async () => {
    const cardId = await ensureCard(topic);
    if (!cardId) return;
    const reaction = type === 'like' ? 'like' : type === 'pass' ? 'pass' : 'detail';
    // like/pass 는 카드당 1회만 확정된다(부분 unique 인덱스).
    // 부분 인덱스는 PostgREST 의 onConflict 로 지정할 수 없으므로 중복 오류를 그대로 흘려보낸다.
    const { error } = await Cloud.client.from('card_reactions').insert({
      user_id: Cloud.userId,
      card_id: cardId,
      category: knownCategory(topic.category),
      reaction,
    });
    if (error && error.code !== '23505') throw error;
    logEvent('card_reaction', { category: topic.category, reaction });
  });
}

/** KPI 이벤트 (PRD 4절) */
function logEvent(name, props = {}) {
  if (!Cloud.online) return;
  Cloud.client
    .from('events')
    .insert({ user_id: Cloud.userId, name, props })
    .then(({ error }) => error && console.warn('[odot-cloud] logEvent', error.message));
}

/** F-PEBLKV · 생성된 프로젝트를 DB 에 남긴다 */
async function persistProject(project, duration) {
  return safe('persistProject', async () => {
    const { data: request } = await Cloud.client
      .from('project_requests')
      .insert({ user_id: Cloud.userId, duration })
      .select('id')
      .single();

    const { data: row, error } = await Cloud.client
      .from('projects')
      .insert({
        user_id: Cloud.userId,
        request_id: request?.id ?? null,
        title: project.title,
        category: knownCategory(project.category),
        duration,
        keywords: project.keywords || [],
      })
      .select('id')
      .single();
    if (error) throw error;

    await Cloud.client.from('project_sessions').insert({
      project_id: row.id,
      user_id: Cloud.userId,
      session_key: `odot-${row.id}`,
    });

    const tasks = (project.tasks || []).map((task, position) => ({
      project_id: row.id,
      user_id: Cloud.userId,
      category: knownCategory(project.category),
      content: typeof task === 'string' ? task : task.content,
      suggested_when: typeof task === 'string' ? null : task.suggested_when || null,
      position,
    }));
    if (tasks.length) await Cloud.client.from('tasks').insert(tasks);

    logEvent('project_created', { category: project.category, duration });
    return row.id;
  });
}

/* ────────────────────────── AI (Edge Function) ────────────────────────── */

async function invoke(fn, body) {
  if (!Cloud.online || !Cloud.ai) return null;
  try {
    const { data, error } = await Cloud.client.functions.invoke(fn, { body });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  } catch (err) {
    console.warn(`[odot-cloud] ${fn} 실패 · 목업으로 대체`, err?.message || err);
    // 키 미설정처럼 반복 실패가 확실한 경우 AI 호출을 이번 세션 동안 멈춘다.
    if (String(err?.message).includes('missing_openai_key')) Cloud.ai = false;
    return null;
  }
}

/** F-PEBLKV · AI 프로젝트 생성 */
async function generateProjectViaAI({ category, duration, interests, likedTitles, goal, taskCount }) {
  const data = await invoke('generate-project', {
    category, duration, interests, likedTitles, goal, taskCount,
  });
  if (!data?.tasks?.length) return null;
  return data;
}

/** F-URTMLV · 설문 답변 + 좋아요한 키워드 → 카테고리별 목표 후보 */
async function generateGoalsViaAI({ categories, keywords, survey }) {
  const data = await invoke('generate-goals', { categories, keywords, survey });
  return data?.goals || null;
}

/** 설문 문항과 고른 답을 사람이 읽는 문장으로 되돌린다. */
function surveyAnswers() {
  const questions = globalThis.decisionQuestions || [];
  const answers = globalThis.state?.decisionAnswers || [];
  const lead = globalThis.state?.decisionLikes?.[0];
  return questions
    .map((build, i) => {
      if (answers[i] == null) return null;
      const [q, options] = build(lead);
      return { q, a: options[answers[i]] };
    })
    .filter(Boolean);
}

/**
 * AI 가 만든 할 일을 프로젝트 카드 DOM 에 적용한다.
 *
 * planStages() 는 할 일 뒤에 기간별 마무리 점검 단계를 하나 더 붙인다.
 * 그래서 카드의 단계 수는 항상 (할 일 수 + 1) 이다. 앞쪽 할 일만 교체하고
 * 마지막 마무리 단계는 프로토타입이 만든 문구 그대로 남긴다.
 */
function applyStoredTasks() {
  const saved = globalThis.Storage?.read?.()?.aiTasks || {};
  document.querySelectorAll('.separate-project').forEach((project) => {
    const tasks = saved[project.dataset.projectKey];
    if (!Array.isArray(tasks) || !tasks.length) return;
    const rows = [...project.querySelectorAll('.independent-task')];
    if (rows.length < tasks.length) return; // 예상보다 단계가 적으면 건드리지 않는다
    tasks.forEach((task, i) => {
      const label = rows[i]?.querySelector('.independent-task-copy strong');
      if (label) label.textContent = task;
      rows[i]?.querySelector('.task-check')?.setAttribute('aria-label', `${task} 완료 표시`);
    });
  });
}

/**
 * F-OVNIBD · 실시간 트렌드 기반 "키워드" 카드
 *
 * 카드에 적히는 것은 할 일이 아니라 키워드다(수학, 과학, 국어, 체육, 미술 …).
 * 좋아요한 키워드가 모여 나중에 to-do 를 만드는 재료가 된다.
 */
async function fetchKeywordCards(count) {
  const data = await invoke('trend-keywords', {
    interests: Cloud.interests(),
    likedKeywords: Cloud.likedKeywords(),
    seenKeywords: [...Cloud.keywordBySlug.values()].slice(-40),
    count,
  });
  if (!data?.cards?.length) return [];

  const palette = new Map((globalThis.Catalog?.categories || []).map((c) => [c.name, c.color]));
  return data.cards.map((card) => {
    const category = knownCategory(card.category);
    Cloud.keywordBySlug.set(card.slug, card.keyword);
    return {
      id: card.slug,
      isKeyword: true,
      keyword: card.keyword,
      category,
      color: palette.get(category) || 'gray',
      title: card.keyword, // 기존 렌더링과 호환되도록 title 에도 키워드를 넣는다
      intro: card.intro,
      reason: card.reason,
      easy: card.easy,
    };
  });
}

/* ────────────────────────── 기존 코드에 연결 ────────────────────────── */

function attach() {
  const MockAPI = globalThis.MockAPI;
  const Storage = globalThis.Storage;
  const Catalog = globalThis.Catalog;
  if (!MockAPI || !Storage) return;

  const likedContext = () => ({
    interests: Cloud.interests(),
    likedCategories: (Storage.read().reactions || [])
      .filter((r) => r.type === 'like')
      .map((r) => r.category),
    likedTitles: Cloud.likedKeywords(),
  });

  // 관심사 저장 미러
  const baseSaveInterests = MockAPI.saveInterests.bind(MockAPI);
  MockAPI.saveInterests = async (interests) => {
    const result = await baseSaveInterests(interests);
    saveInterests(interests);
    return result;
  };

  // 카드 반응 미러
  // 현재 덱을 먼저 뒤진다. 트렌드 키워드 카드는 Catalog 에 없으므로
  // 덱을 건너뛰면 제목 없는 껍데기가 넘어가 DB 에 슬러그가 제목으로 저장된다.
  const baseSaveReaction = MockAPI.saveReaction.bind(MockAPI);
  MockAPI.saveReaction = async (reaction) => {
    const result = await baseSaveReaction(reaction);
    const topic = globalThis.state?.deck?.find((c) => c.id === reaction.topicId)
      || Catalog?.topics?.find((t) => t.id === reaction.topicId)
      || { id: reaction.topicId, category: reaction.category };
    saveReaction(topic, reaction.type);
    return result;
  };

  // ── 덱: 실시간 트렌드 키워드 카드로 교체 ──────────────────────────
  // 내장 카드는 AI 가 응답하기 전까지만 보여 주는 자리 표시자로 남는다.
  const baseGetRecommendations = MockAPI.getRecommendations.bind(MockAPI);
  MockAPI.getRecommendations = async () => {
    const cards = await fetchKeywordCards(INITIAL_CARDS);
    return cards.length ? cards : baseGetRecommendations();
  };

  /**
   * 선버퍼링: 사용자가 카드를 넘기기 "전에" 다음 카드를 만들어 둔다.
   * 5장으로 시작해 2번 카드를 볼 때 6번째를 만들고, 이후로도 항상 4장을 앞서 확보한다.
   * → 카드가 넘어가는 순간 생성이 시작되지 않으므로 로딩 대기가 사라진다.
   */
  async function prefetchAhead() {
    const state = globalThis.state;
    if (!state || Cloud.prefetching || !Cloud.ai) return;
    if (!state.deck?.[state.current]?.isKeyword) return; // 아직 자리 표시자 덱이면 건너뛴다
    if (state.deck.length - state.current > BUFFER_AHEAD) return;

    Cloud.prefetching = true;
    try {
      const fresh = await fetchKeywordCards(1);
      if (fresh.length) {
        state.deck.push(...fresh);
        globalThis.renderDeck?.(); // 뒤에 쌓인 카드 미리보기를 갱신
      }
    } finally {
      Cloud.prefetching = false;
    }
  }

  // 카드를 넘길 때마다 버퍼를 채운다(응답을 기다리지 않는다).
  const baseReact = globalThis.react;
  if (typeof baseReact === 'function') {
    globalThis.react = async (type) => {
      await baseReact(type);
      prefetchAhead();
    };
  }

  // 키워드 카드는 "할 일"이 아니라 키워드가 주인공이므로 다르게 그린다.
  const baseCardHTML = globalThis.cardHTML;
  if (typeof baseCardHTML === 'function') {
    globalThis.cardHTML = (t) => {
      if (!t?.isKeyword) return baseCardHTML(t);
      const visual = (Catalog?.categories || []).find((c) => c.name === t.category)
        || (Catalog?.categories || []).at(-1);
      return `<span class="swipe-stamp pass" aria-hidden="true">PASS</span>`
        + `<span class="swipe-stamp like" aria-hidden="true">GOOD</span>`
        + `<span class="topic-tag">${t.category}</span>`
        + `<div class="kw-block"><p class="kw-label">키워드</p>`
        + `<h2 class="kw-word">${t.keyword}</h2>`
        + `<p class="sub">${t.intro}</p></div>`
        + `<p class="reason">${t.reason}</p>`
        + `<img class="topic-mascot" src="${visual.asset}" alt="${t.category} 캐릭터">`;
    };
  }

  const keywordStyle = document.createElement('style');
  keywordStyle.textContent = `
    .kw-block{display:flex;flex-direction:column;gap:6px;margin:6px 0 2px}
    .kw-label{margin:0;color:var(--muted);font-size:11px;font-weight:900;letter-spacing:.14em}
    .kw-word{margin:0;font-size:40px;line-height:1.08;letter-spacing:-1.6px;word-break:keep-all}
    @media (max-width:380px){.kw-word{font-size:33px}}
  `;
  document.head.append(keywordStyle);

  // 첫 진입: 트렌드 키워드 덱을 받아 자리 표시자를 교체한다.
  (async () => {
    const state = globalThis.state;
    const cards = await fetchKeywordCards(INITIAL_CARDS);
    if (!cards.length || !state) return;
    if (state.current > 0) return; // 이미 넘기기 시작했으면 흐름을 끊지 않는다
    state.deck = cards;
    state.current = 0;
    globalThis.renderDeck?.();
  })();

  // ── 실제 제작 흐름: 설문 → 목표 후보 → 프로젝트 ──────────────────
  // 프로토타입은 목표 후보(decisionGoals)와 할 일(Catalog.projects)을 모두
  // 카테고리별 고정 표에서 읽어 왔다. 두 지점을 AI 결과로 바꿔 끼운다.

  const PERIOD_TO_DURATION = { 단기: '1주', 중기: '1개월', 장기: '3개월' };

  /** 목표 화면을 그리기 전에 decisionGoals 를 AI 결과로 덮어쓴다. */
  const baseRenderDecisionGoals = globalThis.renderDecisionGoals;
  if (typeof baseRenderDecisionGoals === 'function') {
    globalThis.renderDecisionGoals = async () => {
      const state = globalThis.state;
      const decisionGoals = globalThis.decisionGoals;
      const categories = [...new Set((state?.decisionLikes || []).map((c) => c.category))];

      if (Cloud.ai && decisionGoals && categories.length) {
        const flow = document.querySelector('#decisionFlow');
        if (flow) {
          flow.innerHTML = '<div class="flow-card"><p class="flow-kicker">답변을 읽는 중</p>'
            + '<h2>고른 키워드에 맞는<br>목표를 만들고 있어요.</h2>'
            + '<p class="sub">잠시만 기다려 주세요.</p></div>';
        }
        const goals = await generateGoalsViaAI({
          categories,
          keywords: Cloud.likedKeywords(),
          survey: surveyAnswers(),
        });
        // 받은 카테고리만 갈아끼운다. 실패하면 기존 고정 목표가 그대로 남는다.
        if (goals) Object.assign(decisionGoals, goals);
      }

      baseRenderDecisionGoals();
      wireConfirmButton();
    };
  }

  /** 목표 확정 버튼: 프로젝트가 그려지기 전에 할 일을 미리 만들어 둔다. */
  function wireConfirmButton() {
    const confirm = document.querySelector('#decisionConfirm');
    if (!confirm || confirm.dataset.aiWired) return;
    confirm.dataset.aiWired = 'true';

    const baseOnClick = confirm.onclick;
    confirm.onclick = async (event) => {
      const picks = globalThis.state?.decisionGoalsSelected || [];
      if (!picks.length || !Cloud.ai) return baseOnClick?.call(confirm, event);

      const label = confirm.textContent;
      confirm.disabled = true;
      confirm.textContent = '할 일을 만드는 중…';
      try {
        await buildTasksFor(picks);
      } finally {
        confirm.disabled = false;
        confirm.textContent = label;
      }
      baseOnClick?.call(confirm, event);
    };
  }

  /** 선택한 목표마다 할 일을 만들어 localStorage 에 담아 둔다. */
  async function buildTasksFor(picks) {
    const interests = Cloud.interests();
    const keywords = Cloud.likedKeywords();

    const results = await Promise.all(picks.map(async (pick) => {
      const period = pick.goal?.[1];
      const ai = await generateProjectViaAI({
        category: pick.category,
        duration: PERIOD_TO_DURATION[period] || '1주',
        interests,
        likedTitles: keywords,
        goal: pick.goal?.[0],
        taskCount: 3, // 프로젝트 카드가 단계 3개로 그려진다
      });
      if (!ai?.tasks?.length) return null;
      persistProject({
        title: pick.goal?.[0] || ai.title,
        category: pick.category,
        keywords: ai.keywords?.length ? ai.keywords : keywords,
        tasks: ai.tasks,
      }, PERIOD_TO_DURATION[period] || '1주');
      return [pick.key, ai.tasks.map((t) => t.content)];
    }));

    const data = Storage.read();
    data.aiTasks = data.aiTasks || {};
    results.filter(Boolean).forEach(([key, tasks]) => { data.aiTasks[key] = tasks; });
    Storage.write(data);
  }

  // 프로젝트 카드가 그려질 때마다(신규 생성 · 앱 재시작 복원 모두) 할 일을 입힌다.
  const baseOpenDecisionProject = globalThis.openDecisionProject;
  if (typeof baseOpenDecisionProject === 'function') {
    globalThis.openDecisionProject = (...args) => {
      const result = baseOpenDecisionProject(...args);
      applyStoredTasks();
      return result;
    };
  }

  // 프로젝트 생성: AI 우선, 실패하면 기존 목업
  const baseCreateProject = MockAPI.createProject.bind(MockAPI);
  MockAPI.createProject = async ({ category, duration }) => {
    const ctx = likedContext();
    const ai = await generateProjectViaAI({
      category,
      duration,
      interests: ctx.interests,
      likedTitles: ctx.likedTitles,
    });

    if (!ai) {
      const fallback = await baseCreateProject({ category, duration });
      persistProject({ ...fallback, keywords: ctx.interests }, duration);
      return fallback;
    }

    const project = {
      id: `ai-${Date.now()}`,
      category: ai.category || category,
      duration,
      title: ai.title,
      keywords: ai.keywords || [],
      tasks: ai.tasks.map((t) => t.content),
    };

    // 로컬 저장소 형태를 그대로 유지해 기존 렌더링과 호환시킨다
    const data = Storage.read();
    data.projects = data.projects || [];
    data.projects.unshift(project);
    Storage.write(data);

    persistProject({ ...project, tasks: ai.tasks }, duration);
    return project;
  };

  // 앱 재시작 시 프로젝트 복원은 이 모듈보다 먼저 끝난다. 그 결과에도 할 일을 입힌다.
  applyStoredTasks();

  logEvent('session_start', { source: 'prototype' });
}

/* ────────────────────────── 시작 ────────────────────────── */

boot()
  .then(attach)
  .catch((err) => {
    console.warn('[odot-cloud] 오프라인 모드로 동작합니다:', err?.message || err);
  });

globalThis.OdotCloud = Cloud;
