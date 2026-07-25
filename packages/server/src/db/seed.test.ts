import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/loader.js';
import { closeDatabase, getDatabase, initDatabase } from './client.js';
import { modelMappings, settings } from './schema.js';
import { seedDatabase } from './seed.js';

describe.sequential('seedDatabase CLI model catalog migration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'star-cliproxy-seed-test-'));
    await initDatabase(join(tempDir, 'cliproxy.db'));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('기존 builtin 매핑만 최신 slug로 전환하고 사용자 정의 매핑은 보존', async () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    await db.insert(modelMappings).values([
      {
        id: 'legacy-grok',
        alias: 'grok-build',
        provider: 'grok',
        actualModel: 'grok-build',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'legacy-composer',
        alias: 'grok-composer',
        provider: 'grok',
        actualModel: 'grok-composer-2.5-fast',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'legacy-agy',
        alias: 'gemini-3.5-flash-high',
        provider: 'agy',
        actualModel: 'Gemini 3.5 Flash (High)',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'custom',
        alias: 'my-grok',
        provider: 'grok',
        actualModel: 'grok-build',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const config = loadConfig(join(tempDir, 'missing-config.yaml'));
    await seedDatabase(config);
    // 재시작 시에도 migration/catalog row가 중복되지 않아야 한다.
    await seedDatabase(config);

    const rows = await db.select().from(modelMappings);
    const byAlias = new Map(rows.map((row) => [row.alias, row]));

    expect(byAlias.get('grok-build')?.actualModel).toBe('grok-4.5');
    expect(byAlias.get('grok-composer')?.enabled).toBe(false);
    expect(byAlias.get('gemini-3.5-flash-high')).toMatchObject({
      actualModel: 'gemini-3.5-flash',
      reasoningEffort: 'high',
    });
    expect(byAlias.get('my-grok')?.actualModel).toBe('grok-build');

    expect(byAlias.get('gemini-3.6-flash-medium')).toMatchObject({
      provider: 'agy',
      actualModel: 'gemini-3.6-flash',
      reasoningEffort: 'medium',
    });
    expect(byAlias.get('agy-claude-sonnet')?.actualModel).toBe('claude-sonnet-4-6');
    expect(byAlias.get('grok-4.5')?.actualModel).toBe('grok-4.5');
    expect(rows.filter((row) => row.alias === 'grok-4.5')).toHaveLength(1);

    const migration = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'migration.cli-model-catalog-2026-07'));
    expect(migration).toHaveLength(1);
  });
});
