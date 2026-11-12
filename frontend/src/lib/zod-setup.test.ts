import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '@/lib/zod-setup';

describe('zod setup (CSP without unsafe-eval)', () => {
  it('turns off the zod compiler', () => {
    expect(z.config().jitless).toBe(true);
  });

  it('is the first import of main.tsx, before any module creates a schema', () => {
    const main = readFileSync(path.join(process.cwd(), 'src/main.tsx'), 'utf8');
    const firstImport = main.split('\n').find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import '@/lib/zod-setup';");
  });
});
