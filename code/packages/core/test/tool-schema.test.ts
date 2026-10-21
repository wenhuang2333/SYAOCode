import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, textContent, zodToJsonSchema, type Tool } from '../src';

/**
 * ADR-07 regression guard: the JSON Schema sent to the model must describe the
 * real parameters. A converter that returns `{type:'object',properties:{}}`
 * makes the model emit empty tool arguments, which then fails validation.
 */

function props(schema: Record<string, unknown>): Record<string, unknown> {
  return (schema.properties ?? {}) as Record<string, unknown>;
}

describe('zodToJsonSchema', () => {
  it('emits object properties and required from a v3 object schema (shape is a function)', () => {
    const schema = zodToJsonSchema(z.object({ path: z.string(), content: z.string() }));
    expect(schema.type).toBe('object');
    expect(Object.keys(props(schema))).toEqual(['path', 'content']);
    expect(schema.required).toEqual(['path', 'content']);
  });

  it('keeps optional and defaulted fields out of required', () => {
    const schema = zodToJsonSchema(
      z.object({
        path: z.string().min(1),
        offset: z.number().int().optional(),
        limit: z.number().default(100),
        flag: z.boolean().optional(),
      }),
    );
    expect(schema.required).toEqual(['path']);
    expect(props(schema)).toHaveProperty('offset');
    expect(props(schema)).toHaveProperty('limit');
  });

  it('carries descriptions, string bounds, arrays, enums and unions', () => {
    const schema = zodToJsonSchema(
      z.object({
        pattern: z.string().min(1).max(20).describe('glob pattern'),
        tags: z.array(z.string()),
        mode: z.enum(['fast', 'safe']),
        target: z.union([z.string(), z.number()]),
        replace_all: z.boolean().optional(),
      }),
    );
    const p = props(schema) as Record<string, Record<string, unknown>>;
    expect(p.pattern).toMatchObject({ type: 'string', minLength: 1, maxLength: 20, description: 'glob pattern' });
    expect(p.tags).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(p.mode).toMatchObject({ type: 'string', enum: ['fast', 'safe'] });
    expect(p.target).toHaveProperty('anyOf');
  });

  it('unwraps refinements/transforms and handles records', () => {
    const refined = zodToJsonSchema(z.object({ path: z.string().refine((v) => v.length > 0) }));
    expect(Object.keys(props(refined))).toEqual(['path']);
    const record = zodToJsonSchema(z.record(z.string(), z.number()));
    expect(record).toMatchObject({ type: 'object', additionalProperties: { type: 'number' } });
  });

  it('never throws on exotic schemas and degrades to a permissive schema', () => {
    expect(zodToJsonSchema(z.any())).toEqual({});
    expect(zodToJsonSchema(z.lazy(() => z.string()))).toEqual({});
  });

  it('describes every registered tool with real parameters (integration guard)', () => {
    const reg = new ToolRegistry();
    const tool = (name: string, schema: z.ZodType): Tool => ({
      name,
      description: name,
      inputSchema: schema,
      risk: 'read',
      readOnly: true,
      concurrencySafe: true,
      execute: async () => ({ content: textContent('ok') }),
    });
    reg.register(tool('read', z.object({ path: z.string(), offset: z.number().optional() })));
    reg.register(tool('write', z.object({ path: z.string(), content: z.string() })));
    reg.register(tool('bash', z.object({ command: z.string(), timeoutMs: z.number().optional() })));
    for (const def of reg.definitions()) {
      const schema = def.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(Object.keys(props(schema)).length).toBeGreaterThan(0);
    }
    const write = reg.definitions().find((d) => d.name === 'write')!;
    expect((write.inputSchema as Record<string, unknown>).required).toEqual(['path', 'content']);
  });
});
