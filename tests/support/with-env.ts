// Runs a function with some environment variables set, then puts every one back exactly as it was. In-process
// tests start from the safe defaults set in support/env.ts and change only what the test is about.

export type Vars = Record<string, string | undefined>;

export async function withEnv<T>(vars: Vars, fn: () => Promise<T> | T): Promise<T> {
  const saved: Vars = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
