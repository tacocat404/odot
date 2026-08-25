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

const Cloud = {
  client: null,
  userId: null,
  online: false,
  ai: true,
  cardIds: new Map(), // slug -> keyword_cards.id
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

  const { data, error } = await Cloud.client
    .from('keyword_cards')
    .insert({
      user_id: Cloud.userId,
      slug,
      category: knownCategory(topic.category),
      title: topic.title || slug,
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
    const { error } = await Cloud.client
      .from('card_reactions')
      .upsert(
        {
          user_id: Cloud.userId,
          card_id: cardId,
          category: knownCategory(topic.category),
          reaction,
        },
        { onConflict: 'user_id,card_id', ignoreDuplicates: true },
      );
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
async function generateProjectViaAI({ category, duration, interests, likedTitles }) {
  const data = await invoke('generate-project', { category, duration, interests, likedTitles });
  if (!data?.tasks?.length) return null;
  return data;
}

/** F-OVNIBD · 카드 소진 시 AI 로 보충 */
async function recommendCardsViaAI({ interests, likedCategories, seenTitles, count }) {
  const data = await invoke('recommend-cards', { interests, likedCategories, seenTitles, count });
  if (!data?.cards?.length) return [];

  const palette = new Map((globalThis.Catalog?.categories || []).map((c) => [c.name, c.color]));
  return data.cards.map((card) => ({
    id: card.slug,
    category: knownCategory(card.category),
    color: palette.get(knownCategory(card.category)) || 'gray',
    title: card.title,
    intro: card.intro,
    reason: card.reason,
    easy: card.easy,
  }));
}

/* ────────────────────────── 기존 코드에 연결 ────────────────────────── */

function attach() {
  const MockAPI = globalThis.MockAPI;
  const Storage = globalThis.Storage;
  const Catalog = globalThis.Catalog;
  if (!MockAPI || !Storage) return;

  const likedContext = () => {
    const data = Storage.read();
    const likes = (data.reactions || []).filter((r) => r.type === 'like');
    const titleOf = (id) => Catalog?.topics?.find((t) => t.id === id)?.title?.replace('\n', ' ');
    return {
      interests: data.interests || [],
      likedCategories: likes.map((r) => r.category),
      likedTitles: likes.map((r) => titleOf(r.topicId)).filter(Boolean),
    };
  };

  // 관심사 저장 미러
  const baseSaveInterests = MockAPI.saveInterests.bind(MockAPI);
  MockAPI.saveInterests = async (interests) => {
    const result = await baseSaveInterests(interests);
    saveInterests(interests);
    return result;
  };

  // 카드 반응 미러
  const baseSaveReaction = MockAPI.saveReaction.bind(MockAPI);
  MockAPI.saveReaction = async (reaction) => {
    const result = await baseSaveReaction(reaction);
    const topic = Catalog?.topics?.find((t) => t.id === reaction.topicId)
      || { id: reaction.topicId, category: reaction.category };
    saveReaction(topic, reaction.type);
    return result;
  };

  // 카드 덱 보충: 로컬 카드를 다 보면 AI 카드를 이어 붙인다
  const baseGetRecommendations = MockAPI.getRecommendations.bind(MockAPI);
  MockAPI.getRecommendations = async () => {
    const local = await baseGetRecommendations();
    if (local.length >= 4) return local;

    const ctx = likedContext();
    const fresh = await recommendCardsViaAI({
      interests: ctx.interests,
      likedCategories: ctx.likedCategories,
      seenTitles: local.map((t) => t.title?.replace('\n', ' ')),
      count: 5,
    });
    return fresh.length ? [...local, ...fresh] : local;
  };

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

  logEvent('session_start', { source: 'prototype' });
}

/* ────────────────────────── 시작 ────────────────────────── */

boot()
  .then(attach)
  .catch((err) => {
    console.warn('[odot-cloud] 오프라인 모드로 동작합니다:', err?.message || err);
  });

globalThis.OdotCloud = Cloud;
