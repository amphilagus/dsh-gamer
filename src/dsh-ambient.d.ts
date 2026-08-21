/**
 * Ambient DSH types so this bundle can `prepare` / tsdown without installing
 * unpublished `@deepseek-ai/*` packages. At runtime the host profile resolves
 * the real modules (same pattern as dsh-literature).
 */

declare module '@deepseek-ai/dsh-llm' {
  export interface GenerateOptions {
    sessionId?: string
  }
  export type StreamChunk =
    | { type: 'block-start' }
    | { type: 'text-delta' }
    | { type: 'reasoning-delta' }
    | { type: 'tool-call-delta' }
    | { type: 'block-end' }
    | { type: 'usage' }
    | { type: 'finish' }
  export interface UserMessage {
    id: string
    role: 'user'
    content: Array<{ type: 'text'; text: string }>
    source: unknown
  }
  export function createUserMessage(input: {
    content: Array<{ type: 'text'; text: string }>
    source: unknown
  }): UserMessage
  export function boundContextSummary(summary: string): string
}

declare module '@deepseek-ai/dsh-agent' {
  import type { UserMessage } from '@deepseek-ai/dsh-llm'
  export type PreStepDecision =
    | { kind: 'reject' }
    | { kind: 'enter'; messages: UserMessage[] }
}

declare module '@deepseek-ai/cordis' {
  import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
  export interface Context {
    tools: {
      register: (tool: unknown) => unknown
      guard: (
        fn: (execution: { name: string; arguments: unknown; agent?: unknown }) => string | undefined,
      ) => () => void
    }
    skills: {
      register: (skill: {
        name: string
        description: string
        source: 'runtime'
        content: string
      }) => unknown
    }
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => unknown
    }
    effect: (fn: () => (() => void) | void) => void
    logger?: (name: string) => { info: (msg: string) => void; warn: (msg: string) => void }
    on(
      event: 'agent/pre-step',
      listener: (
        payload: {
          agent: {
            id: string
            status?: 'idle' | 'running'
            inject?: (message: unknown) => void
            followup?: (message: unknown) => void
          }
          signal: AbortSignal
        },
        next: () => Promise<PreStepDecision>,
      ) => Promise<PreStepDecision>,
    ): () => void
    on(
      event: 'agent/status',
      listener: (payload: {
        agent: {
          id: string
          status?: 'idle' | 'running'
          inject?: (message: unknown) => void
          followup?: (message: unknown) => void
        }
        status: 'idle' | 'running'
      }) => void,
    ): () => void
    on(
      event: 'llm/stream',
      listener: (
        options: import('@deepseek-ai/dsh-llm').GenerateOptions,
        next: () => AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,
      ) => AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,
    ): () => void
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(options: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: unknown
      render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
    }
    timeoutMs?: number
    isConcurrencySafe?: (args: unknown) => boolean
    execute: (
      args: Record<string, unknown>,
      exec: {
        signal: AbortSignal
        agent?: {
          id: string
          status?: 'idle' | 'running'
          inject?: (message: unknown) => void
          followup?: (message: unknown) => void
        }
      },
    ) => Promise<unknown>
  }): unknown
}

declare module '@deepseek-ai/dsh-skill' {}
declare module '@deepseek-ai/dsh-system-prompt' {}
