import type { ContentBlock, SessionConfigOption, Usage } from "@agentclientprotocol/sdk";

export type RuntimeSession = { sessionId: string; cwd?: string; title?: string; configOptions?: SessionConfigOption[] };
export type RuntimePromptResult = { stopReason: string; usage?: Usage };

export interface AgentRuntime {
  start(): Promise<unknown>;
  newSession(cwd: string): Promise<RuntimeSession>;
  listSessions(cwd?: string): Promise<{ sessions: RuntimeSession[] }>;
  resumeSession(sessionId: string, cwd: string): Promise<RuntimeSession>;
  loadSession(sessionId: string, cwd: string): Promise<RuntimeSession>;
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<{ configOptions?: SessionConfigOption[] }>;
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<RuntimePromptResult>;
  hasSession(sessionId: string): boolean;
  isOpen(): boolean;
  respondToPermission(requestId: string, optionId?: string): void;
  cancel(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
