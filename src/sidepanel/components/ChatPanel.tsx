import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Bot, ChevronDown, ChevronUp, Pencil, Plus, RotateCcw, Send, Sparkles, Square, Trash2, User, X } from "lucide-react";
import { DEFAULT_CHAT_SUGGESTIONS, MAX_CHAT_SUGGESTIONS } from "../../shared/defaults";
import {
  loadChatSuggestions,
  loadTaskDraft,
  resetChatSuggestions,
  saveChatSuggestions,
  saveTaskDraft,
} from "../../shared/storage";
import type { AgentChatMessage, AgentLogEntry } from "../../shared/types";
import { FileStagingPanel } from "./FileStagingPanel";
import { Markdown } from "./Markdown";

interface ChatPanelProps {
  messages: AgentChatMessage[];
  currentLog?: AgentLogEntry;
  running: boolean;
  waitingForModel: boolean;
  disabled: boolean;
  model: string;
  onSend: (message: string) => Promise<void>;
  onRerun: (message: string) => Promise<void>;
  onStop: () => Promise<void>;
  onClear: () => Promise<void>;
}

export function ChatPanel({ messages, currentLog, running, waitingForModel, disabled, model, onSend, onRerun, onStop, onClear }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const draftChangedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    void loadTaskDraft()
      .then((value) => {
        if (mounted && !draftChangedRef.current) {
          setDraft(value);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, currentLog?.id, running, waitingForModel]);

  function updateDraft(value: string) {
    draftChangedRef.current = true;
    setDraft(value);
    void saveTaskDraft(value);
  }

  function useStarter(value: string) {
    updateDraft(value);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function sendMessage() {
    const message = draft.trim();
    if (!message || disabled || busy) {
      return;
    }

    setBusy(true);
    updateDraft("");
    try {
      await onSend(message);
    } catch {
      updateDraft(message);
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void sendMessage();
  }

  return (
    <section className="chat-workspace" aria-label="Agent chat">
      <header className="chat-header">
        <div>
          <span className="agent-kicker">Conversation</span>
          <h2>Chat with your browser agent</h2>
        </div>
        <button
          type="button"
          className="chat-clear-button"
          disabled={!messages.length || running}
          aria-label="Clear chat"
          title="Clear chat"
          onClick={() => void onClear()}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </header>

      <div className="chat-thread" ref={threadRef} aria-live="polite">
        <WelcomeMessage />
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            rerunDisabled={disabled || running || busy}
            onRerun={onRerun}
          />
        ))}
        {running && currentLog ? (
          <div className={`chat-action-log ${currentLog.level}`} role="status" aria-label="Current action">
            <span className="chat-action-dot" aria-hidden="true" />
            <span className="chat-action-message">{currentLog.message}</span>
            <time>{formatLogTime(currentLog.timestamp)}</time>
          </div>
        ) : null}
        {running && waitingForModel ? (
          <div className="model-waiting-status" role="status">
            <Sparkles aria-hidden="true" />
            <span>Polishing the next thought...</span>
          </div>
        ) : null}
      </div>

      <ChatSuggestions hasMessages={messages.length > 0} running={running} onSelect={useStarter} />

      <div className="chat-composer">
        <div className="chat-composer-main">
          <FileStagingPanel disabled={busy} />
          <label className="sr-only" htmlFor="chat-message">Message</label>
          <textarea
            ref={inputRef}
            id="chat-message"
            value={draft}
            rows={2}
            placeholder="Type your message..."
            disabled={busy}
            onChange={(event) => updateDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className={`composer-action ${running ? "stop-action" : "send-action"}`}
            disabled={!running && (disabled || busy || !draft.trim())}
            aria-label={running ? "Stop current task" : "Send message"}
            title={running ? "Stop current task" : "Send message"}
            onClick={() => running ? void onStop() : void sendMessage()}
          >
            {running ? <Square aria-hidden="true" /> : <Send aria-hidden="true" />}
          </button>
        </div>
        <p className="composer-model"><span>Model:</span> {model || "Not configured"}</p>
      </div>

      {disabled ? <p className="inline-warning">Add an API key in Settings.</p> : null}
    </section>
  );
}

function ChatSuggestions({
  hasMessages,
  running,
  onSelect,
}: {
  hasMessages: boolean;
  running: boolean;
  onSelect: (suggestion: string) => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([...DEFAULT_CHAT_SUGGESTIONS]);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [newSuggestion, setNewSuggestion] = useState("");
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(!hasMessages);
  const [saving, setSaving] = useState(false);
  const [resetOnSave, setResetOnSave] = useState(false);
  const [error, setError] = useState<string>();
  const hadMessagesRef = useRef(hasMessages);

  useEffect(() => {
    let mounted = true;
    void loadChatSuggestions()
      .then((stored) => {
        if (mounted) {
          setSuggestions(stored);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const hadMessages = hadMessagesRef.current;
    hadMessagesRef.current = hasMessages;
    if (!hadMessages && hasMessages) {
      setExpanded(false);
      setEditing(false);
      setDrafts([]);
      setNewSuggestion("");
      setError(undefined);
    } else if (hadMessages && !hasMessages) {
      setExpanded(true);
    }
  }, [hasMessages]);

  function beginEditing() {
    setExpanded(true);
    setDrafts(suggestions);
    setNewSuggestion("");
    setResetOnSave(false);
    setError(undefined);
    setEditing(true);
  }

  function cancelEditing() {
    setDrafts([]);
    setNewSuggestion("");
    setResetOnSave(false);
    setError(undefined);
    setEditing(false);
  }

  function updateSuggestion(index: number, value: string) {
    setResetOnSave(false);
    setDrafts((current) => current.map((suggestion, suggestionIndex) => (
      suggestionIndex === index ? value : suggestion
    )));
  }

  function removeSuggestion(index: number) {
    setResetOnSave(false);
    setDrafts((current) => current.filter((_, suggestionIndex) => suggestionIndex !== index));
  }

  function addSuggestion() {
    const value = newSuggestion.replace(/\s+/g, " ").trim();
    if (!value || drafts.length >= MAX_CHAT_SUGGESTIONS || hasSuggestion(drafts, value)) {
      return;
    }
    setResetOnSave(false);
    setDrafts((current) => [...current, value]);
    setNewSuggestion("");
  }

  async function saveSuggestions() {
    setSaving(true);
    setError(undefined);
    try {
      const saved = resetOnSave
        ? await resetChatSuggestions()
        : await saveChatSuggestions(drafts);
      setSuggestions(saved);
      setResetOnSave(false);
      setEditing(false);
    } catch {
      setError("Could not save suggestions.");
    } finally {
      setSaving(false);
    }
  }

  function restoreDefaults() {
    setError(undefined);
    setDrafts([...DEFAULT_CHAT_SUGGESTIONS]);
    setNewSuggestion("");
    setResetOnSave(true);
  }

  const canAdd = Boolean(newSuggestion.trim()) &&
    drafts.length < MAX_CHAT_SUGGESTIONS &&
    !hasSuggestion(drafts, newSuggestion);

  return (
    <div className={`chat-suggestions ${editing ? "is-editing" : ""} ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <div className="chat-suggestions-header">
        <span><Sparkles aria-hidden="true" />Suggestions</span>
        <div className="chat-suggestion-actions">
          {editing ? (
            <button type="button" className="suggestion-reset-button" disabled={saving} onClick={restoreDefaults}>
              <RotateCcw aria-hidden="true" />
              <span>Reset</span>
            </button>
          ) : (
            <button type="button" className="suggestion-manage-button" disabled={running} aria-label="Edit suggestions" title="Edit suggestions" onClick={beginEditing}>
              <Pencil aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="suggestion-toggle-button"
            aria-controls="chat-suggestion-content"
            aria-expanded={expanded}
            aria-label={expanded ? "Fold suggestions" : "Show suggestions"}
            title={expanded ? "Fold suggestions" : "Show suggestions"}
            disabled={editing || saving}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          </button>
        </div>
      </div>

      {expanded && editing ? (
        <div className="suggestion-editor" aria-label="Edit chat suggestions">
          <div className="suggestion-editor-list">
            {drafts.map((suggestion, index) => (
              <div className="suggestion-edit-row" key={index}>
                <input
                  aria-label={`Suggestion ${index + 1}`}
                  value={suggestion}
                  maxLength={240}
                  disabled={saving}
                  onChange={(event) => updateSuggestion(index, event.target.value)}
                />
                <button type="button" disabled={saving} aria-label={`Delete suggestion ${index + 1}`} title="Delete suggestion" onClick={() => removeSuggestion(index)}>
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>

          {drafts.length < MAX_CHAT_SUGGESTIONS ? (
            <div className="suggestion-add-row">
              <input
                aria-label="New suggestion"
                value={newSuggestion}
                maxLength={240}
                disabled={saving}
                placeholder="Add a suggestion"
                onChange={(event) => setNewSuggestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addSuggestion();
                  }
                }}
              />
              <button type="button" disabled={!canAdd || saving} aria-label="Add suggestion" title="Add suggestion" onClick={addSuggestion}>
                <Plus aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {error ? <p className="suggestion-error" role="alert">{error}</p> : null}

          <div className="suggestion-editor-actions">
            <button type="button" className="secondary-button" disabled={saving} onClick={cancelEditing}>Cancel</button>
            <button type="button" className="primary-button" disabled={saving} onClick={() => void saveSuggestions()}>Save</button>
          </div>
        </div>
      ) : expanded ? (
        <div className="chat-starters" id="chat-suggestion-content" aria-label="Chat starters">
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" disabled={running} onClick={() => onSelect(suggestion)}>
              <Sparkles aria-hidden="true" />
              <span>{suggestion}</span>
            </button>
          ))}
          {suggestions.length === 0 ? (
            <button type="button" className="empty-suggestion-button" disabled={running} onClick={beginEditing}>
              <Plus aria-hidden="true" />
              <span>Add a suggestion</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function hasSuggestion(suggestions: string[], candidate: string): boolean {
  const normalized = candidate.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return suggestions.some((suggestion) => suggestion.replace(/\s+/g, " ").trim().toLocaleLowerCase() === normalized);
}

function WelcomeMessage() {
  return (
    <div className="chat-row assistant-row welcome-row">
      <span className="chat-avatar" aria-hidden="true"><Bot /></span>
      <div className="chat-bubble assistant-bubble">
        <strong>Hello. What can I help with?</strong>
        <p>Ask about the current page, request a summary, or describe a browser task.</p>
      </div>
    </div>
  );
}

function ChatMessage({
  message,
  rerunDisabled,
  onRerun,
}: {
  message: AgentChatMessage;
  rerunDisabled: boolean;
  onRerun: (message: string) => Promise<void>;
}) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-row ${isUser ? "user-row" : "assistant-row"}`}>
      {!isUser ? <span className="chat-avatar" aria-hidden="true"><Bot /></span> : null}
      <div className={`chat-message-stack ${message.kind === "question" ? "question-message" : ""}`}>
        {message.kind === "question" ? <span className="message-label">Needs your input</span> : null}
        <div className={`chat-bubble ${isUser ? "user-bubble" : "assistant-bubble"}`}>
          {isUser ? <p>{message.content}</p> : <Markdown text={message.content} />}
        </div>
        <div className="chat-message-footer">
          <time>{formatMessageTime(message.timestamp)}</time>
          {isUser ? (
            <button
              type="button"
              className="chat-rerun-button"
              disabled={rerunDisabled}
              aria-label="Rerun message"
              title="Rerun message"
              onClick={() => void onRerun(message.content)}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {isUser ? <span className="chat-avatar user-avatar" aria-hidden="true"><User /></span> : null}
    </div>
  );
}

function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatLogTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}