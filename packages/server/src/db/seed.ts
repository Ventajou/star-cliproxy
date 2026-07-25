import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AppConfig } from '@star-cliproxy/shared';
import { getDatabase } from './client.js';
import { apiKeys, modelMappings, settings } from './schema.js';
import { hashApiKey, getKeyPrefix } from '../middleware/auth.js';

const CLI_MODEL_MIGRATION_KEY = 'migration.cli-model-catalog-2026-07';
const KIMI_CATALOG_MIGRATION_KEY = 'migration.kimi-provider-catalog-2026-07';

interface SeedMapping {
  alias: string;
  provider: string;
  actual_model: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

const CURRENT_CATALOG_ADDITIONS: SeedMapping[] = [
  { alias: 'gemini-3.6-flash-low', provider: 'agy', actual_model: 'gemini-3.6-flash', reasoning_effort: 'low' },
  { alias: 'gemini-3.6-flash-medium', provider: 'agy', actual_model: 'gemini-3.6-flash', reasoning_effort: 'medium' },
  { alias: 'gemini-3.6-flash-high', provider: 'agy', actual_model: 'gemini-3.6-flash', reasoning_effort: 'high' },
  { alias: 'gemini-3.5-flash-low', provider: 'agy', actual_model: 'gemini-3.5-flash', reasoning_effort: 'low' },
  { alias: 'gemini-3.5-flash-medium', provider: 'agy', actual_model: 'gemini-3.5-flash', reasoning_effort: 'medium' },
  { alias: 'gemini-3.5-flash-high', provider: 'agy', actual_model: 'gemini-3.5-flash', reasoning_effort: 'high' },
  { alias: 'gemini-3.1-pro-low', provider: 'agy', actual_model: 'gemini-3.1-pro', reasoning_effort: 'low' },
  { alias: 'gemini-3.1-pro-high', provider: 'agy', actual_model: 'gemini-3.1-pro', reasoning_effort: 'high' },
  { alias: 'agy-claude-sonnet', provider: 'agy', actual_model: 'claude-sonnet-4-6' },
  { alias: 'agy-claude-opus', provider: 'agy', actual_model: 'claude-opus-4-6-thinking' },
  { alias: 'agy-gpt-oss', provider: 'agy', actual_model: 'gpt-oss-120b-medium' },
  { alias: 'grok-4.5', provider: 'grok', actual_model: 'grok-4.5' },
  { alias: 'grok-build-high', provider: 'grok', actual_model: 'grok-4.5', reasoning_effort: 'high' },
];

const KIMI_CATALOG_ADDITIONS: SeedMapping[] = [
  { alias: 'kimi-coding', provider: 'kimi', actual_model: 'kimi-code/kimi-for-coding' },
  { alias: 'kimi-coding-highspeed', provider: 'kimi', actual_model: 'kimi-code/kimi-for-coding-highspeed' },
  { alias: 'kimi-k3', provider: 'kimi', actual_model: 'kimi-code/k3' },
  { alias: 'kimi-k3-low', provider: 'kimi', actual_model: 'kimi-code/k3', reasoning_effort: 'low' },
  { alias: 'kimi-k3-max', provider: 'kimi', actual_model: 'kimi-code/k3', reasoning_effort: 'max' },
  { alias: 'kimi-k3-256k', provider: 'kimi', actual_model: 'kimi-code/k3-256k' },
];

function normalizeLegacyBuiltinMapping(mapping: SeedMapping): SeedMapping | null {
  if (mapping.provider === 'grok') {
    if (mapping.actual_model === 'grok-composer-2.5-fast') return null;
    if (mapping.actual_model === 'grok-build') {
      return { ...mapping, actual_model: 'grok-4.5' };
    }
  }

  const agyLegacy: Record<string, { model: string; effort: 'low' | 'medium' | 'high' }> = {
    'Gemini 3.5 Flash (Low)': { model: 'gemini-3.5-flash', effort: 'low' },
    'Gemini 3.5 Flash (Medium)': { model: 'gemini-3.5-flash', effort: 'medium' },
    'Gemini 3.5 Flash (High)': { model: 'gemini-3.5-flash', effort: 'high' },
    'Gemini 3.1 Pro (Low)': { model: 'gemini-3.1-pro', effort: 'low' },
    'Gemini 3.1 Pro (High)': { model: 'gemini-3.1-pro', effort: 'high' },
  };
  if (mapping.provider === 'agy' && agyLegacy[mapping.actual_model]) {
    const replacement = agyLegacy[mapping.actual_model];
    return {
      ...mapping,
      actual_model: replacement.model,
      reasoning_effort: replacement.effort,
    };
  }

  return mapping;
}

async function migrateBuiltinCliMappings(): Promise<void> {
  const db = getDatabase();
  const alreadyApplied = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, CLI_MODEL_MIGRATION_KEY))
    .limit(1);
  if (alreadyApplied.length > 0) return;

  const now = new Date().toISOString();
  const legacyUpdates: Array<{
    alias: string;
    provider: string;
    fromModel: string;
    toModel: string;
    effort?: 'low' | 'medium' | 'high';
  }> = [
    { alias: 'grok-build', provider: 'grok', fromModel: 'grok-build', toModel: 'grok-4.5' },
    { alias: 'grok-build-high', provider: 'grok', fromModel: 'grok-build', toModel: 'grok-4.5', effort: 'high' },
    { alias: 'gemini-3.5-flash-low', provider: 'agy', fromModel: 'Gemini 3.5 Flash (Low)', toModel: 'gemini-3.5-flash', effort: 'low' },
    { alias: 'gemini-3.5-flash-medium', provider: 'agy', fromModel: 'Gemini 3.5 Flash (Medium)', toModel: 'gemini-3.5-flash', effort: 'medium' },
    { alias: 'gemini-3.5-flash-high', provider: 'agy', fromModel: 'Gemini 3.5 Flash (High)', toModel: 'gemini-3.5-flash', effort: 'high' },
    { alias: 'gemini-3.1-pro-low', provider: 'agy', fromModel: 'Gemini 3.1 Pro (Low)', toModel: 'gemini-3.1-pro', effort: 'low' },
    { alias: 'gemini-3.1-pro-high', provider: 'agy', fromModel: 'Gemini 3.1 Pro (High)', toModel: 'gemini-3.1-pro', effort: 'high' },
  ];

  for (const migration of legacyUpdates) {
    await db
      .update(modelMappings)
      .set({
        actualModel: migration.toModel,
        ...(migration.effort ? { reasoningEffort: migration.effort } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(modelMappings.alias, migration.alias),
        eq(modelMappings.provider, migration.provider),
        eq(modelMappings.actualModel, migration.fromModel),
      ));
  }

  // 제거된 Composer 기본 매핑만 비활성화한다. 다른 alias나 사용자가 바꾼 모델은 건드리지 않는다.
  await db
    .update(modelMappings)
    .set({ enabled: false, updatedAt: now })
    .where(and(
      eq(modelMappings.alias, 'grok-composer'),
      eq(modelMappings.provider, 'grok'),
      eq(modelMappings.actualModel, 'grok-composer-2.5-fast'),
    ));

  const existing = await db.select({ alias: modelMappings.alias }).from(modelMappings);
  const aliases = new Set(existing.map((mapping) => mapping.alias));
  for (const mapping of CURRENT_CATALOG_ADDITIONS) {
    if (aliases.has(mapping.alias)) continue;
    await db.insert(modelMappings).values({
      id: nanoid(),
      alias: mapping.alias,
      provider: mapping.provider,
      actualModel: mapping.actual_model,
      displayName: mapping.alias,
      reasoningEffort: mapping.reasoning_effort ?? null,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.insert(settings).values({
    key: CLI_MODEL_MIGRATION_KEY,
    value: now,
    updatedAt: now,
  });
}

async function seedKimiCatalog(): Promise<void> {
  const db = getDatabase();
  const alreadyApplied = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, KIMI_CATALOG_MIGRATION_KEY))
    .limit(1);
  if (alreadyApplied.length > 0) return;

  const now = new Date().toISOString();
  const existing = await db.select({ alias: modelMappings.alias }).from(modelMappings);
  const aliases = new Set(existing.map((mapping) => mapping.alias));
  for (const mapping of KIMI_CATALOG_ADDITIONS) {
    if (aliases.has(mapping.alias)) continue;
    await db.insert(modelMappings).values({
      id: nanoid(),
      alias: mapping.alias,
      provider: mapping.provider,
      actualModel: mapping.actual_model,
      displayName: mapping.alias,
      reasoningEffort: mapping.reasoning_effort ?? null,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.insert(settings).values({
    key: KIMI_CATALOG_MIGRATION_KEY,
    value: now,
    updatedAt: now,
  });
}

export async function seedDatabase(config: AppConfig): Promise<void> {
  const db = getDatabase();

  // 초기 API 키 시드
  for (const keyConfig of config.auth.initialKeys) {
    if (!keyConfig.key) continue;

    const keyHash = hashApiKey(keyConfig.key);
    const existing = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(apiKeys).values({
        id: nanoid(),
        keyHash,
        keyPrefix: getKeyPrefix(keyConfig.key),
        name: keyConfig.name,
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // 모델 매핑 시드 (additive): config.yaml의 alias 중 DB에 없는 것만 추가한다.
  // 기존 매핑은 절대 덮어쓰지 않는다 — DB가 런타임 SSOT이고 대시보드
  // (admin/model-mappings)에서 편집한 매핑을 매 재시작마다 클로버링하면 회귀이기 때문.
  // (이슈 #38: "매 재시작 강제 upsert" 제안을 검토 후 additive로 채택.)
  // [followup] config에서 제거/수정한 매핑은 자동 삭제·갱신되지 않는다(추가만). 정리는 대시보드에서.
  await migrateBuiltinCliMappings();
  await seedKimiCatalog();

  const existingMappings = await db
    .select({ alias: modelMappings.alias })
    .from(modelMappings);
  const existingAliases = new Set(existingMappings.map((m) => m.alias));

  for (const mapping of config.modelMappings) {
    const normalized = normalizeLegacyBuiltinMapping(mapping as SeedMapping);
    if (!normalized || existingAliases.has(normalized.alias)) continue;
    await db.insert(modelMappings).values({
      id: nanoid(),
      alias: normalized.alias,
      provider: normalized.provider,
      actualModel: normalized.actual_model,
      displayName: normalized.alias,
      reasoningEffort: normalized.reasoning_effort ?? null,
      priority: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}
