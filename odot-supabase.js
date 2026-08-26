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

// 초기 트렌드 카드 장수, 그리고 항상 확보해 둘 "앞선 카드" 수.
// 5장으로 시작하고, 2번 카드를 볼 때(current=1, 남은 카드 4장) 6번째를 미리 만든다.
const INITIAL_CARDS = 5;
const BUFFER_AHEAD = 4;
const MAX_PARALLEL_FETCH = 2;

const Cloud = {
  client: null,
  userId: null,
  online: false,
  ai: true,
  cardIds: new Map(),        // slug -> keyword_cards.id
  keywordBySlug: new Map(),  // slug -> 키워드 문자열
  inFlight: 0,               // 진행 중인 카드 생성 요청 수
  survey: null,              // 미리 만들어 둔 설문 문항
  surveySignature: null,     // 그 설문을 만든 카드·초점 조합
  surveyRequest: null,       // 진행 중인 요청 { signature, promise }
  surveyPending: false,
  projectCards: [],          // 이번 흐름에서만 고른 프로젝트 카드 (관심 카드와 분리)

  interests() {
    return globalThis.Storage?.read?.()?.interests || [];
  },
  /**
   * '기타'에 직접 적은 관심사.
   * 7개 카테고리 이름이 아닌 것은 사용자가 손으로 넣은 주제다.
   * 이건 분야가 정해져 있지 않으므로, 카드 생성 때 여러 분야로 펼쳐 준다.
   */
  customInterests() {
    const known = new Set((globalThis.Catalog?.categories || []).map((c) => c.name));
    return (globalThis.Storage?.read?.()?.interests || []).filter((name) => !known.has(name));
  },
  /**
   * 끝낸 프로젝트 제목 (추천의 "나의 궤적" 소스).
   * 아카이브에 보관된 완료 프로젝트와, 할 일을 모두 끝낸 진행 프로젝트를 함께 본다.
   */
  doneProjects() {
    const data = globalThis.Storage?.read?.() || {};
    const archived = (data.completedProjects || []).map((p) => p.title);
    const finished = (data.activeProjects || [])
      .filter((p) => (p.done || []).length && (p.done || []).length >= (data.aiTasks?.[p.key] || []).length)
      .map((p) => p.goal?.[0])
      .filter(Boolean);
    return [...new Set([...archived, ...finished])].slice(0, 10);
  },
  /**
   * 관심 카드 — 프로필 카드함에 보관 중인 카드.
   *
   * 쓰이는 곳은 '카드 생성'뿐이다. 무엇을 더 보여 줄지 고를 때 취향으로 참고한다.
   * 프로젝트를 만들 때는 쓰지 않는다. 그건 프로젝트 카드의 몫이다.
   */
  savedCards() {
    const cards = globalThis.Storage?.read?.()?.cardStore?.cards || [];
    return [...new Set(cards.map((c) => String(c.title || '').replace('\n', ' ').trim()))]
      .filter(Boolean)
      .slice(0, 12);
  },
  /**
   * 지금까지 좋아요한 키워드 전체.
   * 이것도 '카드 생성'에서만 쓴다. 프로젝트 생성에 넣으면 이번에 고르지 않은
   * 예전 주제가 목표와 할 일에 섞여 들어온다.
   */
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

/**
 * 계정이 있어야 앱을 쓴다. 익명 세션은 만들지 않는다.
 * 로그인 화면은 세션 없이도 떠야 하므로 클라이언트만 먼저 세운다.
 */
async function boot() {
  Cloud.client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'odot-auth' },
  });

  const { data: { session } } = await Cloud.client.auth.getSession();
  if (session?.user) await activateSession(session.user);
  else console.info('[odot-cloud] 로그인 필요');
}

/** 로그인된 사용자로 앱을 켠다. 로그인·회원가입 직후에도 호출한다. */
async function activateSession(user) {
  Cloud.userId = user.id;
  Cloud.online = true;

  await cacheGlobalCards();
  await hydrateFromCloud();

  console.info('[odot-cloud] 연결됨 · user', Cloud.userId.slice(0, 8));
}

/**
 * 계정이 바뀌면 화면이 읽는 로컬 데이터도 갈아엎는다.
 * localStorage 가 렌더링의 기준이므로, 지우지 않으면 앞 계정의 카드와
 * 프로젝트가 새 계정 화면에 그대로 남는다.
 */
function resetLocalState() {
  // 프로필도 계정에 딸린 값이다. 남겨 두면 앞 계정의 이름·아바타가 그대로 보인다.
  globalThis.Storage?.write?.({ interests: [], reactions: [], projects: [] });

  Cloud.keywordBySlug.clear();
  Cloud.survey = null;
  Cloud.surveySignature = null;
  Cloud.projectCards = [];
  // 목표 표는 전역이라 비우지 않으면 앞 계정의 목표가 다음 계정에 남는다.
  if (globalThis.decisionGoals) {
    Object.keys(globalThis.decisionGoals).forEach((k) => { delete globalThis.decisionGoals[k]; });
  }
  if (globalThis.state) {
    globalThis.state.interests = [];
    globalThis.state.deck = [];
    globalThis.state.current = 0;
    globalThis.state.decisionLikes = [];
    globalThis.state.decisionGoalsSelected = [];
  }
}

/** 로그인한 계정의 기록을 로컬로 되살린다(다른 기기에서 쓰던 계정 대비). */
async function hydrateFromCloud() {
  return safe('hydrateFromCloud', async () => {
    const [interestRows, reactionRows] = await Promise.all([
      Cloud.client.from('user_interests').select('name').eq('user_id', Cloud.userId).order('position'),
      Cloud.client
        .from('card_reactions')
        .select('reaction, category, created_at, keyword_cards(slug, title)')
        .eq('user_id', Cloud.userId)
        .order('created_at'),
    ]);

    const store = globalThis.Storage?.read?.() || {};
    store.interests = (interestRows.data || []).map((r) => r.name);
    store.reactions = (reactionRows.data || [])
      .filter((r) => r.keyword_cards?.slug)
      .map((r) => {
        // 좋아요한 키워드를 다시 쓸 수 있도록 슬러그 → 키워드 표를 채운다.
        Cloud.keywordBySlug.set(r.keyword_cards.slug, r.keyword_cards.title);
        return {
          topicId: r.keyword_cards.slug,
          category: r.category,
          type: r.reaction,
          at: r.created_at,
        };
      });
    globalThis.Storage?.write?.(store);

    if (globalThis.state) globalThis.state.interests = store.interests;
    await hydrateProjects();
    hydrateCardBox();
  });
}

/**
 * 복원한 프로젝트를 화면에 실제로 그린다.
 *
 * 프로토타입은 페이지가 열릴 때 한 번 복원을 시도하는데, 그 시점에는 이 모듈이
 * 아직 DB 에서 아무것도 가져오지 않았다. 그래서 내려받은 뒤 다시 그려 줘야 한다.
 */
function renderRestoredProjects() {
  const store = globalThis.Storage?.read?.() || {};
  if (!(store.activeProjects || []).length) return;
  if (!globalThis.openDecisionProject || !globalThis.state) return;

  // 복원은 화면을 가로채면 안 된다. 프로토타입의 복원 경로와 같은 방식으로 막는다.
  const screen = document.querySelector('.screen.active')?.id;
  const realShowScreen = globalThis.showScreen;
  const realToast = globalThis.toast;
  globalThis.showScreen = () => {};
  globalThis.toast = () => {};
  try {
    globalThis.state.decisionGoalsSelected = [];
    globalThis.openDecisionProject();
  } catch (err) {
    console.warn('[odot-cloud] 프로젝트 복원 실패', err?.message || err);
  } finally {
    globalThis.showScreen = realShowScreen;
    globalThis.toast = realToast;
  }
  if (screen) realShowScreen?.(screen);
  globalThis.syncProjectCandidates?.();
}

/**
 * 진행 중 프로젝트와 할 일을 DB 에서 로컬로 되살린다.
 *
 * 화면은 localStorage 의 activeProjects · aiTasks · aiTaskIds 를 읽는다.
 * 이걸 복원하지 않으면 다른 기기에서 로그인했을 때 프로젝트 탭이 비어 보인다.
 */
async function hydrateProjects() {
  return safe('hydrateProjects', async () => {
    const [projectRes, noteRes] = await Promise.all([
      Cloud.client
        .from('projects')
        .select('id, client_key, title, category, period, started_on, completed_at, keywords, tasks(id, content, position, suggested_when, completed_at)')
        .eq('user_id', Cloud.userId)
        .not('client_key', 'is', null)
        .order('started_on'),
      Cloud.client
        .from('task_notes')
        .select('note, noted_on, task_id')
        .eq('user_id', Cloud.userId)
        .order('noted_on'),
    ]);
    if (projectRes.error) throw projectRes.error;
    const projects = projectRes.data || [];
    if (!projects.length) return;

    const notesByTask = new Map();
    (noteRes.data || []).forEach((n) => {
      if (!notesByTask.has(n.task_id)) notesByTask.set(n.task_id, []);
      notesByTask.get(n.task_id).push(n);
    });

    const store = globalThis.Storage?.read?.() || {};
    store.aiTasks = store.aiTasks || {};
    store.aiTaskIds = store.aiTaskIds || {};
    const active = [];
    const done = [];
    const notes = [];
    const checkins = [];
    const sourceByKey = {};

    projects.forEach((project) => {
      const key = project.client_key;
      const tasks = (project.tasks || []).slice().sort((a, b) => a.position - b.position);
      store.aiTasks[key] = tasks.map((t) => t.content);
      store.aiTaskIds[key] = tasks.map((t) => t.id);

      // 오늘의 한 줄은 화면(taskNotes)과 연결 스트릭(checkins) 양쪽이 읽는다.
      tasks.forEach((task, index) => {
        (notesByTask.get(task.id) || []).forEach((n) => {
          notes.push({ project: key, task: index, date: n.noted_on, note: n.note });
          checkins.push({ project: key, date: n.noted_on, kind: 'task-note', note: n.note });
        });
      });

      if (project.completed_at) {
        // 아카이브와 밍밍이 색이 읽는 완료 프로젝트 형태로 되돌린다.
        done.push({
          id: `cloud:${project.id}`,
          key,
          category: project.category,
          title: project.title,
          period: project.period || '단기',
          completedAt: String(project.completed_at).slice(0, 10),
          milestones: tasks.map((task, i) => ({
            order: i + 1,
            title: task.content,
            planned: task.suggested_when || '',
            note: (notesByTask.get(task.id) || [])[0]?.note || '',
            recordedAt: (notesByTask.get(task.id) || [])[0]?.noted_on
              || String(task.completed_at || project.completed_at).slice(0, 10),
          })),
          dailyNotes: tasks.flatMap((task) =>
            (notesByTask.get(task.id) || []).map((n) => ({ date: n.noted_on, note: n.note }))),
          sourceCards: (project.keywords || []).map((word, i) => ({
            id: `cloud-${project.id}-${i}`,
            category: project.category,
            title: word,
            intro: '',
            reason: `${project.category} · 이 프로젝트를 만든 카드`,
          })),
        });
        return;
      }

      // 이 프로젝트를 만든 카드도 되살린다. 없으면 카드 목록이 빈 채로 뜬다.
      const sources = (project.keywords || []).map((word, i) => ({
        id: `cloud-${project.id}-${i}`,
        category: project.category,
        title: word,
        intro: '',
        reason: `${project.category} · 이 프로젝트를 만든 카드`,
      }));
      sourceByKey[key] = sources;

      active.push({
        key,
        category: project.category,
        goal: [project.title, project.period || '단기', 90],
        startedAt: project.started_on || new Date().toLocaleDateString('sv-SE'),
        sources,
        done: tasks.map((t, i) => (t.completed_at ? i : -1)).filter((i) => i >= 0),
      });
    });

    store.activeProjects = active;
    store.completedProjects = done;
    store.taskNotes = notes;
    store.checkins = checkins;
    store.aiSourceCards = { ...(store.aiSourceCards || {}), ...sourceByKey };
    globalThis.Storage?.write?.(store);
  });
}

