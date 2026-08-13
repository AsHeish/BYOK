import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Bot, Pencil, Plus, RotateCcw, Send, Sparkles, Square, Trash2, User, X } from "lucide-react";
import { DEFAULT_CHAT_SUGGESTIONS, MAX_CHAT_SUGGESTIONS } from "../../shared/defaults";
import {
  loadChatSuggestions,
  loadTaskDraft,
  resetChatSuggestions,
  saveChatSuggestions,
  saveTaskDraft,
} from "../../shared/storage";
import type { AgentChatMessage } from "../../shared/types";
import { FileStagingPanel } from "./FileStagingPanel";
import { Markdown } from "./Markdown";

interface ChatPanelProps {
  messages: AgentChatMessage[];
  running: boolean;
  disabled: boolean;
  onSend: (message: string) => Promise<void>;
  onStop: () => Promise<void>;
  onClear: () => Promise<void>;
}

export function ChatPanel({ messages, running, disabled, onSend, onStop, onClear }: ChatPanelProps) {
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
  }, [messages.length, running]);

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
    if (!message || running || disabled || busy) {
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
        {messages.length === 0 ? <WelcomeMessage /> : null}
        {messages.map((message) => <ChatMessage key={message.id} message={message} />)}
        {running ? (
          <div className="chat-row assistant-row working-row">
            <span className="chat-avatar" aria-hidden="true"><Bot /></span>
            <div className="chat-bubble assistant-bubble">
              <span className="typing-dots" aria-label="Agent is working"><i /><i /><i /></span>
              <span>Working on your request</span>
            </div>
          </div>
        ) : null}
      </div>

      {messages.length === 0 ? (
        <ChatSuggestions running={running} onSelect={useStarter} />
      ) : null}

      <div className="chat-composer">
        <label className="sr-only" htmlFor="chat-message">Message</label>
        <textarea
          ref={inputRef}
          id="chat-message"
          value={draft}
          rows={3}
          placeholder="Ask about this page or give the agent a task..."
          disabled={running}
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-composer-toolbar">
          <FileStagingPanel disabled={running} />
          {running ? (
            <button type="button" className="composer-action stop-action" aria-label="Stop task" title="Stop task" onClick={() => void onStop()}>
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="composer-action send-action" disabled={disabled || busy || !draft.trim()} aria-label="Send message" title="Send message" onClick={() => void sendMessage()}>
              <Send aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {disabled ? <p className="inline-warning">Add an API key in Settings.</p> : null}
    </section>
  );
}

function ChatSuggestions({ running, onSelect }: { running: boolean; onSelect: (suggestion: string) => void }) {
  const [suggestions, setSuggestions] = useState<string[]>([...DEFAULT_CHAT_SUGGESTIONS]);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [newSuggestion, setNewSuggestion] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetOnSave, setResetOnSave] = useState(false);
  const [error, setError] = useState<string>();

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

  function beginEditing() {
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
    <div className={`chat-suggestions ${editing ? "is-editing" : ""}`}>
      <div className="chat-suggestions-header">
        <span><Sparkles aria-hidden="true" />Suggestions</span>
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
      </div>

      {editing ? (
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
      ) : (
        <div className="chat-starters" aria-label="Chat starters">
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
      )}
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

function ChatMessage({ message }: { message: AgentChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`chat-row ${isUser ? "user-row" : "assistant-row"}`}>
      {!isUser ? <span className="chat-avatar" aria-hidden="true"><Bot /></span> : null}
      <div className={`chat-message-stack ${message.kind === "question" ? "question-message" : ""}`}>
        {message.kind === "question" ? <span className="message-label">Needs your input</span> : null}
        <div className={`chat-bubble ${isUser ? "user-bubble" : "assistant-bubble"}`}>
          {isUser ? <p>{message.content}</p> : <Markdown text={message.content} />}
        </div>
        <time>{formatMessageTime(message.timestamp)}</time>
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