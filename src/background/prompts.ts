import type { AgentModelResponse, PageObservation } from "../shared/types";

export const AGENT_PROMPT_CACHE_VERSION = "byok-agent-prompt-v0.1.20";

export function buildAgentMessages(args: {
  task: string;
  observation: PageObservation;
  step: number;
  maxSteps: number;
  previousResult?: string;
}): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        `Prompt cache version: ${AGENT_PROMPT_CACHE_VERSION}`,
        "You are a BYOK AI browser agent running inside a Chrome/Edge extension.",
        "Return strict JSON only. No markdown, code fences, or extra commentary.",
        "Choose exactly one next browser action. The extension will validate and execute at most one action, then observe again.",
        "",
        "For text fields, prefer fill over separate click and type actions. fill automatically clicks, focuses, and replaces the field value in one browser action.",
        "- For custom form controls, an outer div may represent a textbox. If it has role=textbox, a useful label, placeholder, value, or input-like class, use fill on that element; the extension will click/focus its nested input safely.",
        "- For drag-and-drop questions, use drag with elementId as the draggable source and targetElementId as the drop zone or destination. Use one drag per step, then observe again.",
        "- If drag/drop source or target is unclear, use ask_user instead of guessing.",
        "- When multiple fields have the same label, use each element's problem and context fields to decide which question it belongs to. Do not rely only on repeated labels like \"Your Submission\".",
        "- Do not copy the same option number into multiple questions unless each field's own context independently supports that answer.",
        "- Do not fill any field that already has a non-empty value in the observation, even if the value differs from the answer you planned. Move to the next empty field or finish.",
        "- If the previous action result says a field was skipped because it already has a value or was skipped and advanced, never retry that same element. Use the element marked focused=true, choose the next empty field, or return done.",
        "- If the user asks to keep pressing Tab or move to the next input, use press_key with key=\"Tab\". The next observation will mark the newly focused element with focused=true.",
        "",
        "Allowed action schema:",
        "Action type must be one of: click, drag, fill, type, select, press_key, scroll, navigate, extract, ask_user, done.",
        "For drag, set elementId to the draggable source and targetElementId to the destination/drop zone.",
        "For fill and type, set elementId and text. Use fill for normal form input because it combines click/focus and typing.",
        "For press_key, set key to Tab or Shift+Tab.",
        JSON.stringify(exampleResponse(), null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: ["Stable task context for this agent run:", args.task].join("\n")
    },
    {
      role: "user",
      content: [
        `Step: ${args.step} of ${args.maxSteps}`,
        args.previousResult ? `Previous action result: ${args.previousResult}` : "",
        "",
        "Current page observation:",
        formatObservation(args.observation),
        "",
        "Return the next action JSON now."
      ]
        .filter(Boolean)
        .join("\n")
    }
  ];
}

function exampleResponse(): AgentModelResponse {
  return {
    thought_summary: "short user-visible reasoning",
    risk_level: "low",
    action: {
      type: "fill",
      elementId: "optional",
      targetElementId: "optional",
      text: "optional",
      key: "Tab",
      url: "optional",
      direction: "down"
    }
  };
}

function formatObservation(observation: PageObservation): string {
  const elements = observation.elements
    .map((element) => {
      const parts = [
        `id=${element.id}`,
        `tag=${element.tag}`,
        element.role ? `role=${element.role}` : "",
        element.type ? `type=${element.type}` : "",
        element.label ? `label=${quote(element.label)}` : "",
        element.text ? `text=${quote(element.text)}` : "",
        element.placeholder ? `placeholder=${quote(element.placeholder)}` : "",
        element.questionNumber ? `problem=${element.questionNumber}` : "",
        element.context ? `context=${quote(element.context, 700)}` : "",
        element.value ? `value=${quote(element.value)}` : "",
        element.href ? `href=${quote(element.href)}` : "",
        element.options?.length ? `options=${quote(element.options.join(" | "))}` : "",
        element.isDraggable ? "draggable=true" : "",
        element.isDropTarget ? "dropTarget=true" : "",
        element.isFocused ? "focused=true" : "",
        element.isDisabled ? "disabled=true" : ""
      ].filter(Boolean);

      return `- ${parts.join(" ")}`;
    })
    .join("\n");

  return [
    `URL: ${observation.url}`,
    `Title: ${observation.title}`,
    "",
    "Readable text:",
    observation.text,
    "",
    "Interactive elements:",
    elements || "(none found)"
  ].join("\n");
}

function quote(value: string, maxLength = 180): string {
  return JSON.stringify(value.slice(0, maxLength));
}
