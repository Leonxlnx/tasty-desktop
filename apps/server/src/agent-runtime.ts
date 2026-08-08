import type { ContentBlock, SessionConfigOption, Usage } from "@agentclientprotocol/sdk";

export type RuntimeSession = { sessionId: string; cwd?: string | null; title?: string | null; configOptions?: SessionConfigOption[] | null };
export type RuntimePromptResult = { stopReason: string; usage?: Usage | null };
export type SubagentInspection = {
  threadId: string; title: string; role?: string; status: string;
  turns: Array<{ turnId: string; status: string; durationMs?: number; items: Array<{ id: string; kind: "message" | "reasoning" | "action"; title: string; text?: string; status?: string }> }>;
};

export interface AgentRuntime {
  start(): Promise<unknown>;
  newSession(cwd: string): Promise<RuntimeSession>;
  listSessions(cwd?: string): Promise<{ sessions: RuntimeSession[] }>;
  resumeSession(sessionId: string, cwd: string): Promise<{ configOptions?: SessionConfigOption[] | null }>;
  loadSession(sessionId: string, cwd: string): Promise<{ configOptions?: SessionConfigOption[] | null }>;
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<{ configOptions?: SessionConfigOption[] | null }>;
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<RuntimePromptResult>;
  hasSession(sessionId: string): boolean;
  isOpen(): boolean;
  respondToPermission(requestId: string, optionId?: string): void;
  cancel(sessionId: string): Promise<void>;
  inspectSubagent?(threadId: string): Promise<SubagentInspection>;
  stopSubagent?(threadId: string): Promise<void>;
  close(): Promise<void>;
}
