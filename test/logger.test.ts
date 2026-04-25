/**
 * Logger unit tests. The logger is tiny but its filtering behavior is a
 * load-bearing part of the prod setup — a regression (e.g., `info` leaking
 * through when LOG_LEVEL=error) would flood pm2 logs with the bulk of the
 * bot's heartbeat output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger';

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const stub = vi.fn((chunk: unknown) => {
    lines.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  (process.stdout.write as unknown) = stub;
  return {
    lines,
    restore: () => {
      (process.stdout.write as unknown) = original;
    },
  };
}

describe('createLogger', () => {
  let cap: { lines: string[]; restore: () => void };

  beforeEach(() => {
    cap = captureStdout();
  });
  afterEach(() => {
    cap.restore();
  });

  it('filters by threshold: debug is suppressed when level is info', () => {
    const log = createLogger('info');
    log.debug('hidden', { a: 1 });
    log.info('shown', { b: 2 });
    expect(cap.lines).toHaveLength(1);
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed.msg).toBe('shown');
    expect(parsed.level).toBe('info');
    expect(parsed.b).toBe(2);
  });

  it('allows everything at debug level', () => {
    const log = createLogger('debug');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(cap.lines).toHaveLength(4);
  });

  it('suppresses everything below error when set to error', () => {
    const log = createLogger('error');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(cap.lines).toHaveLength(1);
    expect(JSON.parse(cap.lines[0]!).msg).toBe('e');
  });

  it('emits one JSON line per call with ts/level/msg plus fields', () => {
    const log = createLogger('debug');
    log.info('boot', { version: '1.0' });
    expect(cap.lines[0]!.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed).toEqual(
      expect.objectContaining({ level: 'info', msg: 'boot', version: '1.0' }),
    );
    expect(typeof parsed.ts).toBe('string');
    // ISO timestamp — any reasonable parse should yield a valid date.
    expect(Number.isNaN(new Date(parsed.ts).valueOf())).toBe(false);
  });

  it('handles missing fields cleanly', () => {
    const log = createLogger('info');
    log.warn('oops');
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed.msg).toBe('oops');
    expect(parsed.level).toBe('warn');
  });
});
