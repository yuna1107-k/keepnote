import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { runtime } from './runtime.ts';

export const newId = () => crypto.randomUUID();
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const now = () => Date.now();

export function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 426 | 429 | 500 | 501 | 502, message: string): never {
  throw new HTTPException(status, { message });
}

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    fail(400, 'リクエストの形式が正しくありません');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(400, `入力が正しくありません: ${issue?.path.join('.') || ''} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}

export function clientIp(c: Context): string {
  return runtime().clientIp(c);
}

export async function rateLimit(c: Context, scope: string) {
  if (await runtime().rateLimited(`${scope}:${clientIp(c)}`)) {
    fail(429, '試行回数が多すぎます。しばらく待ってから再度お試しください');
  }
}

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (m) => '\\' + m);
}
