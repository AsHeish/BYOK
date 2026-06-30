import { useEffect, useState } from "react";
import { loadTaskDraft, saveTaskDraft } from "../../shared/storage";
import { FileStagingPanel } from "./FileStagingPanel";

interface TaskRunnerProps {
  running: boolean;
  disabled: boolean;
  onRun: (task: string) => Promise<void>;
  onStop: () => Promise<void>;
}

export function TaskRunner({ running, disabled, onRun, onStop }: TaskRunnerProps) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <section className="panel task-panel" aria-label="Task runner">
      <label htmlFor="task">Task</label>
      <textarea
        id="task"
        value={task}
        placeholder="Summarize this page, compare prices, extract table data..."
        onChange={(event) => updateTask(event.target.value)}
        rows={5}
      />
      <div className="button-row">
        <button className="primary-button" disabled={disabled || running || busy || !task.trim()} onClick={submitTask}>
          {running ? "Running" : "Run"}
        </button>
        <FileStagingPanel />
        <button className="danger-button" disabled={!running} onClick={onStop}>
          Stop
        </button>
      </div>
      {disabled ? <p className="inline-warning">Add an API key in Settings.</p> : null}
    </section>
  );
}
