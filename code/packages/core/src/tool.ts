import type { z } from 'zod';
import type { ContentBlock, ToolResultContent } from './types.js';
import type { Runtime } from './runtime/index.js';

/** Tool contract (DD-4). Zod is the single schema source (ADR-07). */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network' | 'meta';

export interface ToolProgress {
  note: string;
}

export interface ToolOutput {
  content: ToolResultContent[];
  isError?: boolean;
  /** Execution facts used to build evidence receipts. */
  meta?: ToolResultMeta;
}

export interface ToolResultMeta {
  exitCode?: number;
  command?: string;
  paths?: string[];
  testStats?: { total: number; passed: number; failed: number; skipped: number };
  trust?: 'trusted' | 'workspace' | 'untrusted';
}

export interface PromptContext {
  cwd: string;
}

export interface ToolContext {
  runtime: Runtime;
  cwd: string;
  signal: AbortSignal;
  /** Emit progress to the event stream (tool.progress). */
  progress(note: string): void;
}

export interface Tool<I = unknown> {
  name: string;
  description: string | ((ctx: PromptContext) => string);
  /** Zod schema; I is its output type. Input side is `unknown` (model args). */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  risk: ToolRisk;
  readOnly: boolean;
  concurrencySafe: boolean;
  timeoutMs?: number;
  /** Parameters used for permission rule matching (path / command / url). */
  permissionSubject?(input: I): PermissionSubject;
  execute(input: I, ctx: ToolContext): Promise<ToolOutput> | AsyncGenerator<ToolProgress, ToolOutput>;
}

