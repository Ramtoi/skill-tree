import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every Playwright spec under app/e2e must take `test` from `./fixtures`, so
// the automatic browser-error check runs for it. A spec that imports `test`
// straight from "@playwright/test" skips that check without any failure.
// Type-only imports (`import type { Page } from "@playwright/test"` or an
// inline `import("@playwright/test").Page`) are fine.

const E2E_DIR = join(process.cwd(), "e2e"); // vitest runs from `app/`

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...specFiles(full));
    else if (entry.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const VALUE_IMPORT_RE = /import\s+(?!type\b)\{([^}]*)\}\s*from\s*["']@playwright\/test["']/g;

/** Names imported as values (not `type X`) from "@playwright/test". */
function playwrightValueImports(source: string): string[] {
  const names: string[] = [];
  let m: RegExpExecArray | null;
  VALUE_IMPORT_RE.lastIndex = 0;
  while ((m = VALUE_IMPORT_RE.exec(source))) {
    for (const raw of m[1].split(",")) {
      const part = raw.trim();
      if (!part || part.startsWith("type ")) continue;
      names.push(part.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

describe("e2e specs import test from ./fixtures", () => {
  const files = specFiles(E2E_DIR);

  it("finds the spec files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("the import check catches a direct test import", () => {
    expect(playwrightValueImports('import { test, expect } from "@playwright/test";')).toEqual(["test", "expect"]);
    expect(playwrightValueImports("import { test as base } from '@playwright/test';")).toEqual(["test"]);
    expect(playwrightValueImports('import type { Page } from "@playwright/test";')).toEqual([]);
    expect(playwrightValueImports('import { type Page } from "@playwright/test";')).toEqual([]);
  });

  it.each(files.map((file) => [file.slice(E2E_DIR.length + 1), file]))(
    "%s does not import test from @playwright/test",
    (_name, file) => {
      expect(playwrightValueImports(readFileSync(file, "utf-8"))).not.toContain("test");
    },
  );
});
