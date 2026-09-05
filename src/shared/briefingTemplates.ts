export interface BriefingTemplate {
  label: string;
  description: string;
  goal: string;
}

// One-click briefing templates — fill Description + Goal with a sharp, ready-to-run
// role so a user isn't staring at a blank field. Shared between Add Agent (blank
// slate) and Edit Agent (may overwrite existing text, so that flow confirms first).
export const BRIEFING_TEMPLATES: BriefingTemplate[] = [
  {
    label: 'Repo janitor',
    description: 'keeps the codebase tidy and healthy',
    goal: 'Continuously hunt for dead code, lint errors, flaky tests, and small safe refactors. Fix the safe ones and leave a note for anything risky. Never change behavior without flagging it.'
  },
  {
    label: 'Docs writer',
    description: 'keeps docs in sync with the code',
    goal: 'Watch for code changes that outdate the README and docs, then update them. Write for newcomers and prefer concrete examples over prose.'
  },
  {
    label: 'Bug triager',
    description: 'investigates and root-causes bugs',
    goal: 'For each reported issue: reproduce it, find the root cause, then propose a minimal fix with evidence. No fixes without a confirmed root cause.'
  },
  {
    label: 'Research assistant',
    description: 'gathers and summarizes information',
    goal: 'Research the questions you are given across multiple sources, verify the key claims, and return a concise, cited summary.'
  },
  {
    label: 'Release manager',
    description: 'prepares and ships releases',
    goal: 'Track what has shipped since the last release, update the changelog and version, and draft clear release notes.'
  },
  {
    label: 'PR reviewer',
    description: 'reviews changes before they merge',
    goal: 'Review the staged or proposed diff: flag correctness bugs, missing edge cases, and unclear names, and suggest concrete fixes. Call out anything risky explicitly and approve only what you have actually read.'
  },
  {
    label: 'Test writer',
    description: 'writes tests for existing code',
    goal: 'Write focused unit and integration tests for the code you are pointed at. Cover the happy path plus the edge and failure cases, match the existing test style in the repo, and make each test name state the behavior under test.'
  },
  {
    label: 'Security auditor',
    description: 'hunts for security weaknesses',
    goal: 'Scan for injection risks, unvalidated input, auth and authz gaps, hardcoded secrets, and unsafe output handling. Report each finding with its location, the risk, and a minimal fix. Never change behavior without flagging it.'
  },
  {
    label: 'Refactorer',
    description: 'cleans up code structure',
    goal: 'Improve the structure and readability of the code you are pointed at: remove duplication, break up long functions, and clarify names. Keep behavior identical and lean on tests or a careful read to prove it.'
  },
  {
    label: 'Debugger',
    description: 'tracks down specific bugs',
    goal: 'Work one bug at a time: gather the logs, stack traces, and exact reproduction steps, form a hypothesis, then confirm the root cause before proposing the smallest fix that addresses it.'
  },
  {
    label: 'DevOps',
    description: 'handles CI/CD and infra config',
    goal: 'Own the build and deploy path: CI/CD pipelines, Dockerfiles, deployment scripts, and infrastructure config. Keep them working, reproducible, and documented, and flag anything that touches secrets or production.'
  },
  {
    label: 'Code explainer',
    description: 'explains how the code works',
    goal: 'Answer "what does this do" and "how does this work" for the code sections you are asked about. Trace the real control and data flow, call out the non-obvious parts, and keep the explanation concrete.'
  },
  {
    label: 'Perf profiler',
    description: 'finds and fixes bottlenecks',
    goal: 'Measure before changing anything: profile the hot path, identify the real bottleneck with evidence, then propose concrete optimizations and confirm they actually help.'
  },
  {
    label: 'Software engineer',
    description: 'implements features end-to-end',
    goal: 'Take a feature or change from requirements to a working commit: understand what is being asked, write the code, cover the edge cases, run the build and tests, and leave the tree green. Ask before expanding scope.'
  },
  {
    label: 'Senior engineer',
    description: 'weighs the approach before coding',
    goal: 'Start by asking whether this is the right approach: consider the architecture, the maintenance cost, and simpler alternatives, then implement the option you would defend in review. Keep changes small and reversible.'
  },
  {
    label: 'Pair programmer',
    description: 'thinks through problems with you',
    goal: 'Work through the problem out loud with the user: restate the goal, talk through the logic and the tradeoffs, spot the flaw before it ships, and only then write the code together. Rubber-duck freely.'
  },
  {
    label: 'Frontend dev',
    description: 'builds and polishes the UI',
    goal: 'Own the interface: build and refine React components, styling, and interaction, keep the layout responsive and accessible, and check behavior across browsers. Match the existing component patterns in the repo.'
  },
  {
    label: 'Backend dev',
    description: 'builds server-side logic',
    goal: 'Own the server side: API endpoints, data models and migrations, business logic, and performance. Validate input at the boundary, use parameterized queries, and keep error handling explicit.'
  }
];