/**
 * 좋아요한 카드를 관심 카드함으로 되살린다.
 * 이미 프로젝트에 쓴 카드는 보관만(candidate false), 나머지는 후보로 둔다.
 */
function hydrateCardBox() {
  const store = globalThis.Storage?.read?.() || {};
  const liked = (store.reactions || []).filter((r) => r.type === 'like');
  if (!liked.length) return;

  const usedWords = new Set([
    ...(store.completedProjects || []).flatMap((p) => (p.sourceCards || []).map((c) => c.title)),
    ...(store.activeProjects || []).map((p) => p.goal?.[0] || ''),
  ].join(' ').split(/\s+/).filter(Boolean));

  const cards = liked.map((r) => {
    const title = Cloud.keywordBySlug.get(r.topicId) || r.topicId;
    return {
      id: r.topicId,
      category: r.category,
      title,
      intro: '',
      reason: `${r.category} · 관심 카드`,
      candidate: !usedWords.has(title),
    };
  });

  store.cardStore = { version: store.cardStore?.version || 'interest-inbox-v1', cards };
  globalThis.Storage?.write?.(store);
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
      .upsert({
        user_id: Cloud.userId,
        request_id: request?.id ?? null,
        title: project.title,
        category: knownCategory(project.category),
        duration,
        keywords: project.keywords || [],
        // 화면이 쓰는 키·기간·시작일을 함께 남겨야 다른 기기에서 복원할 수 있다.
        client_key: project.projectKey ?? null,
        period: project.period ?? null,
        started_on: new Date().toLocaleDateString('sv-SE'),
      }, { onConflict: 'user_id,client_key' })
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

    if (tasks.length) {
      const { data: inserted } = await Cloud.client
        .from('tasks')
        .insert(tasks)
        .select('id, position');
      // 화면의 체크박스(프로젝트 키 + 순번)를 DB 행에 이어 두어야 완료 표시를 저장할 수 있다.
      if (inserted && project.projectKey) {
        const ids = [];
        inserted.forEach((t) => { ids[t.position] = t.id; });
        const store = Storage.read();
        store.aiTaskIds = store.aiTaskIds || {};
        store.aiTaskIds[project.projectKey] = ids;
        Storage.write(store);
      }
    }

    logEvent('project_created', { category: project.category, duration });
    return row.id;
  });
}

/** 오늘의 한 줄을 DB 에 남긴다. 스트릭이 이 기록을 함께 센다. */
async function persistTaskNote({ projectKey, index, note, date }) {
  return safe('persistTaskNote', async () => {
    const taskId = globalThis.Storage?.read?.()?.aiTaskIds?.[projectKey]?.[index];
    if (!taskId || !note) return;
    const { error } = await Cloud.client
      .from('task_notes')
      .upsert(
        { task_id: taskId, user_id: Cloud.userId, note: String(note).slice(0, 300), noted_on: date },
        { onConflict: 'task_id,noted_on' },
      );
    if (error) throw error;
    logEvent('task_note', { projectKey, index });
  });
}

/** 이번 주(월~일) 날짜를 YYYY-MM-DD 로 만든다. */
function thisWeekDays() {
  const today = new Date();
  const monday = new Date(today);
  // getDay(): 일=0. 월요일이 주의 시작이 되도록 옮긴다.
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    return day.toLocaleDateString('sv-SE'); // YYYY-MM-DD, 로컬 기준
  });
}

