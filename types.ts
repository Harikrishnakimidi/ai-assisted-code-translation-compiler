
export enum ProgrammingLanguage {
  PYTHON = 'Python',
  JAVA = 'Java',
  CPP = 'C++',
  C = 'C'
}

// ─── Auth ────────────────────────────────────
export interface AuthUser {
  username: string;
  email: string;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
}

// ─── Stored History Entry (as returned by backend) ───
export interface HistoryEntry {
  id: string;
  sourceLanguage: ProgrammingLanguage;
  targetLanguage: ProgrammingLanguage;
  sourceCode: string;
  result: TranslationResult;
  timestamp: string;
}

// ─── Chat / Message ──────────────────────────
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface TranslationOptions {
  explain: boolean;
  beginnerFriendly: boolean;
  preservePerformance: boolean;
  strictMemorySafety: boolean;
}

export interface TranslationResult {
  code: string;
  explanation: string;
  notes: string;
  raw: string;
  versions?: { code: string; explanation: string; notes: string }[];
}

export interface TranslationRequest {
  sourceLanguage: ProgrammingLanguage;
  targetLanguage: ProgrammingLanguage;
  sourceCode: string;
  options: TranslationOptions;
  previousResults?: string[];
  feedback?: string;
}
