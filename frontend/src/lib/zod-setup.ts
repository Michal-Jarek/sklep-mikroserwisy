// zod 4 compiles object parsers with `new Function` and probes for it when a schema is created. The CSP
// of the frontend (script-src without 'unsafe-eval') blocks that and reports a violation, so zod runs
// without the compiler. Imported first in main.tsx, before any module creates a schema.
import { z } from 'zod';

z.config({ jitless: true });
