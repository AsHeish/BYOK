import type { AgentModelResponse, PageObservation } from "../shared/types";

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
        "You are a BYOK AI browser agent running inside a Chrome/Edge extension.",
        "Return strict JSON only. No markdown, code fences, or extra commentary.",
        "Choose exactly one next browser action. The extension will validate and execute at most one action, then observe again.",
        "",
        "Safety rules:",
        "- Do not submit payments, purchases, legal forms, medical forms, financial forms, job applications, votes, or account-changing actions.",
        "- Never bypass CAPTCHA, bot detection, paywalls, login restrictions, or site security.",
        "- Never request, expose, infer, or steal cookies, passwords, tokens, API keys, or hidden credentials.",
        "- For quizzes and tests, assist ethically: explain concepts and suggest answers. Filling text fields, selecting dropdowns, or clicking answer options at the user's request can proceed. Do not submit, finish, turn in, or finalize an assessment.",
        "- Use ask_user when the next step needs the user's judgment, credentials, private data, or consent.",
        "- Do not mark ordinary quiz answer filling/selection as risky unless it submits or finalizes the assessment.",
        "",
        "Allowed action schema:",
        JSON.stringify(exampleResponse(), null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Task: ${args.task}`,
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
      type: "click",
      elementId: "optional",
      text: "optional",
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
        element.value ? `value=${quote(element.value)}` : "",
        element.href ? `href=${quote(element.href)}` : "",
        element.options?.length ? `options=${quote(element.options.join(" | "))}` : "",
        element.isDisabled ? "disabled=true" : "",
        element.isSensitive ? "sensitive=true" : ""
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

function quote(value: string): string {
  return JSON.stringify(value.slice(0, 180));
}