export interface PermissionSubject {
  path?: string;
  command?: string;
  url?: string;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name} (FR-021: names are unique)`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  definitions(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.list().map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : t.description({ cwd: '' }),
      inputSchema: zodToJsonSchema(t.inputSchema),
    }));
  }
}

/**
 * Zod → JSON Schema conversion (ADR-07). Covers every construct our own tools
 * use plus the common ones MCP servers hand us; anything exotic degrades to
 * `{}` (any) rather than throwing, which is what MCP tolerates too.
 *
 * Two Zod internals matter here:
 * - The kind lives in `_def.typeName` (v3) or `_def.type` (v4).
 * - `_def.shape` is a *function* on v3.25+ objects, an object before that and
 *   in v4 — calling `Object.entries` on the function silently yields no
 *   properties, which ships an empty parameter schema to the model.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = schema._def as Record<string, unknown>;
  const kind = (def.typeName ?? def.type) as string | undefined;
  const out = convert(def, kind);
  const description = def.description;
  if (typeof description === 'string' && description !== '') out.description = description;
  return out;
}

function convert(def: Record<string, unknown>, kind: string | undefined): Record<string, unknown> {
  switch (kind) {
    case 'ZodObject':
    case 'object': {
      const shapeRaw = def.shape;
      const shape = (typeof shapeRaw === 'function'
        ? (shapeRaw as () => Record<string, z.ZodType>)()
        : shapeRaw) as Record<string, z.ZodType> | undefined;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape ?? {})) {
        properties[key] = zodToJsonSchema(value);
        const inner = value._def as Record<string, unknown>;
        const innerKind = (inner.typeName ?? inner.type) as string | undefined;
        // ZodDefault supplies the value when omitted, so it is not required.
        if (innerKind !== 'ZodOptional' && innerKind !== 'optional' && innerKind !== 'ZodDefault' && innerKind !== 'default') {
          required.push(key);
        }
      }
      return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties };
    }
    case 'ZodString':
    case 'string': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const c of checksOf(def)) {
        if (c.kind === 'min' || c.kind === 'min_length') out.minLength = c.value;
        if (c.kind === 'max' || c.kind === 'max_length') out.maxLength = c.value;
        if (c.kind === 'regex' || c.kind === 'regex_pattern') out.pattern = String(c.value);
      }
      return out;
    }
    case 'ZodNumber':
    case 'number': {
      const out: Record<string, unknown> = { type: 'number' };
      for (const c of checksOf(def)) {
        if (c.kind === 'min' || c.kind === 'greater_than') out.minimum = c.value;
        if (c.kind === 'max' || c.kind === 'less_than') out.maximum = c.value;
        if (c.kind === 'int') out.type = 'integer';
      }
      return out;
    }
    case 'ZodBoolean':
    case 'boolean':
      return { type: 'boolean' };
    case 'ZodNull':
    case 'null':
      return { type: 'null' };
    case 'ZodDate':
    case 'date':
      return { type: 'string', format: 'date-time' };
    case 'ZodAny':
    case 'ZodUnknown':
    case 'any':
    case 'unknown':
      return {};
    case 'ZodArray':
    case 'array':
      return { type: 'array', items: zodToJsonSchema((def.type ?? def.element) as z.ZodType) };
    case 'ZodTuple':
    case 'tuple': {
      const items = ((def.items ?? []) as z.ZodType[]).map(zodToJsonSchema);
      return { type: 'array', items, minItems: items.length, maxItems: items.length };
    }
    case 'ZodEnum':
    case 'enum':
      return { type: 'string', enum: def.values ?? def.entries };
    case 'ZodNativeEnum':
    case 'nativeEnum': {
      const values = def.values as Record<string, string | number>;
      return { enum: Object.values(values) };
    }
    case 'ZodLiteral':
    case 'literal': {
      const value = def.value;
      return { enum: [value], ...(typeof value === 'string' ? { type: 'string' } : typeof value === 'number' ? { type: 'number' } : typeof value === 'boolean' ? { type: 'boolean' } : {}) };
    }
    case 'ZodOptional':
    case 'optional':
    case 'ZodNullable':
    case 'nullable':
    case 'ZodReadonly':
    case 'readonly':
      return zodToJsonSchema((def.innerType ?? def.inner) as z.ZodType);
    case 'ZodDefault':
    case 'default': {
      const inner = zodToJsonSchema((def.innerType ?? def.inner) as z.ZodType);
      try {
        return { ...inner, default: (def.defaultValue as () => unknown)() };
      } catch {
        return inner;
      }
    }
    case 'ZodEffects':
    case 'ZodPipeline':
    case 'pipe': {
      // Refinements/transforms do not change the wire shape — unwrap to the source schema.
      return zodToJsonSchema((def.schema ?? def.innerType ?? def.in) as z.ZodType);
    }
    case 'ZodRecord':
    case 'record': {
      const valueType = (def.valueType ?? def.value) as z.ZodType | undefined;
      return {
        type: 'object',
        additionalProperties: valueType !== undefined ? zodToJsonSchema(valueType) : true,
      };
    }
    case 'ZodUnion':
    case 'union':
    case 'ZodDiscriminatedUnion':
    case 'discriminatedUnion': {
      const options = (def.options as z.ZodType[] | Map<unknown, z.ZodType> | undefined) ?? [];
      const list = Array.isArray(options) ? options : [...options.values()];
      return { anyOf: list.map(zodToJsonSchema) };
    }
    case 'ZodIntersection':
    case 'intersection':
      return { allOf: [zodToJsonSchema(def.left as z.ZodType), zodToJsonSchema(def.right as z.ZodType)] };
    case 'ZodLazy':
    case 'lazy':
      // Recursive schemas: one level is enough for tool parameters.
      return {};
    default:
      return {};
  }
}

/** v3 stores `{kind, value}` checks; v4 nests them under `_zod.def`. */
function checksOf(def: Record<string, unknown>): { kind: string; value: unknown }[] {
  const raw = (def.checks ?? []) as Record<string, unknown>[];
  return raw.map((c) => {
    const inner = (c._zod as { def?: Record<string, unknown> } | undefined)?.def ?? c;
    const kind = String(inner.check ?? inner.kind ?? '');
    const value = inner.value ?? inner.minimum ?? inner.maximum ?? inner.min ?? inner.max;
    return { kind, value };
  });
}


export function textContent(text: string): ToolResultContent[] {
  return [{ type: 'text', text }];
}

export function isTextBlock(b: ContentBlock): b is Extract<ContentBlock, { type: 'text' }> {
  return b.type === 'text';
}
