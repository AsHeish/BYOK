import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Bot, FileText, Files, ListChecks, Send, Square, Table2, type LucideIcon } from "lucide-react";
import { loadTaskDraft, saveTaskDraft } from "../../shared/storage";
import { FileStagingPanel } from "./FileStagingPanel";

interface TaskRunnerProps {
  running: boolean;
  disabled: boolean;
  onRun: (task: string) => Promise<void>;
  onStop: () => Promise<void>;
}

const TASK_STARTERS: Array<{ label: string; prompt: string; icon: LucideIcon }> = [
  {
    label: "Summarize page",
    prompt: "Summarize the important information on the current page.",
    icon: FileText
  },
  {
    label: "Extract data",
    prompt: "Extract the main structured data from the current page and present it as a table.",
    icon: Table2
  },
  {
    label: "Fill a form",
    prompt: "Fill the visible form using these details: ",
    icon: ListChecks
  },
  {
    label: "Compare tabs",
    prompt: "Compare the relevant information across the open tabs.",
    icon: Files
  }
];

export function TaskRunner({ running, disabled, onRun, onStop }: TaskRunnerProps) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const taskRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadTaskDraft()
      .then((draft) => {
        if (mounted) {
          setTask(draft);
        }
      })
      .catch(() => {
        if (mounted) {
          setTask("");
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  function updateTask(value: string) {
    setTask(value);
    void saveTaskDraft(value);
  }

  function useTaskStarter(prompt: string) {
    updateTask(prompt);
    requestAnimationFrame(() => {
      taskRef.current?.focus();
      taskRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  async function submitTask() {
    if (!task.trim() || running || disabled) {
      return;
    }

    setBusy(true);
    try {
      await onRun(task.trim());
    } finally {
      setBusy(false);
    }
  }

  function handleTaskKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    void submitTask();
  }

  return (
    <section className="task-workspace" aria-label="Task runner">
      <div className="agent-intro">
        <span className={`agent-avatar ${running ? "is-running" : ""}`} aria-hidden="true">
          <Bot />
        </span>
        <div>
          <span className="agent-kicker">Browser agent</span>
          <h2>{running ? "Task in progress" : "What would you like me to do?"}</h2>
          <p>{running ? "Working in agent-owned tabs." : "Ready for a browser task."}</p>
        </div>
      </div>

      <div className="composer">
        <label className="sr-only" htmlFor="task">Browser task</label>
        <textarea
          ref={taskRef}
          id="task"
          value={task}
          placeholder="Describe the result you want in the browser..."
          onChange={(event) => updateTask(event.target.value)}
          onKeyDown={handleTaskKeyDown}
          rows={6}
          disabled={running}
        />
        <div className="composer-toolbar">
          <FileStagingPanel disabled={running} />
          {running ? (
            <button
              type="button"
              className="composer-action stop-action"
              aria-label="Stop task"
              title="Stop task"
              onClick={() => void onStop()}
            >
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-action send-action"
              disabled={disabled || busy || !task.trim()}
              aria-label="Run task"
              title="Run task"
              onClick={() => void submitTask()}
            >
              <Send aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="task-starters" aria-label="Task starters">
        {TASK_STARTERS.map(({ label, prompt, icon: Icon }) => (
          <button key={label} type="button" disabled={running} onClick={() => useTaskStarter(prompt)}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {disabled ? <p className="inline-warning">Add an API key in Settings.</p> : null}
    </section>
  );
}
