# PROMPTS.md

This project was built with AI assistance (Anthropic's Claude). The
value wasn't in the raw code the model produced — it was in _how_ I
prompted it. Below are the prompting principles I applied while
building this, and what each one concretely produced for the project.

---

## 1. I made the AI verify against current docs before writing code

AI models have a training cutoff. Cloudflare's Agents SDK, Workers AI
model catalogue, and Wrangler CLI have all changed recently. Asking
the model to write code from memory would have shipped bugs.

Every time I handed off a new task, I prefixed it with something
like:

> Before writing any code, fetch the current Cloudflare Agents SDK
> docs and verify the Agent class signature, @callable decorator
> usage, and how `routeAgentRequest` routes URLs. Only then write the
> implementation.

**What this caught on this project:**

- The correct Llama 3.3 model ID on Workers AI
  (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`).
- That setting `experimentalDecorators: true` in `tsconfig.json`
  silently breaks `@callable()`.
- The canonical use of `routeAgentRequest()` vs hand-rolling a URL
  router.

Three potential deploy-time bugs, all caught before first deploy.

---

## 2. I handed off decisions, not open-ended tasks

"Build me an AI-powered app" produces generic tutorial code. Framing
the ask as a decision between concrete alternatives produces something
tailored.

Example from the opening of the session:

> Requirements: LLM, workflow/coordination, chat UI, persistent
> memory. Recommend three non-trivial ideas where each requirement
> is doing real work (not decorative memory). Rank them by how
> impressive they'd be to a reviewer.

**What this produced:** four distinct ideas ranked by how obviously
each one exercises the "memory" requirement. I picked the Personal
Learning Coach because the memory isn't cosmetic — it drives the
behaviour (lessons target your weak spots, reminders fire
autonomously).

---

## 3. I debugged with logs, not symptoms

The single biggest time-saver. When a fix wasn't working, I stopped
describing the problem in English and started pasting raw logs.

The best example was the "quiz always returns invalid JSON" bug.
Describing it in words led to wrong guesses. Opening `wrangler tail`
and pasting what Llama actually returned:

```
Quiz JSON parse failed. Raw response:
{"response":{"questions":[...]},"tool_calls":[],"usage":{...}}
```

...made the bug obvious immediately: Llama was returning a structured
response object, but my `callLLM` helper only checked the string
case and was accidentally stringifying the whole envelope. Fixed in
two minutes.

Principle: AI assistants are much better at reading evidence than
guessing from symptoms. Live-log tools (`wrangler tail` for
Cloudflare) are non-negotiable during development.

---

## 4. I asked the AI to explain its own code back to me

After a chunk of code was written, I'd ask the model to explain it
back _without showing the code again_. If the explanation drifted
from what I intended, I'd caught a subtle bug before deploy.

Example I used:

> Without re-pasting the code, explain step by step what
> `generateLesson` does. Include why there are two LLM calls instead
> of one, and what state changes happen between them.

**What this caught:** the first version of the lesson workflow didn't
record the topic before the second LLM call, meaning weak-spot
context for repeat topics would be missed. Fixed before it shipped.

---

## 5. I pushed back on the first answer

Claude is trained to be agreeable. Accepting the first design
produces mediocre designs. I reliably got better code by asking
"is there a simpler way?" or "what would you do differently if you
were starting over?"

On this project:

- First Worker entry had a hand-rolled
  `/api/agent/:sessionId/:method` router.
- I asked "is there a canonical SDK way to do this?"
- The model switched to `routeAgentRequest()`, which is idiomatic.
  (Later, when we hit an unrelated SDK bug, we ended up with a
  hybrid — but the starting point was better.)

---

## 6. I requested footguns up front, not after they hit

Most training-data code is "happy path." The gotchas live in release
notes and issue trackers. I front-loaded them:

> Before writing the tsconfig and wrangler config, list the top 5
> gotchas for projects using the Agents SDK with Workers AI. For
> each, tell me what the error looks like if I get it wrong.

**What this surfaced:**

- `experimentalDecorators` silently breaks `@callable()`.
- `ai` and `zod` need to be explicit npm deps or the bundler fails.
- First deploy requires a registered `workers.dev` subdomain.
- The `nodejs_compat` flag is required for the Agents SDK.
- Model IDs have changed; verify against the catalog.

Four of those five actually mattered during this build.

---

## 7. I broke debug loops by inverting the question

When a fix didn't work and the AI proposed another fix along the same
reasoning, I stopped the loop. The prompt I used:

> My last three fixes haven't worked. Don't propose a fourth. List
> three things I'm assuming to be true that might actually be false.
> For each, tell me how to verify it.

**What this produced:** on the quiz bug, this is what led to
suggesting `wrangler tail`, which is what finally exposed the real
problem. Without the reframe, we'd have kept patching the parser.

---

## 8. I named exact versions when libraries came up

Fast-moving libraries need version-specific code. Asking generically
gets you training-data defaults.

> I'm on `agents@0.2`, `wrangler@4.84`, and `@cloudflare/workers-types@4.x`.
> Use TC39 standard decorators, not the TypeScript legacy kind. Use
> `routeAgentRequest` from `agents`, not from any older path.

This is the specific thing that stopped the model from writing code
that would have looked plausible but failed at build time with
`Could not resolve` errors.

---

## 9. I reviewed my prompts before sending them

Two questions every time:

1. **Is there one thing I'm asking for, or three?** Three = mediocre
   output on all three. Split the prompt.
2. **Have I told the model what "done" looks like?** Concrete
   acceptance criteria (e.g., "the function returns an object with
   `outline: string[], lesson: string`, and calls `this.sql` at least
   once to record the topic") produces code that actually works.

---

## What I used AI for vs. what I didn't

**AI did:** the Durable Object scaffolding, SQL table definitions,
the TypeScript type wrangling, the CSS, the React-free frontend glue,
the regex for intent routing, and most of the debugging suggestions.

**I did:** picked the problem (a coach, not a chatbot); designed the
weak-spot tracking loop (miss a question → counter increments →
future lesson prompts reference the concept); designed the
per-session DO isolation model; decided the state/SQL split; decided
to test locally via live deploy rather than `wrangler dev` (in
hindsight, the wrong call — would have caught peer-dep issues
earlier).

The design decisions were mine. The AI made them blandly when I let
it. I made them well by holding onto them.
