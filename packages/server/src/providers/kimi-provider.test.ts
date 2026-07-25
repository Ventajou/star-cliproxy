import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml, ProviderEvent } from '@star-cliproxy/shared';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { KimiProvider } from './kimi-provider.js';

const spawnMock = vi.mocked(spawn);

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'kimi',
    default_model: 'kimi-code/kimi-for-coding',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'kimi-code/kimi-for-coding',
    stream: false,
    ...extra,
  };
}

function kimiRecords(...records: object[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function fakeChild(stdout: string, stderr = '', exitCode = 0) {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  (child as unknown as { stdout: Readable }).stdout = Readable.from([Buffer.from(stdout)]);
  (child as unknown as { stderr: Readable }).stderr = Readable.from([Buffer.from(stderr)]);
  (child as unknown as { kill: (sig?: string) => boolean }).kill = vi.fn(() => true);
  (child as unknown as { killed: boolean }).killed = false;
  setImmediate(() => (child as unknown as EventEmitter).emit('close', exitCode));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

type BuildArgs = { buildArgs(opts: ExecuteOptions): string[] };

describe('KimiProvider.buildArgs', () => {
  it('모델 alias와 prompt를 공식 headless/stream-json 계약으로 전달', () => {
    const provider = new KimiProvider(baseConfig());
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions({
      model: 'kimi-code/k3',
      messages: [{ role: 'user', content: 'ping' }],
    }));

    expect(args[args.indexOf('-m') + 1]).toBe('kimi-code/k3');
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2))
      .toEqual(['--output-format', 'stream-json']);
    expect(args[args.indexOf('-p') + 1]).toBe('ping');
    expect(args.slice(-2)).toEqual(['-p', 'ping']);
  });

  it('options.model이 없으면 default_model을 사용', () => {
    const provider = new KimiProvider(baseConfig({ default_model: 'kimi-code/k3-256k' }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions({ model: '' }));
    expect(args[args.indexOf('-m') + 1]).toBe('kimi-code/k3-256k');
  });

  it('default_model도 비어 있으면 -m을 생략해 CLI 기본값 사용', () => {
    const provider = new KimiProvider(baseConfig({ default_model: '' }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions({ model: '' }));
    expect(args).not.toContain('-m');
  });

  it('사용자가 지정한 output-format/prompt는 provider 계약으로 교체', () => {
    const provider = new KimiProvider(baseConfig({
      extra_args: [
        '--output-format=text',
        '--prompt',
        'stale prompt',
        '--add-dir',
        '/safe/read-only',
      ],
    }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions());

    expect(args).not.toContain('--output-format=text');
    expect(args).not.toContain('stale prompt');
    expect(args.filter((arg) => arg === '--output-format')).toHaveLength(1);
    expect(args).toContain('--add-dir');
    expect(args.slice(-2)).toEqual(['-p', 'hello']);
  });

  it('extra_args의 직접 model 설정은 존중하고 -m을 중복 추가하지 않음', () => {
    const provider = new KimiProvider(baseConfig({
      extra_args: ['--model', 'my-kimi-alias'],
    }));
    const args = (provider as unknown as BuildArgs).buildArgs(baseOptions({ model: 'kimi-code/k3' }));
    expect(args.filter((arg) => arg === '--model' || arg === '-m')).toHaveLength(1);
    expect(args[args.indexOf('--model') + 1]).toBe('my-kimi-alias');
  });

  it.each(['--yolo', '-y', '--plan'])(
    'prompt mode와 함께 쓸 수 없는 %s를 명확히 거부',
    (flag) => {
      const provider = new KimiProvider(baseConfig({ extra_args: [flag] }));
      expect(() => (provider as unknown as BuildArgs).buildArgs(baseOptions()))
        .toThrow(/prompt mode cannot be combined/);
    },
  );

  it('800KB 초과 prompt를 ARG_MAX 오류로 즉시 거부', () => {
    const provider = new KimiProvider(baseConfig());
    const huge = 'x'.repeat(800_001);
    expect(() => (provider as unknown as BuildArgs).buildArgs(baseOptions({
      messages: [{ role: 'user', content: huge }],
    }))).toThrow(/prompt exceeds/);
  });
});

describe('KimiProvider.execute', () => {
  it('assistant 레코드만 합치고 tool/meta 레코드는 내부 실행 정보로 유지', async () => {
    spawnMock.mockReturnValue(fakeChild(kimiRecords(
      { role: 'meta', type: 'system.version', version: '0.29.1' },
      { role: 'assistant', content: 'Hello ' },
      { role: 'tool', tool_call_id: 'tool-1', content: 'result' },
      { role: 'assistant', content: 'from Kimi.' },
      { role: 'meta', type: 'session.resume_hint', session_id: 'session-1' },
    )));

    const provider = new KimiProvider(baseConfig());
    const result = await provider.execute(baseOptions());
    expect(result.content).toBe('Hello from Kimi.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens)
      .toBe(result.usage.promptTokens + result.usage.completionTokens);
  });

  it('요청 중 자동 업데이트를 끄고 K3 effort를 low/high/max로 정규화', async () => {
    const captured: Array<NodeJS.ProcessEnv> = [];
    spawnMock.mockImplementation((_command, _args, options) => {
      captured.push(options?.env as NodeJS.ProcessEnv);
      return fakeChild(kimiRecords({ role: 'assistant', content: 'ok' }));
    });

    const provider = new KimiProvider(baseConfig());
    for (const [effort, expected] of [
      ['low', 'low'],
      ['medium', 'high'],
      ['high', 'high'],
      ['xhigh', 'max'],
      ['max', 'max'],
    ] as const) {
      await provider.execute(baseOptions({
        model: 'kimi-code/k3',
        reasoningEffort: effort,
      }));
      expect(captured.at(-1)?.KIMI_CODE_NO_AUTO_UPDATE).toBe('1');
      expect(captured.at(-1)?.KIMI_MODEL_THINKING_EFFORT).toBe(expected);
    }
  });

  it('K3-256k에도 reasoning effort 환경변수를 전달', async () => {
    let env: NodeJS.ProcessEnv | undefined;
    spawnMock.mockImplementation((_command, _args, options) => {
      env = options?.env as NodeJS.ProcessEnv;
      return fakeChild(kimiRecords({ role: 'assistant', content: 'ok' }));
    });

    const provider = new KimiProvider(baseConfig());
    await provider.execute(baseOptions({
      model: 'kimi-code/k3-256k',
      reasoningEffort: 'max',
    }));
    expect(env?.KIMI_MODEL_THINKING_EFFORT).toBe('max');
  });

  it('non-zero 종료 코드는 stderr와 함께 오류로 전달', async () => {
    spawnMock.mockReturnValue(fakeChild('', 'Please login first', 1));
    const provider = new KimiProvider(baseConfig());
    await expect(provider.execute(baseOptions())).rejects.toThrow(/Please login first/);
  });
});

describe('KimiProvider.executeStream', () => {
  it('assistant 메시지를 단계별 delta로 내보낸 뒤 추정 usage와 done을 생성', async () => {
    spawnMock.mockReturnValue(fakeChild(kimiRecords(
      { role: 'assistant', content: 'first ' },
      { role: 'tool', tool_call_id: 'tool-1', content: 'result' },
      { role: 'assistant', content: 'second' },
      { role: 'meta', type: 'session.resume_hint', session_id: 'session-1' },
    )));

    const provider = new KimiProvider(baseConfig());
    const events: ProviderEvent[] = [];
    for await (const event of provider.executeStream(baseOptions({ stream: true }))) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'text_delta',
      'text_delta',
      'usage',
      'done',
    ]);
    expect((events[0] as { text: string }).text).toBe('first ');
    expect((events[1] as { text: string }).text).toBe('second');
    expect((events[2] as { type: 'usage'; usage: { totalTokens: number } }).usage.totalTokens)
      .toBeGreaterThan(0);
    expect((events[3] as { type: 'done'; finishReason: string }).finishReason).toBe('stop');
  });

  it('stream non-zero 종료 코드를 오류로 전달', async () => {
    spawnMock.mockReturnValue(fakeChild('', 'invalid model alias', 1));
    const provider = new KimiProvider(baseConfig());
    const consume = async () => {
      for await (const _event of provider.executeStream(baseOptions({ stream: true }))) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow(/invalid model alias/);
  });
});