/** F-IYXFDA · 할 일 완료 여부를 DB 에 기록한다(캘린더 집계의 원천). */
async function markTaskCompletion(projectKey, index, completed) {
  return safe('markTaskCompletion', async () => {
    const taskId = globalThis.Storage?.read?.()?.aiTaskIds?.[projectKey]?.[index];
    if (!taskId) return;

    let query = Cloud.client
      .from('tasks')
      .update({ completed_at: completed ? new Date().toISOString() : null })
      .eq('id', taskId)
      .eq('user_id', Cloud.userId);

    // 앱을 다시 열면 저장된 완료 상태를 되살리려고 체크박스를 프로그램이 다시 누른다.
    // 그때 완료 시각을 덮어쓰면 캘린더 기록이 그날로 옮겨가므로, 이미 완료된 건 건드리지 않는다.
    if (completed) query = query.is('completed_at', null);

    const { error } = await query;
    if (error) throw error;
    if (completed) logEvent('task_completed', { projectKey, index });
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
async function generateProjectViaAI({ category, duration, goal, taskCount, survey, cards, days }) {
  const data = await invoke('generate-project', {
    category, duration, goal, taskCount, survey, cards, days,
  });
  if (!data?.tasks?.length) return null;
  return data;
}

/**
 * F-URTMLV · 프로젝트 카드로 설문 문항 생성
 *
 * 설문은 프로젝트를 만드는 흐름의 일부다. 그러므로 지금 후보로 올라온
 * 프로젝트 카드만 본다. 예전에 좋아요했던 주제는 여기 끼어들지 않는다.
 * 카드를 넘기는 동안 미리 만들어 두어, 설문 진입에서 기다리지 않게 한다.
 */
/** 지금 카드·초점 조합을 나타내는 값. 이게 다르면 다른 설문이어야 한다. */
function surveySignature() {
  const cards = currentRunCards();
  const focus = globalThis.state?.decisionFocus || '';
  return `${focus}::${cards.map((c) => c.title).join('|')}`;
}

function prepareSurvey() {
  if (!Cloud.ai) return Promise.resolve();
  const cards = currentRunCards();
  if (!cards.length) return Promise.resolve();

  const signature = surveySignature();
  // 이미 이 조합으로 만들어 둔 설문이 있으면 그대로 쓴다.
  if (Cloud.surveySignature === signature && Cloud.survey?.length) return Promise.resolve();
  // 같은 조합의 요청이 진행 중이면 그 결과를 함께 기다린다.
  if (Cloud.surveyRequest?.signature === signature) return Cloud.surveyRequest.promise;

  const focusCard = cards.find((c) => c.title === globalThis.state?.decisionFocus) || null;
  const promise = (async () => {
    const data = await invoke('generate-survey', {
      keywords: cards.map((c) => c.title),
      categories: [...new Set(cards.map((c) => c.category))],
      focus: focusCard?.title,
      focusIntro: focusCard?.intro,
    });
    // 기다리는 사이 카드나 초점이 바뀌었으면 이 결과는 이미 남의 것이다. 버린다.
    // (예전에는 이렇게 늦게 도착한 결과가 그대로 적용돼, 고른 적 없는 주제의
    //  질문이 화면에 떴다.)
    if (surveySignature() !== signature) return;
    if (data?.questions?.length) {
      Cloud.survey = data.questions;
      Cloud.surveySignature = signature;
    }
  })().finally(() => {
    if (Cloud.surveyRequest?.signature === signature) Cloud.surveyRequest = null;
    Cloud.surveyPending = false;
  });

  Cloud.surveyRequest = { signature, promise };
  Cloud.surveyPending = true;
  return promise;
}

/** 생성된 설문을 프로토타입의 decisionQuestions 배열 형태로 바꿔 끼운다. */
function applySurvey() {
  const target = globalThis.decisionQuestions;
  if (!Array.isArray(target) || !Cloud.survey?.length) return false;
  // 지금 카드 조합으로 만든 설문이 아니면 쓰지 않는다. 기존 고정 문항이 낫다.
  if (Cloud.surveySignature !== surveySignature()) return false;
  // 프로토타입은 각 항목이 [질문, 보기배열] 을 돌려주는 함수라고 가정한다.
  const built = Cloud.survey.map((item) => () => [item.q, item.options]);
  target.length = 0;
  target.push(...built);
  return true;
}

/**
 * 사용자가 직접 친 '기타' 관심사 검사.
 * 이 문자열은 그대로 AI 프롬프트에 들어가므로, 부적절한 말과
 * 프롬프트를 가로채려는 문장을 여기서 먼저 막는다. (서버에서 한 번 더 막는다.)
 */
const BLOCKED_INPUT = [
  '시발', '씨발', 'ㅅㅂ', '병신', 'ㅂㅅ', '지랄', '좆', '새끼', '개새', '썅',
  '섹스', '야동', '포르노', '자위', '조건만남', '성매매',
  '마약', '대마', '술먹', '음주', '소주', '담배', '흡연', '도박', '토토', '카지노',
  '자살', '자해', '죽여', '죽고싶', '살인', '폭행', '테러',
  '한남', '김치녀', '틀딱', '급식충', '맘충', '굶기', '먹토', '프로아나',
  'fuck', 'shit', 'porn', 'sex', 'suicide',
];
const INJECTION_INPUT = [
  /이전\s*(의)?\s*(지시|명령|규칙)/, /무시\s*(하고|해|하라|해라)/,
  /시스템\s*(프롬프트|메시지)/, /너는\s*이제/, /역할을?\s*(바꿔|변경)/,
  /ignore\s+(all\s+|the\s+)?(previous|above)/i, /system\s*(prompt|message)/i,
  /you\s+are\s+now/i, /jailbreak/i,
];

function checkCustomInterest(raw) {
  const text = String(raw || '').trim();
  const squashed = text.toLowerCase().replace(/[\s._\-*+/\\|()[\]{}'"`~!@#$%^&,?:;<>]/g, '');
  if (BLOCKED_INPUT.some((t) => squashed.includes(t.toLowerCase().replace(/\s/g, '')))) {
    return '이 서비스에서 쓸 수 없는 말이에요. 다른 관심사를 적어 주세요.';
  }
  if (INJECTION_INPUT.some((p) => p.test(text))) {
    return '관심사만 짧게 적어 주세요.';
  }
  return null;
}

/** F-URTMLV · 이번에 고른 카드 + 설문 답변 → 카테고리별 목표 후보 */
async function generateGoalsViaAI({ categories, keywords, survey, cards }) {
  const data = await invoke('generate-goals', { categories, keywords, survey, cards });
  return data?.goals || null;
}

/**
 * 프로젝트 카드 — 이번 프로젝트를 만드는 후보 카드들.
 *
 * 프로젝트 생성 흐름(설문 · 목표 · 할 일)은 오직 이것만 본다.
 * 예전에는 여기에 좋아요 이력 전체를 넘겨서, 이번에 고르지 않은 주제로
 * 목표가 나왔다(배드민턴 카드를 안 골랐는데 배드민턴 목표가 나오는 식).
 */
function currentRunCards() {
  return (Cloud.projectCards || []).map((card) => ({
    title: String(card.title || '').replace('\n', ' ').trim(),
    category: card.category,
    intro: card.intro || '',
  })).filter((card) => card.title);
}

/* ──────────────────────────── 계정 ──────────────────────────── */

/**
 * 회원가입 · 로그인
 *
 * 사용자는 익명 세션으로 먼저 앱을 쓴다. 가입할 때는 새 계정을 만드는 대신
 * 그 익명 계정을 정식 계정으로 '승격'한다. user.id 가 그대로 유지되므로
 * 지금까지 모은 관심 카드·프로젝트·완료 기록이 전부 따라온다.
 */
async function signUpWithEmail({ email, password, name }) {
  const { error } = await Cloud.client.auth.signUp({
    email,
    password,
    options: { data: { display_name: name || null } },
  });
  if (error) throw error;

  // 이메일 확인이 켜져 있으면 세션이 바로 열리지 않는다. 그대로 넘기면
  // 가입된 것처럼 보이지만 실제로는 로그인되지 않은 상태다.
  const { data: { session } } = await Cloud.client.auth.getSession();
  if (!session?.user?.email) return { pending: true };

  await adoptSession(session.user, name);
  logEvent('sign_up', {});
  return { pending: false };
}

async function signInWithEmail({ email, password }) {
  const { data, error } = await Cloud.client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await adoptSession(data.user);
  logEvent('sign_in', {});
}

/**
 * 계정을 바꿔 단다.
 * 계정마다 기록이 따로이므로, 앞 계정의 로컬 데이터를 먼저 비우고
 * 새 계정의 기록을 내려받는다.
 */
async function adoptSession(user, name) {
  resetLocalState();
  await activateSession(user);
  await refreshIdentity(name);
  Cloud.startDeck?.(); // 새 계정 기준으로 카드를 다시 받는다
}

/** 세션이 바뀐 뒤 화면이 읽는 로컬 프로필과 DB 프로필을 맞춘다. */
async function refreshIdentity(name) {
  const { data: { user } } = await Cloud.client.auth.getUser();
  if (!user) return;

  Cloud.userId = user.id;

  const displayName = name || user.user_metadata?.display_name || (user.email || '').split('@')[0];
  const store = globalThis.Storage?.read?.() || {};
  store.profile = {
    ...(store.profile || {}),
    email: user.email || '',
    name: displayName,
    signedIn: true,
    // 아바타는 밍밍이 색을 따라간다. 기본값이 음악(보라) 캐릭터라서,
    // 그대로 두면 음악을 고른 적 없는 사람도 음악 취향처럼 보였다.
    avatar: mingmingAsset(),
  };
  globalThis.Storage?.write?.(store);

  await safe('syncProfileName', async () => {
    await Cloud.client.from('profiles').update({ display_name: displayName }).eq('id', user.id);
  });
}

/** 완료한 프로젝트에서 나온 밍밍이 색의 캐릭터 이미지. 없으면 회색이다. */
function mingmingAsset() {
  const identity = globalThis.getMingmingColor?.();
  const name = identity?.score ? identity.category : '기타';
  const visual = (globalThis.Catalog?.categories || []).find((c) => c.name === name);
  return visual?.asset || 'assets/category-misc.png';
}

/** Supabase 오류를 사람이 읽을 수 있는 안내로 바꾼다. */
function authMessage(err) {
  const raw = String(err?.message || err || '');
  if (/already registered|already been registered|User already exists/i.test(raw)) {
    return '이미 가입된 이메일이에요. 로그인해 주세요.';
  }
  if (/Invalid login credentials/i.test(raw)) return '이메일이나 비밀번호가 맞지 않아요.';
  if (/Password should be at least/i.test(raw)) return '비밀번호는 6자 이상이어야 해요.';
  if (/Unable to validate email|invalid format/i.test(raw)) return '이메일 형식을 확인해 주세요.';
  if (/Email not confirmed/i.test(raw)) return '메일함에서 확인 링크를 눌러 주세요.';
  if (/rate limit|too many/i.test(raw)) return '요청이 많아요. 잠시 뒤 다시 시도해 주세요.';
  return '문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.';
}

/* ────────────────────── 생성 중 표시 (공통) ────────────────────── */

/**
 * 에이전트가 무언가 만드는 동안 쓰는 공통 표시.
 * 문구는 "밍밍이가 만들고 있어요"로 통일하고, 무엇을 만드는지 한 줄 덧붙인다.
 */
function busyCardHTML(detail) {
  return `<div class="odot-busy">
    <span class="odot-busy-dot" aria-hidden="true"></span>
    <strong>밍밍이가 만들고 있어요</strong>
    <p class="odot-busy-detail" role="status">${detail}</p>
  </div>`;
}

/** 3초 넘게 걸리면 문구를 한 번 바꿔 멈춘 게 아님을 알린다. */
function startBusyCopyRotation(root) {
  const detail = root?.querySelector('.odot-busy-detail');
  if (!detail) return;
  clearTimeout(root._busyTimer);
  root._busyTimer = setTimeout(() => {
    if (detail.isConnected) detail.textContent = '조금만 더 기다려 주세요';
  }, 3000);
}

/** 뒤 카드에 남은 장수를 은은하게 표시한다(화면을 막지 않는다). */
function updateBufferHint() {
  const hint = document.querySelector('.odot-buffer-hint');
  if (!hint) return;
  hint.hidden = Cloud.inFlight === 0;
}

function installBusyStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .odot-busy{display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:9px;height:100%;padding:26px;text-align:center}
    .odot-busy strong{font-size:17px;letter-spacing:-.3px}
    .odot-busy-detail{margin:0;color:var(--muted);font-size:13px}
    .odot-busy-dot{width:34px;height:34px;border-radius:50%;
      background:color-mix(in srgb,var(--primary,#7152a6) 26%,#fff);
      animation:odotBusyPulse 1.25s ease-in-out infinite}
    @keyframes odotBusyPulse{0%,100%{transform:scale(.82);opacity:.55}50%{transform:scale(1);opacity:1}}
    .odot-buffer-hint{display:inline-flex;align-items:center;gap:6px;margin-left:8px;
      color:var(--muted);font-size:11px;font-weight:800}
    .odot-buffer-hint:before{content:"";width:6px;height:6px;border-radius:50%;
      background:var(--primary,#7152a6);animation:odotBusyPulse 1.25s ease-in-out infinite}
    @media (prefers-reduced-motion:reduce){
      .odot-busy-dot,.odot-buffer-hint:before{animation:none}
    }
  `;
  document.head.append(style);
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
 * 마무리 단계까지 AI 가 만들므로 단계 수와 할 일 수가 1:1 로 맞는다.
 */
function applyStoredTasks() {
  const saved = globalThis.Storage?.read?.()?.aiTasks || {};
  document.querySelectorAll('.separate-project').forEach((project) => {
    const tasks = saved[project.dataset.projectKey];
    if (!Array.isArray(tasks) || !tasks.length) return;
    const rows = [...project.querySelectorAll('.independent-task')];
    if (!rows.length) return;
    // 개수가 어긋나도 겹치는 만큼은 바꾼다. 예전에는 통째로 건너뛰어
    // 하드코딩 문구가 그대로 노출됐다.
    tasks.slice(0, rows.length).forEach((task, i) => {
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
    doneProjects: Cloud.doneProjects(),
    savedCards: Cloud.savedCards(),
    customInterests: Cloud.customInterests(),
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

  /**
   * 관심 카드함은 다음 추천을 정교하게 만드는 장기 기억이다.
   * 이번 프로젝트에는 현재 탐색 중 오른쪽으로 넘긴 카드만 들어간다. 이전 세션의
   * 후보 표시가 state.decisionLikes 로 되살아나는 몽키패치를 여기서 차단한다.
   */
  const showProjectCardCount = () => {
    const count = Cloud.projectCards.length;
    const label = document.querySelector('#likedCount');
    if (!label) return;
    // 원본은 카드함의 candidate 플래그를 세므로, 장기 관심 카드와 분리한 뒤에는
    // 0장으로 보였다. 여기서는 이번 실행의 프로젝트 카드만 보여 준다.
    label.textContent = `프로젝트 카드 ${count}장`;
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    label.removeAttribute('tabindex');
    label.onclick = null;
    label.onkeydown = null;
  };
  const syncCurrentProjectCards = () => {
    const cards = Cloud.projectCards.map((card) => ({ ...card }));
    if (globalThis.state) globalThis.state.decisionLikes = cards;
    showProjectCardCount();
  };
  const demoteSavedCards = () => {
    const data = Storage.read();
    if (!data.cardStore?.cards) return;
    data.cardStore.cards = data.cardStore.cards.map((card) => ({ ...card, candidate: false }));
    Storage.write(data);
  };
  demoteSavedCards();
  syncCurrentProjectCards();

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
   *
   * 이전에는 1장씩만, 그것도 한 번에 한 요청만 보냈다. 1회 생성이 8~15초 걸리므로
   * 빠르게 넘기면 버퍼가 줄기만 하고 회복하지 못했다.
   * 이제 부족분을 한 번에 요청하고, 동시 요청을 2건까지 허용한다.
   */
  async function prefetchAhead() {
    const state = globalThis.state;
    if (!state || !Cloud.ai) return;
    if (!state.deck?.[state.current]?.isKeyword) return; // 아직 자리 표시자 덱이면 건너뛴다

    const missing = BUFFER_AHEAD - (state.deck.length - state.current);
    if (missing <= 0 || Cloud.inFlight >= MAX_PARALLEL_FETCH) return;

    Cloud.inFlight += 1;
    updateBufferHint();
    try {
      let fresh = await fetchKeywordCards(Math.min(missing, INITIAL_CARDS));
      // 조용히 버려지면 그 자리가 영구히 빈다. 한 번은 다시 시도한다.
      if (!fresh.length) fresh = await fetchKeywordCards(Math.min(missing, INITIAL_CARDS));
      if (fresh.length) {
        state.deck.push(...fresh);
        // 기다리는 사이에 카드가 바닥났을 수 있으므로, 요청 시작 시점이 아니라
        // "지금 화면에 생성 중 카드가 떠 있는지"로 판단해 실제 카드로 바꿔 준다.
        const showingBusy = !!document.querySelector('#activeCard .odot-busy');
        if (showingBusy && state.deck[state.current]) globalThis.renderDeck?.();
        else refreshUpcoming();
      }
    } finally {
      Cloud.inFlight -= 1;
      updateBufferHint();
      // 여전히 모자라면 이어서 채운다(사용자가 그동안 더 넘겼을 수 있다).
      if (Cloud.ai && state.deck.length - state.current < BUFFER_AHEAD) prefetchAhead();
    }
  }

  /**
   * 뒤에 쌓인 카드 미리보기만 갱신한다.
   *
   * renderDeck() 은 #activeCard 의 innerHTML 을 통째로 다시 쓴다. react() 가 카드를
   * 날려 보낸 뒤 다음 카드를 그리기까지 180ms 가 걸리는데, 그 사이에 버퍼 응답이
   * 도착해 전체를 다시 그리면 날아가는 중인 카드가 교체되어 번쩍이며 겹쳐 보였다.
   * 그래서 현재 카드는 건드리지 않고 뒤 카드만 손본다.
   */
  function refreshUpcoming() {
    const state = globalThis.state;
    if (!state) return;
    ['.back-1', '.back-2'].forEach((selector, i) => {
      const el = document.querySelector(selector);
      if (!el) return;
      const next = state.deck[state.current + i + 1];
      el.dataset.color = next?.color || 'gray';
      el.innerHTML = next
        ? `<span class="topic-tag">다음 추천</span><h2>${String(next.title).replace('\n', '<br>')}</h2>`
        : '';
    });
    updateBufferHint();
  }

  // 카드를 넘길 때마다 버퍼를 채운다(응답을 기다리지 않는다).
  const baseReact = globalThis.react;
  if (typeof baseReact === 'function') {
    globalThis.react = async (type) => {
      const topic = globalThis.activeTopic?.();
      if (type === 'like' && topic && !Cloud.projectCards.some((card) => card.id === topic.id)) {
        // 이 한 번의 선택만 이번 프로젝트의 재료다. 관심 카드함에도 저장되지만,
        // 이후 추천에만 쓰이고 다음 프로젝트에 자동으로 넘어오지 않는다.
        Cloud.projectCards.push({ ...topic });
      }
      await baseReact(type);
      demoteSavedCards();
      syncCurrentProjectCards();
      prefetchAhead();
      // 좋아요가 쌓일 때마다 설문을 미리 만들어 둔다(응답을 기다리지 않는다).
      if (type === 'like') prepareSurvey();
    };
  }

  /**
   * 질문 찾기 1단계 — 주제 좁히기.
   *
   * 카드가 여러 장이면 곧바로 6문항으로 넘어가지 않고, 지금 가장 끌리는 주제를
   * 하나 고르게 한다. 그 선택이 있어야 질문이 그 주제 안으로 파고들 수 있다.
   * (예전에는 어느 주제에나 붙는 같은 질문 6개가 나왔다.)
   */
  function renderFocusStep(onPicked) {
    const flow = document.querySelector('#decisionFlow');
    const cards = currentRunCards();
    if (!flow) return false;

    globalThis.setDecisionMode?.(true);
    flow.innerHTML = `
      <div class="flow-top">
        <button class="flow-back" id="focusBack" type="button" aria-label="발견으로 돌아가기">‹</button>
        <span class="flow-step">주제 좁히기</span>
      </div>
      <div class="flow-card">
        <p class="flow-kicker">고른 카드 ${cards.length}장</p>
        <h2>지금 가장<br>끌리는 건 뭐예요?</h2>
        <p class="sub">하나를 고르면 그 주제로 더 깊이 물어볼게요. 나머지는 관심 카드함에 그대로 있어요.</p>
      </div>
      <div class="focus-list">
        ${cards.map((card, i) => `
          <button class="focus-option" type="button" data-focus="${i}" aria-pressed="false">
            <strong>${card.title}</strong>
            ${card.intro ? `<span>${card.intro}</span>` : ''}
            <small>${card.category}</small>
          </button>`).join('')}
      </div>
      <button class="flow-primary" id="focusConfirm" type="button" disabled>주제를 골라 주세요</button>
      <p class="flow-helper" id="focusHelper" role="status">고른 주제로 질문 6개를 만들어요.</p>`;

    const confirm = flow.querySelector('#focusConfirm');
    let picked = null;

    flow.querySelectorAll('[data-focus]').forEach((button) => {
      button.onclick = () => {
        picked = cards[+button.dataset.focus];
        flow.querySelectorAll('[data-focus]').forEach((other) => {
          const on = other === button;
          other.classList.toggle('selected', on);
          other.setAttribute('aria-pressed', String(on));
        });
        confirm.disabled = false;
        confirm.textContent = `‘${picked.title}’로 질문 받기`;
        // 고르는 즉시 만들기 시작해, 버튼을 누를 땐 이미 준비돼 있게 한다.
        globalThis.state.decisionFocus = picked.title;
        prepareSurvey();
      };
    });

    flow.querySelector('#focusBack').onclick = () => globalThis.setDecisionMode?.(false);
    confirm.onclick = () => onPicked(picked);
    return true;
  }

  const focusStyle = document.createElement('style');
  focusStyle.textContent = `
    .focus-list{display:flex;flex-direction:column;gap:9px;margin:14px 0 4px}
    .focus-option{display:flex;flex-direction:column;gap:3px;align-items:flex-start;
      padding:14px 15px;border:1px solid var(--line);border-radius:17px;background:#fff;
      font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background .15s}
    .focus-option.selected{border-color:var(--primary,#7152a6);
      background:color-mix(in srgb,var(--primary,#7152a6) 7%,#fff)}
    .focus-option strong{font-size:16px;letter-spacing:-.3px}
    .focus-option span{color:var(--muted);font-size:12px;line-height:1.5}
    .focus-option small{margin-top:2px;color:var(--primary,#7152a6);font-size:10.5px;font-weight:900}
  `;
  document.head.append(focusStyle);

  // 설문마다 '왜 이 질문을 받는지'를 선택 카드 바로 아래에서 설명한다.
  const baseRenderDecisionQuestion = globalThis.renderDecisionQuestion;
  if (typeof baseRenderDecisionQuestion === 'function') {
    globalThis.renderDecisionQuestion = (...args) => {
      const result = baseRenderDecisionQuestion(...args);
      const flow = document.querySelector('#decisionFlow');
      const card = currentRunCards().find((item) => item.title === globalThis.state?.decisionFocus)
        || currentRunCards()[0];
      const flowCard = flow?.querySelector('.flow-card');
      if (!flowCard || !card) return result;
      flowCard.querySelector('.survey-card-context')?.remove();
      const helper = document.createElement('p');
      helper.className = 'survey-card-context';
      helper.textContent = `‘${card.title}’ 카드에서 이어져, 무엇을 어떻게 해보고 싶은지 물어봐요.`;
      flowCard.querySelector('.sub')?.insertAdjacentElement('afterend', helper);
      return result;
    };
  }
  const surveyContextStyle = document.createElement('style');
  surveyContextStyle.textContent = `.survey-card-context{margin:10px 0 0;padding:9px 10px;border-radius:11px;background:#f6f1fc;color:#67459a;font-size:11px;font-weight:800;line-height:1.5}`;
  document.head.append(surveyContextStyle);

  // 설문 시작 시점에 준비된 문항으로 갈아끼운다. 없으면 기존 고정 문항을 쓴다.
  const baseStartDecision = globalThis.startDecision;
  if (typeof baseStartDecision === 'function') {
    /** 주제를 정한 뒤 실제 설문으로 넘어간다. */
    const runSurvey = async () => {
      if (Cloud.ai && !Cloud.survey && (globalThis.state?.decisionLikes || []).length) {
        const flow = document.querySelector('#decisionFlow');
        if (flow) {
          globalThis.setDecisionMode?.(true);
          flow.innerHTML = `<div class="flow-card">${busyCardHTML('고른 주제로 질문을 만드는 중')}</div>`;
          startBusyCopyRotation(flow);
        }
        await prepareSurvey();
      }
      applySurvey();
      baseStartDecision();
    };

    globalThis.startDecision = async () => {
      const cards = currentRunCards();
      // 원본 렌더러가 카드함 후보로 state 를 덮었어도, 시작 직전에는 이번 카드만 쓴다.
      syncCurrentProjectCards();
      globalThis.state.decisionFocus = null;
      Cloud.survey = null;
      Cloud.surveySignature = null;
      Cloud.surveyRequest = null; // 진행 중이던 예전 요청의 결과를 받지 않는다

      // 카드가 한 장뿐이면 고를 것이 없으므로 바로 그 카드를 초점으로 삼는다.
      if (cards.length === 1) {
        globalThis.state.decisionFocus = cards[0].title;
        return runSurvey();
      }
      if (cards.length > 1 && Cloud.ai && renderFocusStep(() => runSurvey())) return;
      return runSurvey();
    };
    // 버튼은 원본 함수를 '값'으로 붙잡고 있어서 위 교체가 반영되지 않는다. 다시 연결한다.
    const startBtn = document.querySelector('#decisionStart');
    if (startBtn) startBtn.onclick = () => globalThis.startDecision();
  }

  /**
   * 카드가 바닥났을 때 프로토타입의 빈 상태 대신 생성 중 카드를 보여 준다.
   *
   * react() 는 다음 카드를 180ms 뒤에 그리므로, 넘긴 직후에 표시를 끼워 넣으면
   * 곧바로 덮어써진다. 그래서 renderDeck 자체를 감싼다.
   */
  const baseRenderDeck = globalThis.renderDeck;
  if (typeof baseRenderDeck === 'function') {
    globalThis.renderDeck = (...args) => {
      const state = globalThis.state;
      const card = document.querySelector('#activeCard');
      if (Cloud.ai && state && card && !state.deck?.[state.current]) {
        card.style.transform = '';
        card.style.opacity = '1';
        card.dataset.color = 'gray';
        card.innerHTML = busyCardHTML('다음 키워드를 고르는 중');
        startBusyCopyRotation(card);
        refreshUpcoming();
        return;
      }
      return baseRenderDeck(...args);
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
    .origin-card-list{display:flex;flex-direction:column;gap:6px;margin:0 10px 12px;padding:0;list-style:none}
    .origin-card-list li{display:flex;flex-direction:column;gap:2px;padding:9px 11px;
      border:1px solid color-mix(in srgb,var(--project-color) 22%,var(--line));
      border-radius:12px;background:#fff}
    .origin-card-list b{font-size:12.5px;letter-spacing:-.2px}
    .origin-card-list span{color:var(--muted);font-size:11px;line-height:1.45}
    .origin-card-list small{color:var(--project-color);font-size:10px;font-weight:800}
  `;
  document.head.append(keywordStyle);

  installBusyStyles();

  // 남은 카드를 채우는 중임을 알리는 은은한 표시(화면을 막지 않는다).
  const likedCount = document.querySelector('#likedCount');
  if (likedCount && !document.querySelector('.odot-buffer-hint')) {
    const hint = document.createElement('span');
    hint.className = 'odot-buffer-hint';
    hint.textContent = '카드 준비 중';
    hint.hidden = true;
    likedCount.insertAdjacentElement('afterend', hint);
  }

  /* ── 계정 화면: 하드코딩 데모 로그인을 실제 인증으로 교체 ──────────
     기존 화면은 demo@odot.app / odot1234 를 문자열로 비교하기만 했다. */
  installAuthScreen();

  // '기타' 직접 입력 검사. 기존에는 길이만 봤다.
  const customBtn = document.querySelector('#addCustomInterest');
  const customInput = document.querySelector('#customInterest');
  if (customBtn && customInput) {
    const baseAdd = customBtn.onclick;
    customBtn.onclick = () => {
      const problem = checkCustomInterest(customInput.value);
      if (problem) {
        const help = document.querySelector('#customHelp');
        if (help) help.textContent = problem;
        return;
      }
      baseAdd?.call(customBtn);
    };
    // 엔터로도 추가되므로 같은 검사를 태운다.
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); customBtn.onclick(); }
    });
  }

  function installAuthScreen() {
    const card = document.querySelector('#login .auth-card');
    const form = document.querySelector('#loginForm');
    if (!card || !form) return;

    card.querySelector('.demo-account')?.remove();
    // 화면의 h1/sub 는 모드에 따라 바꿔 쓴다.
    const heading = card.querySelector('h1');
    const sub = card.querySelector('.sub');

    form.innerHTML = `
      <div class="auth-tabs" role="tablist">
        <button type="button" class="auth-tab selected" data-mode="signup" role="tab" aria-selected="true">회원가입</button>
        <button type="button" class="auth-tab" data-mode="signin" role="tab" aria-selected="false">로그인</button>
      </div>
      <label for="authName" data-signup-only>닉네임</label>
      <input id="authName" type="text" maxlength="12" autocomplete="nickname" placeholder="밍밍이" data-signup-only>
      <label for="loginEmail">이메일</label>
      <input id="loginEmail" type="email" autocomplete="email" required placeholder="odot@example.com">
      <label for="loginPassword">비밀번호</label>
      <input id="loginPassword" type="password" autocomplete="new-password" required minlength="6" placeholder="6자 이상">
      <button class="primary" type="submit">가입하고 시작하기</button>
      <p class="auth-help" id="authHelp" role="status" aria-live="polite"></p>
    `;

    const help = form.querySelector('#authHelp');
    const submit = form.querySelector('button[type="submit"]');
    let mode = 'signup';

    const applyMode = () => {
      const signup = mode === 'signup';
      form.querySelectorAll('[data-signup-only]').forEach((el) => { el.hidden = !signup; });
      form.querySelectorAll('.auth-tab').forEach((tab) => {
        const on = tab.dataset.mode === mode;
        tab.classList.toggle('selected', on);
        tab.setAttribute('aria-selected', String(on));
      });
      submit.textContent = signup ? '가입하고 시작하기' : '로그인';
      form.querySelector('#loginPassword').autocomplete = signup ? 'new-password' : 'current-password';
      if (heading) {
        heading.innerHTML = signup
          ? '기록을 지키려면<br>계정이 필요해요.'
          : '다시 만나서<br>반가워요.';
      }
      if (sub) {
        sub.textContent = signup
          ? '지금까지 모은 관심 카드는 그대로 이어집니다.'
          : '쓰던 계정으로 이어서 시작해요.';
      }
      help.textContent = '';
    };

    form.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.onclick = () => { mode = tab.dataset.mode; applyMode(); };
    });

    form.onsubmit = async (event) => {
      event.preventDefault();
      const email = form.querySelector('#loginEmail').value.trim();
      const password = form.querySelector('#loginPassword').value;
      const name = form.querySelector('#authName').value.trim();

      if (!email || !password) { help.textContent = '이메일과 비밀번호를 입력해 주세요.'; return; }
      if (mode === 'signup' && password.length < 6) {
        help.textContent = '비밀번호는 6자 이상이어야 해요.';
        return;
      }

      const label = submit.textContent;
      submit.disabled = true;
      submit.textContent = mode === 'signup' ? '가입하는 중…' : '로그인하는 중…';
      help.textContent = '';
      help.style.color = '';

      try {
        if (mode === 'signup') {
          const { pending } = await signUpWithEmail({ email, password, name });
          if (pending) {
            help.textContent = `${email} 로 확인 메일을 보냈어요. 링크를 누른 뒤 로그인해 주세요.`;
            help.style.color = 'var(--muted)';
            return;
          }
        } else {
          await signInWithEmail({ email, password });
        }

        // 가입 직후에는 관심사부터 고르게 한다.
        const interests = Cloud.interests();
        globalThis.showScreen?.(interests.length ? 'explore' : 'interests');
        globalThis.toast?.(`${name || email.split('@')[0]}님, 반가워요.`);
      } catch (err) {
        console.warn('[odot-cloud] auth', err?.message || err);
        help.textContent = authMessage(err);
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    };

    applyMode();

    const authStyle = document.createElement('style');
    authStyle.textContent = `
      .auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;
        padding:4px;border-radius:14px;background:#f1ece4}
      .auth-tab{min-height:40px;border:0;border-radius:11px;background:transparent;
        color:var(--muted);font:inherit;font-size:13px;font-weight:900;cursor:pointer}
      .auth-tab.selected{background:#fff;color:var(--ink);box-shadow:0 2px 6px #5a3b7118}
      .auth-help{min-height:18px;margin:8px 0 0;color:#b3352f;font-size:12px;line-height:1.45}
      #loginForm [hidden]{display:none!important}
    `;
    document.head.append(authStyle);
  }

  // 로그아웃: 세션을 끊고 로컬 기록을 비운 뒤 로그인 화면으로 돌아간다.
  // renderProfile 이 프로필 화면을 통째로 다시 그리므로 렌더할 때마다 다시 연결한다.
  function bindLogout() {
    const logoutBtn = document.querySelector('#logout');
    if (!logoutBtn || logoutBtn.dataset.cloudBound) return;
    logoutBtn.dataset.cloudBound = 'true';

    logoutBtn.onclick = async () => {
      await safe('signOut', async () => { await Cloud.client.auth.signOut(); });
      Cloud.online = false;
      Cloud.userId = null;
      // 다음 사람이 같은 기기에서 로그인할 수 있으므로 앞 계정의 기록을 남기지 않는다.
      resetLocalState();
      const store = Storage.read();
      store.profile = { email: '', name: '밍밍이', signedIn: false };
      Storage.write(store);
      globalThis.showScreen?.('login');
      globalThis.toast?.('로그아웃했어요.');
    };
  }

  // 프로필은 렌더할 때마다 통째로 다시 그려지므로 로그아웃을 다시 잇고,
  // 상수로 박혀 있던 스트릭과 아바타를 실제 값으로 바꿔 준다.
  const baseRenderProfile = globalThis.renderProfile;
  if (typeof baseRenderProfile === 'function') {
    globalThis.renderProfile = (...args) => {
      const result = baseRenderProfile(...args);
      bindLogout();
      fixProfileFacts();
      return result;
    };
  }

  /**
   * 프로필의 '현재 스트릭'은 renderProfile 안에 streak=6 으로 박혀 있어
   * 아무것도 안 한 계정에도 6일이 떴다. 실제 활동으로 다시 센다.
   * 아바타도 이전 계정에서 넘어온 값이 아니라 지금 밍밍이 색을 쓴다.
   */
  async function fixProfileFacts() {
    const avatar = document.querySelector('#profile .profile-avatar');
    if (avatar) avatar.src = mingmingAsset();

    const stats = [...document.querySelectorAll('#profile .profile-stat')];
    const streakStat = stats.find((s) => s.querySelector('span')?.textContent?.includes('스트릭'));
    if (!streakStat) return;

    const activity = await MockAPI.getStreakActivity();
    const days = new Set((activity || []).map((item) => item.date));
    let count = 0;
    const cursor = new Date();
    // 오늘 기록이 없으면 어제까지 이어진 것도 스트릭으로 인정한다.
    if (!days.has(cursor.toLocaleDateString('sv-SE'))) cursor.setDate(cursor.getDate() - 1);
    while (days.has(cursor.toLocaleDateString('sv-SE'))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    const value = streakStat.querySelector('strong');
    if (value) value.textContent = `${count}일`;
  }

  /**
   * 카드 조작 버튼을 없앤 뒤, 처음 보는 사람도 네 방향의 결과를 미리 알 수 있도록
   * 소개 화면의 두 번째 장을 실제 제스처와 같은 언어로 바꾼다. 원본 HTML은 렌더
   * 기반이라 건드리지 않고 여기서만 증강한다.
   */
  function installOnboardingGestureGuide() {
    const slide = document.querySelectorAll('.onboard-slide')[1];
    if (!slide || slide.dataset.gestureGuideInstalled) return;
    slide.dataset.gestureGuideInstalled = 'true';

    const scene = slide.querySelector('.intro-scene');
    const title = slide.querySelector('h1');
    const copy = slide.querySelector('.sub');
    if (!scene || !title || !copy) return;

    scene.classList.add('scene-gesture-guide');
    scene.innerHTML = `
      <span class="gesture-direction gesture-up"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19V5m0 0-5 5m5-5 5 5"/></svg>위 · 요약</span>
      <span class="gesture-direction gesture-left"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m0 0 5-5m-5 5 5 5"/></svg>왼쪽 · 패스</span>
      <img src="assets/category-music.png" alt="" aria-hidden="true">
      <span class="gesture-direction gesture-right">오른쪽 · 관심<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m0 0-5-5m5 5-5 5"/></svg></span>
      <span class="gesture-direction gesture-down">아래 · 질문 찾기<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5v14m0 0-5-5m5 5 5-5"/></svg></span>`;
    title.innerHTML = '카드를 밀어<br>마음을 알려주세요.';
    copy.textContent = '방향마다 카드의 다음 단계가 달라져요.';

    const style = document.createElement('style');
    style.textContent = `
      .scene-gesture-guide{isolation:isolate;background:#e5edf8}
      .scene-gesture-guide>img{position:absolute;z-index:1;left:50%;bottom:13px;width:175px;height:175px;transform:translateX(-50%);animation:focusFloat 3s ease-in-out infinite}
      .gesture-direction{position:absolute;z-index:2;display:flex;align-items:center;gap:4px;padding:7px 9px;border:1px solid #ffffffcc;border-radius:999px;background:#fffc;color:#47423c;box-shadow:0 5px 12px #3e34251a;font-size:11px;font-weight:900;line-height:1;white-space:nowrap}
      .gesture-direction svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
      .gesture-up{top:21px;left:50%;transform:translateX(-50%);color:#527dac}
      .gesture-left{top:50%;left:12px;transform:translateY(-50%);color:#dc4650}
      .gesture-right{top:50%;right:12px;transform:translateY(-50%);color:#408b6e}
      .gesture-down{bottom:21px;left:50%;transform:translateX(-50%);color:#6e34cc}
      @media (prefers-reduced-motion:reduce){.scene-gesture-guide>img{animation:none}}
    `;
    document.head.append(style);
  }

  installOnboardingGestureGuide();

  /* ── C-2 · 조작을 스와이프로 통일 ─────────────────────────────
     하단 하트·X·정보 버튼과 질문 찾기 버튼은 스와이프와 같은 일을 중복으로 하고
     있었다. 버튼을 걷어내고 비어 있던 아래 방향을 질문 찾기에 연결한다.
     (제스처 안내는 소개 화면에서 따로 다룬다.) */
  document.querySelector('.reaction-row')?.remove();
  // #decisionStart 는 지우지 않는다. renderDeck 과 setDecisionMode 가 이 노드의
  // .hidden 을 직접 만지므로, 제거하면 두 함수가 null 참조로 죽는다. 감추기만 한다.
  const startStyle = document.createElement('style');
  startStyle.textContent = '#decisionStart{display:none!important}';
  document.head.append(startStyle);

  const deckCard = document.querySelector('#activeCard');
  if (deckCard) {
    let down = null;      // 제스처 시작점
    let last = null;      // 마지막 이동량 (취소될 때 쓰려고 들고 있는다)

    const startDecisionFromSwipe = () => {
      deckCard.style.transform = '';
      if (!currentRunCards().length) {
        globalThis.toast?.('마음 가는 카드를 한 장 이상 골라주세요.');
        return;
      }
      syncCurrentProjectCards();
      globalThis.startDecision?.();
    };

    /** 카드 너비에 맞춘 확정 거리. 작은 화면에서 95px 은 화면의 4분의 1이 넘는다. */
    const commitDistance = () =>
      Math.max(56, Math.min(95, deckCard.getBoundingClientRect().width * 0.22));

    deckCard.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
      last = { dx: 0, dy: 0 };
    });
    deckCard.addEventListener('pointermove', (e) => {
      if (down) last = { dx: e.clientX - down.x, dy: e.clientY - down.y };
    });

    deckCard.addEventListener('pointerup', (e) => {
      if (!down) return;
      const dy = e.clientY - down.y;
      const dx = e.clientX - down.x;
      down = null;
      last = null;
      // 좌우/위는 프로토타입의 기존 핸들러가 처리한다. 아래만 여기서 맡는다.
      if (dy > 100 && Math.abs(dx) < 80) startDecisionFromSwipe();
    });

    /**
     * 실제 휴대폰에서 카드가 안 넘어가던 원인.
     *
     * 프로토타입은 pointerup 에서만 스와이프를 확정한다. 그런데 폰에서는
     * 브라우저가 포인터를 가로채는 일이 잦다 — 화면 가장자리에서 시작한
     * 가로 스와이프는 '뒤로 가기' 제스처가 되고, 그때 pointerup 대신
     * pointercancel 이 온다. 그러면 state.drag 가 남은 채 아무 일도 일어나지 않는다.
     * 취소된 제스처도 충분히 밀었으면 그대로 확정한다.
     */
    const finishCancelled = () => {
      if (!down || !last) { down = null; last = null; return; }
      const { dx, dy } = last;
      down = null;
      last = null;
      if (globalThis.state) globalThis.state.drag = null; // 기존 핸들러가 뒤늦게 처리하지 않도록

      if (dy > 100 && Math.abs(dx) < 80) { startDecisionFromSwipe(); return; }
      if (dy < -100 && Math.abs(dx) < 80) { globalThis.openSheet?.('#summarySheet'); return; }
      if (Math.abs(dx) >= commitDistance()) { globalThis.react?.(dx > 0 ? 'like' : 'pass'); return; }
      deckCard.style.transform = '';
    };
    deckCard.addEventListener('pointercancel', finishCancelled);
    deckCard.addEventListener('lostpointercapture', finishCancelled);
  }

  // 브라우저의 가로 당김(뒤로 가기)이 카드 스와이프를 채가지 않게 한다.
  const swipeStyle = document.createElement('style');
  swipeStyle.textContent = `
    html,body{overscroll-behavior:none}
    .app{overscroll-behavior-x:none}
    .deck,#activeCard{touch-action:none}
  `;
  document.head.append(swipeStyle);

  // 키보드만으로도 카드에 반응할 수 있게 한다(버튼을 없앤 대신).
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('#explore')?.classList.contains('active') !== true) return;
    // 이벤트 타깃이 document 일 수 있으므로 closest 를 안전하게 호출한다.
    if (event.target?.closest?.('input, textarea, button')) return;
    const map = { ArrowLeft: 'pass', ArrowRight: 'like' };
    if (map[event.key]) { event.preventDefault(); globalThis.react?.(map[event.key]); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); globalThis.openSheet?.('#summarySheet'); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); globalThis.startDecision?.(); }
  });

  /**
   * 로그인한 계정으로 덱을 새로 채운다.
   * 카드는 계정별로 다르므로 로그인 전에는 부르지 않고, 계정이 바뀌면 다시 부른다.
   * 내장 더미 카드를 먼저 비추지 않고 생성 중 상태로 연다.
   */
  async function initDeck() {
    const state = globalThis.state;
    const card = document.querySelector('#activeCard');
    if (!state || !card || !Cloud.online) return;

    state.deck = [];
    state.current = 0;
    card.dataset.color = 'gray';
    card.innerHTML = busyCardHTML('오늘의 키워드를 고르는 중');
    startBusyCopyRotation(card);

    const cards = await fetchKeywordCards(INITIAL_CARDS);
    if (!cards.length) {
      // AI 를 못 쓰면 프로토타입의 내장 덱으로 되돌아간다.
      state.deck = await baseGetRecommendations();
      state.current = 0;
      globalThis.renderDeck?.();
      return;
    }
    if (state.current > 0) return; // 이미 넘기기 시작했으면 흐름을 끊지 않는다
    state.deck = cards;
    state.current = 0;
    globalThis.renderDeck?.();
  }

  // 로그인 이후(부팅 시 세션 복원 포함)에 세션이 잡히면 덱을 채운다.
  Cloud.startDeck = initDeck;
  if (Cloud.online) initDeck();

  // ── 실제 제작 흐름: 설문 → 목표 후보 → 프로젝트 ──────────────────
  // 프로토타입은 목표 후보(decisionGoals)와 할 일(Catalog.projects)을 모두
  // 카테고리별 고정 표에서 읽어 왔다. 두 지점을 AI 결과로 바꿔 끼운다.

  const PERIOD_TO_DURATION = { 단기: '1주', 중기: '1개월', 장기: '3개월' };

  /**
   * 목표 화면.
   *
   * 프로토타입은 카테고리마다 고정 목표 3개를 들고 있다("이번 주 나를 소개하는 한 장
   * 만들기" 같은 것). 예전에는 AI 결과를 그 표에 덮어쓰기만 해서, AI 가 어떤
   * 카테고리를 빠뜨리거나 호출이 통째로 실패하면 고른 적 없는 고정 목표가 그대로
   * 나왔다. 이제 표를 매번 비우고 AI 가 실제로 만들어 준 것만 채운다.
   */
  const baseRenderDecisionGoals = globalThis.renderDecisionGoals;
  if (typeof baseRenderDecisionGoals === 'function') {
    globalThis.renderDecisionGoals = async () => {
      const state = globalThis.state;
      const decisionGoals = globalThis.decisionGoals;
      if (!decisionGoals) return baseRenderDecisionGoals();

      clearGoalTable();

      const liked = state?.decisionLikes || [];
      const categories = [...new Set(liked.map((c) => c.category))];
      if (!categories.length) {
        showGoalTrouble('마음 가는 카드를 먼저 골라 주세요.', false);
        return;
      }

      const flow = document.querySelector('#decisionFlow');
      if (flow) {
        flow.innerHTML = `<div class="flow-card">${busyCardHTML('답변에 맞는 목표를 고르는 중')}</div>`;
        startBusyCopyRotation(flow);
      }

      const runCards = currentRunCards();
      // 주제 좁히기에서 고른 카드를 맨 앞으로 보내, 목표도 그 주제를 먼저 다루게 한다.
      const focusTitle = globalThis.state?.decisionFocus;
      const orderedCards = focusTitle
        ? [...runCards].sort((a, b) =>
          Number(b.title === focusTitle) - Number(a.title === focusTitle))
        : runCards;

      const goals = Cloud.ai
        ? await generateGoalsViaAI({
          categories,
          // 이번에 고른 카드만 넘긴다. 과거 좋아요 이력은 넘기지 않는다.
          keywords: orderedCards.map((c) => c.title),
          cards: orderedCards,
          survey: surveyAnswers(),
        })
        : null;

      const covered = new Set(
        Object.keys(goals || {}).filter((c) => Array.isArray(goals[c]) && goals[c].length),
      );
      if (!covered.size) {
        showGoalTrouble('목표를 만들지 못했어요.', true);
        return;
      }
      Object.assign(decisionGoals, goals);

      // 목표가 만들어진 카테고리만 그린다. 빠진 카테고리를 그대로 넘기면
      // 프로토타입이 decisionGoals.기타 로 되돌아가 엉뚱한 목표를 보여 준다.
      const all = state.decisionLikes;
      state.decisionLikes = all.filter((c) => covered.has(c.category));
      try {
        baseRenderDecisionGoals();
      } finally {
        state.decisionLikes = all;
      }
      wireConfirmButton();
    };
  }

  /** 고정 목표가 절대 화면에 닿지 않도록 표를 비운다. */
  function clearGoalTable() {
    const table = globalThis.decisionGoals;
    if (!table) return;
    Object.keys(table).forEach((key) => { delete table[key]; });
  }

  function showGoalTrouble(message, retry) {
    const flow = document.querySelector('#decisionFlow');
    if (!flow) return;
    flow.innerHTML = `<div class="flow-card"><p class="flow-kicker">목표 만들기</p>`
      + `<h2>${message}</h2>`
      + `<p class="sub">${retry ? '잠시 뒤 다시 시도해 주세요.' : '카드를 고르면 목표를 만들어 드릴게요.'}</p></div>`
      + (retry ? '<button class="flow-primary" id="goalRetry" type="button">다시 시도</button>' : '');
    const again = flow.querySelector('#goalRetry');
    if (again) again.onclick = () => globalThis.renderDecisionGoals();
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
      confirm.textContent = '밍밍이가 할 일을 만드는 중…';
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
    // 목표와 마찬가지로, 할 일도 이번에 고른 카드에서만 나와야 한다.
    const runCards = currentRunCards();
    const sourceByKey = {}; // 프로젝트별로 '실제로 쓰인 카드'를 담아 둔다

    // 할 일이 구체적으로 나오려면 재료가 필요하다.
    // 설문 답(쓸 수 있는 시간), 이 목표를 만든 카드의 설명, 실제 남은 일수를 함께 넘긴다.
    const survey = surveyAnswers();
    const PERIOD_DAYS = { 단기: 7, 중기: 28, 장기: 84 };

    const results = await Promise.all(picks.map(async (pick) => {
      const period = pick.goal?.[1];
      const cards = runCards
        .filter((c) => c.category === pick.category)
        .map((c) => ({ title: String(c.title || '').replace('\n', ' '), intro: c.intro || '' }));
      // 같은 분야의 이번 프로젝트 카드가 없다면, 관심 카드나 기본 표로 대신 만들지 않는다.
      if (!cards.length) return null;

      const ai = await generateProjectViaAI({
        category: pick.category,
        duration: PERIOD_TO_DURATION[period] || '1주',
        survey,
        cards,
        days: PERIOD_DAYS[period] || 7,
        goal: pick.goal?.[0],
        // 카드의 단계 수는 Catalog.projects 의 항목 수(3)를 따른다. 개수가 어긋나면
        // applyStoredTasks 가 적용을 건너뛰어 하드코딩 문구가 그대로 남는다.
        taskCount: 3,
      });
      if (!ai?.tasks?.length) return null;

      /* 이 프로젝트를 실제로 만든 카드를 골라 둔다.
         프로토타입은 같은 카테고리 카드를 전부 붙여서, '심리학' 목표에
         '고체전해질' 카드가 출처로 뜨는 일이 있었다. 목표와 할 일 문장에
         이름이 실제로 등장하는 카드만 남긴다. */
      const madeFrom = `${pick.goal?.[0] || ''} ${ai.tasks.map((t) => t.content).join(' ')}`;
      const used = cards.filter((c) => madeFrom.includes(c.title));
      const focusInThisCategory = runCards.find((c) =>
        c.title === globalThis.state?.decisionFocus && c.category === pick.category);
      const sourceCards = used.length ? used : (focusInThisCategory ? [focusInThisCategory] : cards);
      sourceByKey[pick.key] = sourceCards;

      await persistProject({
        title: pick.goal?.[0] || ai.title,
        category: pick.category,
        keywords: ai.keywords?.length ? ai.keywords : cards.map((card) => card.title),
        tasks: ai.tasks,
        projectKey: pick.key, // 완료 체크를 DB 행에 잇기 위한 키
        period,
      }, PERIOD_TO_DURATION[period] || '1주');
      return [pick.key, ai.tasks.map((t) => t.content)];
    }));

    const data = Storage.read();
    data.aiTasks = data.aiTasks || {};
    data.aiSourceCards = { ...(data.aiSourceCards || {}), ...sourceByKey };
    results.filter(Boolean).forEach(([key, tasks]) => { data.aiTasks[key] = tasks; });
    Storage.write(data);
  }

  // 프로젝트 카드가 그려질 때마다(신규 생성 · 앱 재시작 복원 모두) 할 일을 입히고
  // 완료 체크박스를 DB 에 연결한다.
  const baseOpenDecisionProject = globalThis.openDecisionProject;
  if (typeof baseOpenDecisionProject === 'function') {
    globalThis.openDecisionProject = (...args) => {
      const result = baseOpenDecisionProject(...args);
      applyStoredTasks();
      bindCompletionSync();
      showOriginCards();
      addProjectControls();
      return result;
    };
  }

  /* ── 프로젝트 삭제 · 기한 다시 잡기 ─────────────────────────────
     프로젝트는 한번 만들면 지울 수 없었고, 마감이 지나도 D-0 에 멈춘 채
     그대로 남아 있었다. 둘 다 카드 안에서 처리한다. */

  const PERIOD_DAYS_MAP = { 단기: 7, 중기: 28, 장기: 84 };

  function addProjectControls() {
    document.querySelectorAll('.separate-project').forEach((project) => {
      if (project.dataset.controlsAdded) return;
      project.dataset.controlsAdded = 'true';

      const key = project.dataset.projectKey;
      const record = (Storage.read().activeProjects || []).find((p) => p.key === key);
      const foot = project.querySelector('.separate-project-foot');
      if (!foot) return;

      foot.insertAdjacentHTML('afterend',
        `<div class="project-controls">
          <button type="button" class="project-control" data-act="reschedule">기한 다시 잡기</button>
          <button type="button" class="project-control danger" data-act="delete">삭제</button>
        </div>`);

      project.querySelector('[data-act="delete"]').onclick = () => confirmDelete(project, key);
      project.querySelector('[data-act="reschedule"]').onclick = () => reschedule(project, key, record);

      showOverdueNotice(project, key, record);
    });
  }

  /** 마감이 지났으면 조용히 두지 않고 다시 잡자고 제안한다. */
  function showOverdueNotice(project, key, record) {
    if (!record?.startedAt) return;
    const days = PERIOD_DAYS_MAP[record.goal?.[1]] || 28;
    const due = new Date(`${record.startedAt}T00:00:00`);
    due.setDate(due.getDate() + days);
    const over = Math.floor((Date.now() - due.getTime()) / 86400000);
    if (over <= 0) return;

    const done = (record.done || []).length;
    const total = project.querySelectorAll('.independent-task').length || 1;
    project.querySelector('.separate-project-head')?.insertAdjacentHTML('afterend',
      `<div class="project-overdue">
        <strong>마감일에서 ${over}일 지났어요.</strong>
        <span>${done} / ${total} 만큼 왔어요. 이번엔 어려웠던 것뿐이니 기한만 다시 잡아 볼까요?</span>
        <button type="button" class="project-control" data-act="reschedule-now">기한 다시 잡기</button>
      </div>`);
    project.querySelector('[data-act="reschedule-now"]').onclick =
      () => reschedule(project, key, record);
  }

  /** 시작일을 오늘로 옮겨 남은 기간을 되돌려 준다. */
  function reschedule(project, key, record) {
    const list = Storage.read().activeProjects || [];
    const target = record || list.find((p) => p.key === key);
    if (!target) return;

    const today = new Date().toLocaleDateString('sv-SE');
    const next = list.map((p) => (p.key === key ? { ...p, startedAt: today } : p));
    const store = Storage.read();
    store.activeProjects = next;
    Storage.write(store);

    logEvent('project_rescheduled', { key });
    globalThis.toast?.('오늘부터 다시 시작이에요.');
    // 날짜 표시를 새로 그리려면 프로젝트 화면을 다시 연다.
    globalThis.state.decisionGoalsSelected = [];
    globalThis.openDecisionProject?.();
  }

  function confirmDelete(project, key) {
    if (project.querySelector('.project-confirm')) return;
    project.insertAdjacentHTML('beforeend',
      `<div class="project-confirm">
        <strong>이 프로젝트를 지울까요?</strong>
        <span>할 일과 남긴 기록도 함께 사라져요. 되돌릴 수 없어요.</span>
        <div class="project-confirm-row">
          <button type="button" class="project-control" data-act="cancel">그대로 두기</button>
          <button type="button" class="project-control danger" data-act="confirm">지우기</button>
        </div>
      </div>`);
    project.querySelector('[data-act="cancel"]').onclick =
      () => project.querySelector('.project-confirm')?.remove();
    project.querySelector('[data-act="confirm"]').onclick = () => deleteProject(key);
  }

  async function deleteProject(key) {
    const store = Storage.read();
    const taskIds = store.aiTaskIds?.[key] || [];

    // DB 먼저 지운다. tasks 는 project 에 걸린 on delete cascade 로 함께 사라진다.
    await safe('deleteProject', async () => {
      if (!taskIds.length) return;
      const { data } = await Cloud.client
        .from('tasks').select('project_id').eq('id', taskIds[0]).maybeSingle();
      if (data?.project_id) {
        await Cloud.client.from('projects').delete()
          .eq('id', data.project_id).eq('user_id', Cloud.userId);
      }
    });

    store.activeProjects = (store.activeProjects || []).filter((p) => p.key !== key);
    delete store.aiTasks?.[key];
    delete store.aiTaskIds?.[key];
    store.checkins = (store.checkins || []).filter((c) => c.project !== key);
    store.taskNotes = (store.taskNotes || []).filter((n) => n.project !== key);
    Storage.write(store);

    logEvent('project_deleted', { key });
    globalThis.toast?.('프로젝트를 지웠어요.');

    // 프로토타입의 재렌더는 남은 프로젝트가 없으면 조기 반환하며 DOM 을 그대로 둔다.
    // 그래서 카드는 직접 걷어낸다.
    document.querySelector(`.separate-project[data-project-key="${key}"]`)?.remove();
    globalThis.state.decisionGoalsSelected =
      (globalThis.state.decisionGoalsSelected || []).filter((p) => p.key !== key);
    globalThis.state.activeProjectPicks =
      (globalThis.state.activeProjectPicks || []).filter((p) => p.key !== key);

    const left = document.querySelectorAll('.separate-project').length;
    const counter = document.querySelector('.independent-project-count');
    if (counter) counter.textContent = `${left}개`;
    const signal = document.querySelector('#projectSignal');
    if (signal) signal.textContent = left ? `진행 중 ${left}개` : '내 프로젝트';

    if (!left) {
      // 마지막 하나였으면 "아직 시작한 프로젝트가 없어요" 상태로 되돌린다.
      const ready = document.querySelector('#projectReady');
      const locked = document.querySelector('#projectLocked');
      if (ready) { ready.hidden = true; ready.innerHTML = ''; ready.classList.remove('project-has-result'); }
      if (locked) locked.hidden = false;
      globalThis.renderProjects?.();
    }
  }

  const projectControlStyle = document.createElement('style');
  projectControlStyle.textContent = `
    .project-controls{display:flex;gap:8px;justify-content:flex-end;margin:0 10px 12px}
    .project-control{min-height:34px;padding:0 12px;border:1px solid var(--line);
      border-radius:11px;background:#fff;color:var(--muted);font:inherit;font-size:11.5px;
      font-weight:800;cursor:pointer}
    .project-control.danger{border-color:#e7cdcb;color:#b3352f}
    .project-overdue{display:flex;flex-direction:column;gap:5px;align-items:flex-start;
      margin:0 10px 10px;padding:11px 13px;border-radius:13px;background:#fbf0df}
    .project-overdue strong{font-size:12.5px;color:#8a5410}
    .project-overdue span{color:#8a5410;font-size:11px;line-height:1.5}
    .project-overdue .project-control{margin-top:4px;background:#fff;border-color:#e9d4ae;color:#8a5410}
    .project-confirm{display:flex;flex-direction:column;gap:4px;margin:0 10px 12px;
      padding:12px 13px;border:1px solid #e7cdcb;border-radius:13px;background:#f9e9e8}
    .project-confirm strong{font-size:12.5px;color:#b3352f}
    .project-confirm span{color:#8a4a46;font-size:11px;line-height:1.5}
    .project-confirm-row{display:flex;gap:8px;margin-top:6px}
  `;
  document.head.append(projectControlStyle);

  /**
   * 이 프로젝트를 만든 발견 카드를 실제로 보여 준다.
   * 기존에는 개수만("2 이 프로젝트를 만든 발견 카드") 찍고, 어떤 카드였는지는
   * dataset 에만 담아 둔 채 화면에 그리지 않았다.
   */
  function showOriginCards() {
    document.querySelectorAll('.separate-project').forEach((project) => {
      const preview = project.querySelector('.project-origin-preview');
      if (!preview || preview.dataset.expandable) return;

      // 실제로 이 프로젝트를 만든 카드를 우선한다. 프로토타입이 dataset 에 넣어 두는
      // 값은 같은 카테고리 카드를 전부 담고 있어 엉뚱한 카드가 섞인다.
      let cards = Storage.read().aiSourceCards?.[project.dataset.projectKey] || [];
      if (!cards.length) {
        try { cards = JSON.parse(project.dataset.sourceCards || '[]'); } catch { cards = []; }
      }
      if (!cards.length) return;

      preview.dataset.expandable = 'true';
      preview.insertAdjacentHTML('afterend',
        `<ul class="origin-card-list">${cards.map((card) => `<li>
          <b>${card.title || ''}</b>
          ${card.intro ? `<span>${card.intro}</span>` : ''}
          ${card.reason ? `<small>${card.reason}</small>` : ''}
        </li>`).join('')}</ul>`);
    });
  }

  /** F-IYXFDA · 완료 체크를 DB 로 흘려보낸다. */
  function bindCompletionSync() {
    document.querySelectorAll('.separate-project').forEach((project) => {
      const key = project.dataset.projectKey;
      project.querySelectorAll('.independent-task').forEach((task, index) => {
        const check = task.querySelector('.task-check');
        if (!check || check.dataset.cloudBound) return;
        check.dataset.cloudBound = 'true';
        // 프로토타입의 onclick 이 먼저 클래스를 토글한 뒤 이 리스너가 결과를 읽는다.
        check.addEventListener('click', () => {
          markTaskCompletion(key, index, task.classList.contains('completed'));
        });
      });
    });
  }

  // 이 경로도 프로젝트 카드가 있을 때만 AI 프로젝트를 만든다.
  // 카드가 없거나 AI가 실패했을 때 고정 목업을 만들면 카드 밖 주제가 섞이므로 중단한다.
  MockAPI.createProject = async ({ category, duration }) => {
    const cards = currentRunCards().filter((card) => card.category === category);
    if (!cards.length) return null;
    const ai = await generateProjectViaAI({
      category,
      duration,
      cards,
      survey: surveyAnswers(),
    });
    if (!ai) return null;

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

  // ── 인사이트 · 캘린더: 하드코딩 표 대신 실제 기록 ────────────────
  // 두 화면 모두 고정 더미를 읽고 있었다. 사용자가 카드를 넘기거나 할 일을
  // 끝내도 숫자가 그대로였다. 기록이 하나도 없을 때만 더미로 되돌아간다.

  /** F-NYHVHG · 월간 관심 키워드 정산 */
  const baseGetReview = MockAPI.getReview.bind(MockAPI);
  MockAPI.getReview = async () => {
    const ranks = await safe('getReview', async () => {
      const start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);

      const { data, error } = await Cloud.client
        .from('card_reactions')
        .select('category, created_at')
        .eq('user_id', Cloud.userId)
        .eq('reaction', 'like')
        .gte('created_at', start.toISOString());
      if (error) throw error;
      if (!data?.length) return [];

      const counts = new Map();
      data.forEach((row) => counts.set(row.category, (counts.get(row.category) || 0) + 1));
      return [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([category, count]) => ({ category, count, change: `+${count}` }));
    });
    return ranks ?? baseGetReview();
  };

  /** F-IYXFDA · 일별 완료 카테고리 */
  const baseGetCompletions = MockAPI.getCompletions.bind(MockAPI);
  MockAPI.getCompletions = async () => {
    const rows = await safe('getCompletions', async () => {
      const { data, error } = await Cloud.client
        .from('daily_category_summary')
        .select('day, category, completed_count')
        .eq('user_id', Cloud.userId);
      if (error) throw error;
      if (!data?.length) return [];
      // 화면은 완료 1건당 한 줄을 기대한다. 집계를 다시 펼친다.
      return data.flatMap((row) =>
        Array.from({ length: row.completed_count }, () => ({
          date: row.day,
          category: row.category,
        })));
    });
    return rows ?? baseGetCompletions();
  };

  /** 인사이트 히트맵 · 잔디: 8월치 목업 대신 실제 기록 */
  const baseGetDailyInterest = MockAPI.getDailyInterest?.bind(MockAPI);
  if (baseGetDailyInterest) {
    MockAPI.getDailyInterest = async () => {
      const rows = await safe('getDailyInterest', async () => {
        const { data, error } = await Cloud.client
          .from('card_reactions')
          .select('category, created_at')
          .eq('user_id', Cloud.userId)
          .eq('reaction', 'like');
        if (error) throw error;
        if (!data?.length) return [];

        // 화면은 날짜·카테고리별 건수를 기대한다.
        const counts = new Map();
        data.forEach((row) => {
          const date = new Date(row.created_at).toLocaleDateString('sv-SE'); // YYYY-MM-DD
          const key = `${date}|${row.category}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        });
        return [...counts].map(([key, count]) => {
          const [date, category] = key.split('|');
          return { date, category, count };
        });
      });
      return rows ?? baseGetDailyInterest();
    };
  }

  /**
   * 잔디는 '완료한 날'뿐 아니라 '오늘의 한 줄을 남긴 날'도 이어진 날로 센다.
   * 완료만 세면, 한 줄만 남긴 날이 잔디에서 빈칸으로 남는다.
   */
  const baseGetStreakActivity = MockAPI.getStreakActivity?.bind(MockAPI);
  if (baseGetStreakActivity) {
    MockAPI.getStreakActivity = async () => {
      const rows = await safe('getStreakActivity', async () => {
        const [done, notes] = await Promise.all([
          Cloud.client.from('daily_category_summary')
            .select('day, category, completed_count').eq('user_id', Cloud.userId),
          Cloud.client.from('task_notes')
            .select('noted_on, tasks(category)').eq('user_id', Cloud.userId),
        ]);

        const byDay = new Map();
        const add = (date, category, n) => {
          if (!date) return;
          const row = byDay.get(date) || { date, category: category || '기타', count: 0 };
          row.count += n;
          if (category) row.category = category;
          byDay.set(date, row);
        };
        (done.data || []).forEach((r) => add(r.day, r.category, r.completed_count));
        (notes.data || []).forEach((r) => add(r.noted_on, r.tasks?.category, 1));

        return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
      });
      return rows ?? baseGetStreakActivity();
    };
  }

  // 오늘의 한 줄도 DB 에 남긴다. 스트릭이 이 기록을 함께 센다.
  const baseSaveTaskNote = globalThis.saveTaskNote;
  if (typeof baseSaveTaskNote === 'function') {
    globalThis.saveTaskNote = (entry) => {
      const result = baseSaveTaskNote(entry);
      persistTaskNote({
        projectKey: entry?.project,
        index: entry?.task,
        note: entry?.note,
        date: entry?.date,
      });
      return result;
    };
  }

  /**
   * 주간 막대를 이번 주(월~일) 기준으로 다시 그린다.
   *
   * 원래 코드는 getDailyInterest() 결과의 마지막 7'행'을 잘랐다. 실제 기록은
   * (날짜, 카테고리)별로 쪼개져 있어서, 하루에 세 분야를 골랐으면 그 하루가
   * 세 행을 차지한다. 그래서 요일 하나만 막대로 남는 일이 생겼다.
   */
  async function renderWeeklyBars() {
    const bars = document.querySelector('.weekly-bars');
    if (!bars || !Cloud.online) return;

    const days = thisWeekDays();
    const daily = await MockAPI.getDailyInterest();
    const labels = ['월', '화', '수', '목', '금', '토', '일'];

    const week = days.map((date) => {
      const rows = (daily || []).filter((item) => item.date === date);
      const count = rows.reduce((sum, item) => sum + (item.count || 0), 0);
      const top = rows.slice().sort((a, b) => b.count - a.count)[0];
      return { date, count, category: top?.category || '기타' };
    });

    const max = Math.max(1, ...week.map((d) => d.count));
    bars.innerHTML = week.map((day, i) => {
      const visual = (Catalog?.categories || []).find((c) => c.name === day.category)
        || (Catalog?.categories || []).at(-1);
      const lead = day.count > 0 && day.count === max;
      return `<div class="weekly-bar ${lead ? 'category-lead' : ''}"
        style="--heat:var(--${visual.color})" title="${labels[i]}: ${day.count}장">
        <b>${day.count}</b><i style="height:${(day.count / max) * 86}%"></i><span>${labels[i]}</span>
      </div>`;
    }).join('');

    const card = bars.closest('.chart-card');
    card?.querySelector('p')?.replaceChildren('이번 주 고른 카드 수');
    const total = week.reduce((sum, d) => sum + d.count, 0);
    const note = card?.querySelector('.chart-category-note');
    if (note) {
      const best = week.slice().sort((a, b) => b.count - a.count)[0];
      note.textContent = total
        ? `이번 주 ${total}장 · 가장 많이 고른 날은 ${labels[week.indexOf(best)]}요일이에요.`
        : '이번 주에는 아직 고른 카드가 없어요.';
    }
  }

  /**
   * '관심의 비중' 타일의 숫자 크기를 비중에 맞춘다.
   *
   * 원래는 모든 타일이 clamp(32px,10vw,48px) 로 같은 크기여서, 7% 가 36% 만큼
   * 크게 보였다. 가장 큰 비중을 기준으로 줄여 눈으로도 차이가 읽히게 한다.
   */
  function scaleShareNumbers() {
    const tiles = [...document.querySelectorAll('.stat-tile')];
    if (!tiles.length) return;

    const read = (tile) => Number(String(tile.querySelector('strong')?.textContent || '').replace(/\D/g, '')) || 0;
    const max = Math.max(...tiles.map(read), 1);

    tiles.forEach((tile) => {
      const value = tile.querySelector('strong');
      if (!value) return;
      const share = read(tile) / max;
      // 가장 큰 비중이 48px, 아주 작은 비중도 18px 아래로는 내리지 않는다.
      let size = 18 + 30 * share;
      // 타일이 낮으면 숫자가 넘치므로 높이에도 맞춘다.
      const height = tile.getBoundingClientRect().height;
      if (height) size = Math.min(size, height * 0.52);
      value.style.setProperty('font-size', `${Math.round(size)}px`, 'important');
      value.style.setProperty('letter-spacing', size > 34 ? '-2.4px' : '-1.2px', 'important');
    });
  }

  // 인사이트 화면이 그려진 뒤 주간 막대와 비중 숫자를 바로잡는다.
  const baseRenderReviewForWeek = globalThis.renderReview;
  if (typeof baseRenderReviewForWeek === 'function') {
    globalThis.renderReview = async (...args) => {
      const result = await baseRenderReviewForWeek(...args);
      await renderWeeklyBars();
      scaleShareNumbers();
      return result;
    };
  }
  // 화면 폭이 바뀌면 타일 높이도 바뀌므로 다시 맞춘다.
  window.addEventListener('resize', () => {
    if (document.querySelector('#review')?.classList.contains('active')) scaleShareNumbers();
  });

  // 앱 재시작 시 프로젝트 복원은 이 모듈보다 먼저 끝난다.
  // 그 결과에도 할 일·출처 카드·조작 버튼을 똑같이 입힌다.
  // DB 에서 내려받은 프로젝트를 화면에 그린 뒤, 할 일·출처 카드·조작 버튼을 입힌다.
  renderRestoredProjects();
  applyStoredTasks();
  bindCompletionSync();
  showOriginCards();
  addProjectControls();

  logEvent('session_start', { source: 'prototype' });
}

/* ────────────────────────── 시작 ────────────────────────── */

// 로그인 화면은 세션이 없어도, 심지어 부팅이 실패해도 떠야 한다.
// 그래서 attach 는 boot 의 성패와 무관하게 항상 실행한다.
boot()
  .catch((err) => {
    console.warn('[odot-cloud] 오프라인 모드로 동작합니다:', err?.message || err);
  })
  .finally(attach);

globalThis.OdotCloud = Cloud;
