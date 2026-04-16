
import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { ProgrammingLanguage, TranslationOptions, TranslationResult, AuthUser } from './types';
import LanguageSelector from './components/LanguageSelector';
import CodeEditor from './components/CodeEditor';
import LoginPage from './components/LoginPage';
import RegisterPage from './components/RegisterPage';
import HistorySidebar from './components/HistorySidebar';
import TemplatesView from './components/TemplatesView';
import {
  getStoredToken,
  getStoredUser,
  clearPersistedAuth,
  apiGetHistory,
  apiSaveHistory,
  apiSaveChatMessage,
} from './services/authService';

type AuthView = 'login' | 'register';

interface TranslationTurn {
  id: string;
  sourceLanguage: ProgrammingLanguage;
  targetLanguage: ProgrammingLanguage;
  sourceCode: string;
  result: TranslationResult;
  timestamp?: string;
  activeVersionIndex?: number;
}

const App: React.FC = () => {
  // ── Auth state ──────────────────────────────
  const [authUser, setAuthUser] = useState<AuthUser | null>(getStoredUser);
  const [authToken, setAuthToken] = useState<string | null>(getStoredToken);
  const [authView, setAuthView] = useState<AuthView>('login');
  const [historyLoading, setHistoryLoading] = useState(false);

  const isAuthenticated = !!authUser && !!authToken;

  // ── Sidebar state ──────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 1024);
  // allHistory = every turn ever (populated from backend + appended on new translations)
  const [allHistory, setAllHistory] = useState<TranslationTurn[]>([]);
  // selectedHistoryId = which sidebar item is highlighted
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);

  // ── Translation state ──────────────────────
  const [sourceLanguage, setSourceLanguage] = useState<ProgrammingLanguage>(ProgrammingLanguage.PYTHON);
  const [targetLanguage, setTargetLanguage] = useState<ProgrammingLanguage>(ProgrammingLanguage.JAVA);
  const [sourceCode, setSourceCode] = useState<string>('');
  const [isTranslating, setIsTranslating] = useState(false);
  // history = current chat session (visible in main feed)
  const [history, setHistory] = useState<TranslationTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [view, setView] = useState<'chat' | 'templates'>('chat');
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({});
  const [showFeedback, setShowFeedback] = useState<Record<string, boolean>>({});

  const scrollRef = useRef<HTMLDivElement>(null);

  const [options, setOptions] = useState<TranslationOptions>({
    explain: true,
    beginnerFriendly: false,
    preservePerformance: true,
    strictMemorySafety: false
  });


  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [history, isTranslating]);

  // ── Load history from backend when authenticated ──
  useEffect(() => {
    if (!isAuthenticated) return;
    setHistoryLoading(true);
    apiGetHistory()
      .then((entries: any[]) => {
        const turns: TranslationTurn[] = entries.map((e) => ({
          id: e.id,
          sourceLanguage: e.sourceLanguage as ProgrammingLanguage,
          targetLanguage: e.targetLanguage as ProgrammingLanguage,
          sourceCode: e.sourceCode,
          result: e.result as TranslationResult,
          timestamp: e.timestamp,
        }));
        setAllHistory(turns); // populate sidebar
        // current session starts empty (new chat)
      })
      .catch(() => {/* backend may not be running */ })
      .finally(() => setHistoryLoading(false));
  }, [isAuthenticated]);

  // ── Auth handlers ──────────────────────────────
  const handleAuthSuccess = (user: AuthUser, token: string) => {
    setAuthUser(user);
    setAuthToken(token);
  };

  const handleLogout = () => {
    clearPersistedAuth();
    setAuthUser(null);
    setAuthToken(null);
    setHistory([]);
    setAllHistory([]);
    setSelectedHistoryId(null);
    setSourceCode('');
    setError(null);
  };

  const handleNewChat = () => {
    setHistory([]);
    setSelectedHistoryId(null);
    setSourceCode('');
    setError(null);
    setView('chat');
  };

  const handleSelectTurn = (turn: TranslationTurn) => {
    setHistory([turn]);
    setSelectedHistoryId(turn.id);
    setSourceCode('');
    setError(null);
    setView('chat');
  };

  const handleSelectTemplate = (code: string) => {
    setSourceCode(code);
    setView('chat');
    // We don't automatically trigger translation, letting user review the template first
  };

  const handleTranslate = useCallback(async () => {
    if (!sourceCode.trim() || isTranslating) return;

    setIsTranslating(true);
    setError(null);
    setSelectedHistoryId(null);

    if (isAuthenticated) {
      apiSaveChatMessage('user', `[${sourceLanguage} → ${targetLanguage}]\n\`\`\`\n${sourceCode}\n\`\`\``).catch(() => { });
    }

    try {
      const response = await translateCode({ sourceLanguage, targetLanguage, sourceCode, options });
      const newTurn: TranslationTurn = {
        id: crypto.randomUUID(),
        sourceLanguage,
        targetLanguage,
        sourceCode,
        result: response,
        timestamp: new Date().toISOString(),
        activeVersionIndex: 0
      };
      setHistory(prev => [...prev, newTurn]);
      setAllHistory(prev => [newTurn, ...prev]);
      setSourceCode('');

      if (isAuthenticated) {
        apiSaveHistory({ sourceLanguage, targetLanguage, sourceCode, result: response })
          .then((saved: any) => {
            const updated = { ...newTurn, id: saved.id, timestamp: saved.timestamp };
            setHistory(prev => prev.map(t => t.id === newTurn.id ? updated : t));
            setAllHistory(prev => prev.map(t => t.id === newTurn.id ? updated : t));
          })
          .catch(() => { });
        apiSaveChatMessage('assistant', `[${targetLanguage} Output]\n\`\`\`\n${response.code}\n\`\`\``).catch(() => { });
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setIsTranslating(false);
      setIsInputFocused(false);
    }
  }, [sourceCode, sourceLanguage, targetLanguage, options, isTranslating, isAuthenticated]);

  const handleRegenerate = useCallback(async (turn: TranslationTurn) => {
    if (isTranslating) return;

    setIsTranslating(true);
    setError(null);

    try {
      // Collect previous codes to avoid
      const previousCodes = [turn.result.code, ...(turn.result.versions?.map(v => v.code) || [])];
      const feedback = feedbackMap[turn.id];

      const response = await translateCode({
        sourceLanguage: turn.sourceLanguage,
        targetLanguage: turn.targetLanguage,
        sourceCode: turn.sourceCode,
        options,
        previousResults: previousCodes,
        feedback
      });

      const updatedResult: TranslationResult = {
        ...turn.result,
        versions: [
          ...(turn.result.versions || []),
          { code: turn.result.code, explanation: turn.result.explanation, notes: turn.result.notes }
        ],
        code: response.code,
        explanation: response.explanation,
        notes: response.notes
      };

      const updatedTurn: TranslationTurn = {
        ...turn,
        result: updatedResult,
        activeVersionIndex: (updatedResult.versions?.length || 0)
      };

      setHistory(prev => prev.map(t => t.id === turn.id ? updatedTurn : t));
      setAllHistory(prev => prev.map(t => t.id === turn.id ? updatedTurn : t));

      // Clear feedback for this turn
      setFeedbackMap(prev => ({ ...prev, [turn.id]: '' }));
      setShowFeedback(prev => ({ ...prev, [turn.id]: false }));

      // Persist to backend if needed (optional for now as we don't have separate version storage in backend)
      if (isAuthenticated) {
        apiSaveHistory({
          sourceLanguage: turn.sourceLanguage,
          targetLanguage: turn.targetLanguage,
          sourceCode: turn.sourceCode,
          result: updatedResult
        }).catch(() => { });
      }
    } catch (err: any) {
      setError(err.message || "Regeneration failed.");
    } finally {
      setIsTranslating(false);
    }
  }, [options, isTranslating, isAuthenticated, feedbackMap]);

  const handleSwitchVersion = (turn: TranslationTurn, index: number) => {
    const versions = turn.result.versions || [];
    const allVersions = [...versions, { code: turn.result.code, explanation: turn.result.explanation, notes: turn.result.notes }];

    // The current main version is stored in turn.result.code etc.
    // If index is different from current, we might want to swap them or just track active index.
    // For simplicity, let's keep the latest as the main one and allow switching back.

    setHistory(prev => prev.map(t => t.id === turn.id ? { ...t, activeVersionIndex: index } : t));
    setAllHistory(prev => prev.map(t => t.id === turn.id ? { ...t, activeVersionIndex: index } : t));
  };

  // ── Auth gate ─────────────────────────────────
  if (!isAuthenticated) {
    if (authView === 'register') {
      return <RegisterPage onRegister={handleAuthSuccess} onGoToLogin={() => setAuthView('login')} />;
    }
    return <LoginPage onLogin={handleAuthSuccess} onGoToRegister={() => setAuthView('register')} />;
  }

  return (
    <div className={`flex h-screen w-full bg-[#050505] text-white selection:bg-indigo-500/30 overflow-hidden ${sidebarOpen ? 'overflow-hidden' : ''}`}>

      {/* ── Overlay for Mobile Sidebar ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[55] sm:hidden transition-opacity duration-300"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── History Sidebar ── */}
      <div className={`fixed inset-y-0 left-0 z-[60] sm:relative sm:z-30 transition-transform duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] ${sidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}`}>
        <HistorySidebar
          allHistory={allHistory}
          onNewChat={handleNewChat}
          onViewTemplates={() => { setView('templates'); if (window.innerWidth < 640) setSidebarOpen(false); }}
          onSelectTurn={(turn) => { handleSelectTurn(turn); if (window.innerWidth < 640) setSidebarOpen(false); }}
          selectedId={selectedHistoryId}
          open={sidebarOpen}
          onToggle={() => setSidebarOpen(o => !o)}
          username={authUser!.username}
        />
      </div>

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex flex-col relative bg-[#050505] w-full min-w-0 h-full overflow-hidden">

        {/* Dynamic Background */}
        <div className="aura-orb top-[-10%] left-1/2 -translate-x-1/2 opacity-30"></div>

        {/* Header bar */}
        <header className="px-4 sm:px-6 md:px-8 py-4 md:py-5 flex items-center justify-between z-40 shrink-0">
          {/* Sidebar toggle on mobile */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(o => !o)}
              className="glass w-8 h-8 flex items-center justify-center rounded-xl text-neutral-500 hover:text-white hover:bg-white/[0.06] transition-all border border-white/[0.05]"
              title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <div className="glass px-3 md:px-4 py-1.5 md:py-2 rounded-xl flex items-center gap-2 md:gap-2.5 cursor-pointer hover:bg-white/[0.06] transition-all group">
              <span className="text-[10px] md:text-[12px] font-semibold text-neutral-300 group-hover:text-white transition-colors">AI Engine v2.5</span>
              <svg className="text-neutral-500 group-hover:text-neutral-300 transition-colors" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m6 9 6 6 6-6" /></svg>
            </div>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <div className="flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1 md:py-1.5 rounded-full border border-white/[0.05] bg-white/[0.01]">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]"></div>
              <span className="text-[8px] md:text-[10px] font-bold text-neutral-500 uppercase tracking-widest hidden sm:inline">Active</span>
            </div>
            {/* User badge */}
            <div className="glass px-3 py-1.5 rounded-xl flex items-center gap-2 border border-white/[0.05]">
              <div className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
                <span className="text-[9px] font-bold text-indigo-400">
                  {authUser!.username.charAt(0).toUpperCase()}
                </span>
              </div>
              <span className="text-[11px] font-semibold text-neutral-300 hidden sm:inline max-w-[100px] truncate">{authUser!.username}</span>
            </div>
            {/* Logout */}
            <button
              onClick={handleLogout}
              title="Sign out"
              className="glass w-8 h-8 md:w-9 md:h-9 flex items-center justify-center rounded-xl cursor-pointer hover:bg-red-500/10 hover:border-red-500/20 transition-all border border-white/[0.05] text-neutral-500 hover:text-red-400"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </header>

        {view === 'templates' ? (
          <TemplatesView onSelectTemplate={handleSelectTemplate} />
        ) : (
          <>
            {/* Mobile collapse toggle — visible only on small screens when history exists */}
            {history.length > 0 && (
              <div className="flex sm:hidden justify-center pb-2 px-4 z-40 shrink-0">
                <button
                  onClick={() => setChatCollapsed(c => !c)}
                  className="flex items-center gap-2 px-4 py-2 rounded-full glass border border-white/[0.06] text-neutral-400 hover:text-white transition-all text-[10px] font-bold uppercase tracking-widest"
                >
                  {chatCollapsed ? (
                    <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m18 15-6-6-6 6" /></svg>Show Results</>
                  ) : (
                    <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m6 9 6 6 6-6" /></svg>Hide Results</>
                  )}
                </button>
              </div>
            )}

            {/* Chat Feed */}
            <div
              ref={scrollRef}
              className={`overflow-y-auto hide-scrollbar px-3 sm:px-6 md:px-8 pb-4 space-y-8 sm:space-y-16 transition-all duration-300
                ${chatCollapsed ? 'h-0 overflow-hidden opacity-0 pointer-events-none sm:flex-1 sm:h-auto sm:opacity-100 sm:pointer-events-auto' : 'flex-1'}
              `}
            >
              {/* Viewing past translation banner */}
              {selectedHistoryId && history.length === 1 && (
                <div className="max-w-[1200px] mx-auto pt-2">
                  <div className="flex items-center justify-between px-5 py-3 rounded-2xl border border-indigo-500/15 bg-indigo-500/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-indigo-400 shrink-0">
                        <path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" />
                      </svg>
                      <span className="text-[11px] text-indigo-400/80 font-medium">Viewing a past translation</span>
                    </div>
                    <button
                      onClick={handleNewChat}
                      className="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 uppercase tracking-wider transition-colors"
                    >
                      New Chat →
                    </button>
                  </div>
                </div>
              )}
              {/* History loading */}
              {historyLoading && (
                <div className="flex items-center justify-center py-12">
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 animate-spin"></div>
                    <span className="text-[11px] text-neutral-600 font-medium">Loading history…</span>
                  </div>
                </div>
              )}

              {history.length === 0 && !isTranslating && !historyLoading && (
                <div className="flex flex-col items-center justify-center text-center min-h-full py-8 sm:py-12 animate-in fade-in zoom-in-95 duration-1000">
                  <div className="orb-container mb-6 sm:mb-10 scale-75 sm:scale-100">
                    <div className="orb-glow"></div>
                    <div className="orb-inner"></div>
                  </div>
                  <h2 className="text-[20px] sm:text-[32px] md:text-[36px] font-light tracking-tight leading-tight mb-1.5 px-4">
                    Good Morning, <span className="font-semibold text-white">{authUser!.username}</span>.
                  </h2>
                  <h3 className="text-[13px] sm:text-[22px] md:text-[28px] font-light text-neutral-500 tracking-tight leading-tight mb-6 sm:mb-12 px-4">
                    How can the engine assist you today?
                  </h3>

                  {/* Horizontal scroll cards on mobile, grid on desktop */}
                  <div className="w-full max-w-[900px] px-4 sm:px-1">
                    <div className="flex sm:grid sm:grid-cols-3 gap-3 sm:gap-6 overflow-x-auto sm:overflow-visible pb-4 sm:pb-0 hide-scrollbar snap-x snap-mandatory">
                      <div className="glass rounded-[24px] sm:rounded-[28px] p-5 sm:p-6 hover:bg-white/[0.04] transition-all cursor-pointer text-left shrink-0 w-[80vw] sm:w-auto snap-start" onClick={() => setView('templates')}>
                        <span className="text-[13px] sm:text-[14px] font-semibold text-neutral-200 block mb-1.5">Clean Refactor</span>
                        <p className="text-[11px] sm:text-[12px] text-neutral-500 leading-relaxed font-medium">Turn manual Java logic into concise Pythonic expressions.</p>
                      </div>
                      <div className="glass rounded-[24px] sm:rounded-[28px] p-5 sm:p-6 hover:bg-white/[0.04] transition-all cursor-pointer text-left shrink-0 w-[80vw] sm:w-auto snap-start" onClick={() => setView('templates')}>
                        <span className="text-[13px] sm:text-[14px] font-semibold text-neutral-200 block mb-1.5">Performance RAII</span>
                        <p className="text-[11px] sm:text-[12px] text-neutral-500 leading-relaxed font-medium">Ensure memory safety when mapping to low-level C++ containers.</p>
                      </div>
                      <div className="glass rounded-[24px] sm:rounded-[28px] p-5 sm:p-6 hover:bg-white/[0.04] transition-all cursor-pointer text-left shrink-0 w-[80vw] sm:w-auto snap-start" onClick={() => setView('templates')}>
                        <span className="text-[13px] sm:text-[14px] font-semibold text-neutral-200 block mb-1.5">Semantic Audit</span>
                        <p className="text-[11px] sm:text-[12px] text-neutral-500 leading-relaxed font-medium">Detailed analysis of every logic gate during transpilation.</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {history.map((turn) => {
                const versions = turn.result.versions || [];
                const allVersions = [...versions, { code: turn.result.code, explanation: turn.result.explanation, notes: turn.result.notes }];
                const activeIdx = turn.activeVersionIndex ?? (allVersions.length - 1);
                const activeVersion = allVersions[activeIdx];

                return (
                  <div key={turn.id} className="w-full max-w-[1200px] mx-auto space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-700">

                    {/* Comparison Card (Two Grids) */}
                    <div className="glass rounded-[40px] overflow-hidden shadow-[0_50px_100px_rgba(0,0,0,0.5)] border-white/[0.04] flex flex-col">

                      {/* Comparison Header */}
                      <div className="px-4 sm:px-6 md:px-10 py-4 md:py-6 border-b border-white/[0.02] flex flex-col sm:flex-row items-start sm:items-center justify-between bg-white/[0.01] gap-4">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-6">
                          <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-neutral-500"></div>
                            <span className="text-[10px] md:text-[11px] font-bold text-neutral-400 uppercase tracking-widest">{turn.sourceLanguage} Logic</span>
                          </div>
                          <div className="text-neutral-700">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]"></div>
                            <span className="text-[10px] md:text-[11px] font-bold text-white uppercase tracking-widest">{turn.targetLanguage} Mapping</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {allVersions.length > 1 && (
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/[0.03] border border-white/[0.05] mr-2">
                              {allVersions.map((_, i) => (
                                <button
                                  key={i}
                                  onClick={() => handleSwitchVersion(turn, i)}
                                  className={`w-2 h-2 rounded-full transition-all ${i === activeIdx ? 'bg-indigo-500 shadow-[0_0_8px_#6366f1]' : 'bg-neutral-800 hover:bg-neutral-600'}`}
                                  title={`Switch to Version ${i + 1}`}
                                />
                              ))}
                            </div>
                          )}
                          <button
                            onClick={() => setShowFeedback(prev => ({ ...prev, [turn.id]: !prev[turn.id] }))}
                            className={`flex items-center gap-2 px-3 md:px-4 py-1.5 rounded-full glass transition-all text-[9px] md:text-[10px] font-bold uppercase tracking-widest ${showFeedback[turn.id] ? 'text-indigo-400 bg-indigo-500/10' : 'text-neutral-400 hover:text-white'}`}
                            title="Provide feedback on this translation"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                            <span>Feedback</span>
                          </button>
                          <button
                            onClick={() => handleRegenerate(turn)}
                            disabled={isTranslating}
                            className="flex items-center gap-2 px-3 md:px-4 py-1.5 rounded-full glass hover:bg-white/5 transition-all text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-neutral-400 hover:text-indigo-400 disabled:opacity-50"
                            title="Generate a different approach"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={isTranslating ? 'animate-spin' : ''}>
                              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                              <path d="M21 3v5h-5" />
                            </svg>
                            <span className="hidden sm:inline">Try Again</span>
                            <span className="sm:hidden">Retry</span>
                          </button>
                          <button
                            onClick={() => navigator.clipboard.writeText(activeVersion.code)}
                            className="flex items-center gap-2 px-3 md:px-4 py-1.5 rounded-full glass hover:bg-white/5 transition-all text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-neutral-400 hover:text-white"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                            <span className="hidden sm:inline">Copy Result</span>
                            <span className="sm:hidden">Copy</span>
                          </button>
                        </div>
                      </div>

                      {showFeedback[turn.id] && (
                        <div className="px-4 sm:px-6 md:px-10 py-3 bg-white/[0.02] border-b border-white/[0.02] animate-in slide-in-from-top-2 duration-300">
                          <div className="flex items-center gap-3">
                            <input
                              type="text"
                              placeholder="How should I fix or adjust this translation? (e.g., 'Make it more concise', 'Use a different library')..."
                              value={feedbackMap[turn.id] || ''}
                              onChange={(e) => setFeedbackMap(prev => ({ ...prev, [turn.id]: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && handleRegenerate(turn)}
                              className="flex-1 bg-transparent border-none outline-none focus:ring-0 text-[11px] text-neutral-300 placeholder:text-neutral-600 font-medium"
                              autoFocus
                            />
                            <button
                              onClick={() => handleRegenerate(turn)}
                              disabled={isTranslating || !feedbackMap[turn.id]?.trim()}
                              className="px-3 py-1 rounded-lg bg-indigo-500/80 text-white text-[9px] font-bold uppercase tracking-widest hover:bg-indigo-500 transition-all disabled:opacity-50"
                            >
                              Go
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Two Columns Grid - Code not hidden */}
                      <div className="grid grid-cols-1 lg:grid-cols-2">
                        {/* Source Grid */}
                        <div className="p-5 sm:p-8 md:p-10 border-b lg:border-b-0 lg:border-r border-white/[0.02] bg-white/[0.005]">
                          <div className="mb-4 md:mb-6 opacity-30 text-[9px] md:text-[10px] font-black uppercase tracking-[0.2em]">Source Buffer</div>
                          <CodeEditor value={turn.sourceCode} readOnly language={turn.sourceLanguage} />
                        </div>

                        {/* Target Grid */}
                        <div className="p-5 sm:p-8 md:p-10 bg-indigo-500/[0.01]">
                          <div className="mb-4 md:mb-6 text-indigo-400 text-[9px] md:text-[10px] font-black uppercase tracking-[0.2em] flex items-center justify-between">
                            <span>Neural Output {allVersions.length > 1 ? `(V${activeIdx + 1})` : ''}</span>
                          </div>
                          <CodeEditor value={activeVersion.code} readOnly language={turn.targetLanguage} />
                        </div>
                      </div>

                      {/* Analysis Footer */}
                      <div className="p-4 sm:p-6 md:p-10 border-t border-white/[0.02] bg-black/20">
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-10">
                          <div className="lg:col-span-8">
                            <div className="mb-6 text-[10px] font-black uppercase tracking-[0.2em] text-neutral-500">Engine Report {allVersions.length > 1 ? `(V${activeIdx + 1})` : ''}</div>
                            <div className="prose prose-invert max-w-none text-neutral-400">
                              <ReactMarkdown>{activeVersion.explanation}</ReactMarkdown>
                            </div>
                          </div>
                          <div className="lg:col-span-4 space-y-6">
                            {activeVersion.notes && (
                              <div className="p-6 rounded-2xl bg-amber-500/[0.03] border border-amber-500/10">
                                <div className="flex items-center gap-2 mb-4">
                                  <svg className="text-amber-500/70" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></svg>
                                  <span className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Safety Audit</span>
                                </div>
                                <div className="prose prose-invert prose-sm max-w-none text-neutral-500">
                                  <ReactMarkdown>{activeVersion.notes}</ReactMarkdown>
                                </div>
                              </div>
                            )}
                            <div className="p-6 rounded-2xl glass bg-white/[0.01]">
                              <div className="flex items-center gap-2 mb-4">
                                <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
                                <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">Perf Metrics</span>
                              </div>
                              <div className="flex flex-col gap-3">
                                <div className="flex justify-between items-center">
                                  <span className="text-[11px] text-neutral-600 font-medium">Complexity</span>
                                  <span className="text-[11px] text-neutral-300 font-bold">O(n)</span>
                                </div>
                                <div className="flex justify-between items-center">
                                  <span className="text-[11px] text-neutral-600 font-medium">Type Safety</span>
                                  <span className="text-[11px] text-neutral-300 font-bold uppercase">Strict</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}


              {isTranslating && (
                <div className="w-full max-w-[1200px] mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="glass rounded-[40px] p-12 flex flex-col items-center justify-center gap-6">
                    <div className="w-12 h-12 rounded-2xl border-[3px] border-indigo-500/10 border-t-indigo-500 animate-spin"></div>
                    <div className="flex flex-col items-center gap-2">
                      <span className="text-[13px] font-bold text-white uppercase tracking-[0.3em] animate-pulse">Neural Transpilation</span>
                      <span className="text-[10px] text-neutral-500 font-medium tracking-tight">Mapping semantics from {sourceLanguage} to {targetLanguage}...</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Sticky Input Console */}
            <div className={`px-0 sm:px-6 md:px-8 pb-0 sm:pb-4 pt-2 z-50 shrink-0 transition-all duration-300 ${isInputFocused && window.innerWidth < 640 ? 'fixed inset-0 bg-[#050505]' : 'relative'}`}>
              <div className="max-w-[1000px] mx-auto relative h-full flex flex-col justify-end">
                {error && (
                  <div className="absolute bottom-full left-0 right-0 mb-3 animate-in fade-in slide-in-from-bottom-2 z-[100]">
                    <div className="mx-auto max-w-fit px-5 py-2 bg-red-500/10 border border-red-500/20 rounded-full text-red-400 text-[10px] font-bold uppercase tracking-widest">
                      {error}
                    </div>
                  </div>
                )}

                {(() => {
                  const isInputExpanded = !history.length || isInputFocused || isTranslating;
                  return (
                    <div className={`rounded-[20px] sm:rounded-[32px] overflow-visible flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.7)] border border-white/[0.08] bg-[#0d0d0d] transition-all duration-700 ease-[cubic-bezier(0.23,1,0.32,1)] ${!isInputExpanded ? 'max-w-[400px] mx-auto rounded-full ring-1 ring-white/10' : 'w-full'
                      }`}>

                      {/* ── Language row ── */}
                      <div className={`px-4 sm:px-6 py-3 flex flex-row items-center justify-between border-b border-white/[0.04] gap-3 relative overflow-visible transition-all duration-500 ease-in-out ${!isInputExpanded ? 'h-0 py-0 opacity-0 pointer-events-none border-none' : 'h-auto opacity-100'
                        }`}>
                        {/* Source language */}
                        <div className="flex-1 min-w-0 overflow-visible">
                          <LanguageSelector label="From" value={sourceLanguage} onChange={setSourceLanguage} />
                        </div>

                        {/* Swap button */}
                        <button
                          onClick={() => { setSourceLanguage(targetLanguage); setTargetLanguage(sourceLanguage); }}
                          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.06] bg-white/[0.03] text-neutral-500 hover:border-indigo-500/40 hover:text-indigo-400 hover:bg-indigo-500/10 transition-all touch-manipulation"
                          aria-label="Swap languages"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m17 7-5-5-5 5" /><path d="m17 17-5 5-5-5" /><path d="M12 2v20" /></svg>
                        </button>

                        {/* Target language */}
                        <div className="flex-1 min-w-0 overflow-visible">
                          <LanguageSelector label="To" value={targetLanguage} onChange={setTargetLanguage} exclude={sourceLanguage} />
                        </div>

                        {/* Option toggles */}
                        <div className="hidden sm:flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => setOptions(p => ({ ...p, explain: !p.explain }))}
                            className={`px-3 py-1.5 rounded-full border transition-all text-[9px] font-bold tracking-wide uppercase touch-manipulation ${options.explain ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400' : 'border-white/[0.05] text-neutral-600 hover:text-white'}`}
                          >
                            Report
                          </button>
                          <button
                            onClick={() => setOptions(p => ({ ...p, preservePerformance: !p.preservePerformance }))}
                            className={`px-3 py-1.5 rounded-full border transition-all text-[9px] font-bold tracking-wide uppercase touch-manipulation ${options.preservePerformance ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400' : 'border-white/[0.05] text-neutral-600 hover:text-white'}`}
                          >
                            Perf
                          </button>
                        </div>
                      </div>

                      {/* Option toggles on mobile only */}
                      <div className={`flex sm:hidden items-center gap-2 px-4 transition-all duration-500 ${!isInputExpanded ? 'h-0 py-0 opacity-0 pointer-events-none' : 'pt-3 opacity-100'
                        }`}>
                        <button
                          onClick={() => setOptions(p => ({ ...p, explain: !p.explain }))}
                          className={`px-3 py-1.5 rounded-full border transition-all text-[9px] font-bold tracking-wide uppercase touch-manipulation ${options.explain ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400' : 'border-white/[0.05] text-neutral-600'}`}
                        >
                          Report
                        </button>
                        <button
                          onClick={() => setOptions(p => ({ ...p, preservePerformance: !p.preservePerformance }))}
                          className={`px-3 py-1.5 rounded-full border transition-all text-[9px] font-bold tracking-wide uppercase touch-manipulation ${options.preservePerformance ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400' : 'border-white/[0.05] text-neutral-600'}`}
                        >
                          Perf
                        </button>
                      </div>

                      {/* Code input */}
                      <div className={`px-4 sm:px-6 transition-all duration-700 ease-[cubic-bezier(0.23,1,0.32,1)] flex items-center ${isInputExpanded
                        ? 'pt-3 pb-3 min-h-[120px] max-h-[220px] sm:max-h-[280px]'
                        : 'min-h-[38px] h-[38px] py-0'
                        }`}>
                        <CodeEditor
                          value={sourceCode}
                          onChange={setSourceCode}
                          onFocus={() => setIsInputFocused(true)}
                          onBlur={() => setIsInputFocused(false)}
                          isFocused={isInputFocused}
                          placeholder="Input source code for neural mapping..."
                          language={sourceLanguage}
                        />
                      </div>

                      {/* Bottom actions */}
                      <div className={`px-4 sm:px-6 md:px-8 transition-all duration-500 ease-in-out flex items-center justify-between gap-3 overflow-hidden ${!isInputExpanded ? 'h-0 py-0 opacity-0 pointer-events-none' : 'pb-5 h-auto opacity-100 border-t border-white/[0.03] pt-4'
                        }`}>
                        <button
                          onClick={() => setSourceCode('')}
                          disabled={!sourceCode.trim()}
                          className={`h-11 px-4 sm:px-5 rounded-2xl flex items-center justify-center gap-2.5 transition-all active:scale-95 ${!sourceCode.trim()
                            ? 'bg-neutral-900/40 text-neutral-800 cursor-not-allowed'
                            : 'bg-white/[0.03] border border-white/[0.08] text-neutral-400 hover:text-white hover:bg-white/[0.06]'
                            }`}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
                          <span className="text-[10px] font-black uppercase tracking-[0.2em]">Clear</span>
                        </button>
                        <button
                          onClick={handleTranslate}
                          disabled={isTranslating || !sourceCode.trim()}
                          className={`h-11 flex-1 sm:flex-none sm:px-12 rounded-2xl flex items-center justify-center gap-3 transition-all active:scale-95 ${isTranslating || !sourceCode.trim()
                            ? 'bg-neutral-800/40 text-neutral-700 cursor-not-allowed border border-white/[0.02]'
                            : 'bg-white text-black hover:bg-neutral-100 shadow-[0_10px_30px_rgba(255,255,255,0.1)]'
                            }`}
                        >
                          <span className="text-[11px] font-black uppercase tracking-[0.2em]">{isTranslating ? 'Transpiling…' : 'Run Mapping'}</span>
                          {!isTranslating && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>}
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="mt-3 text-center">
                <span className="text-[8px] sm:text-[9px] text-neutral-800 font-bold uppercase tracking-[0.3em]">Engine Cluster: Aura Elite-2 • v2.5.9</span>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default App;
