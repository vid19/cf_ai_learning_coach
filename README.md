# cf_ai_learning_coach

A personal learning coach I built for the Cloudflare AI assignment. You tell
it what you want to learn, it generates a short lesson, and then you can ask
it to quiz you. It remembers the topics you've studied, the concepts you
keep getting wrong, and uses that to target future lessons and quizzes.

Live demo: **https://cf-ai-learning-coach.vidyarth980.workers.dev**
Repo: **https://github.com/vid19/cf-ai-learning-coach**

Built on Cloudflare — Llama 3.3 70B on Workers AI, one Durable Object per
student session (via the Agents SDK), SQLite for memory, and a vanilla
HTML/JS chat UI served from the same Worker.

## What it actually does

- **Teach me about X** — generates a lesson in two passes (outline → full
  prose). If you've missed concepts from this topic before, the prompt
  tells Llama to spend extra time on them.
- **Quiz me on X** — 3 multiple-choice questions with explanations.
  Targets your weak spots when it can. Typos like "quize me on X" work
  too; the intent router is deliberately forgiving.
- **Regular chat** — anything else goes to the LLM with your study
  history as context. Ask "what is OOP" and it'll answer, and also
  nudge you back to whatever you were studying.
- **Remembers across sessions** — the sidebar shows topics you've
  studied (with mastery %), concepts you've missed (with miss counts),
  your quiz streak, and last score. All of this persists.
- **Reminds you to review** — after a lesson, the Durable Object
  schedules itself to post a review-prompt message 24 hours later.
- **Session isolation** — change the session name in the top-right and
  you get an entirely separate memory. Each session maps to its own
  Durable Object with its own SQLite database.

## How the four required pieces map to the code

**LLM.** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via the Workers AI
binding. Called from `LearningCoach.callLLM()` in `src/index.ts`.

**Coordination / workflow.** `LearningCoach` is a Durable Object (the
Agents SDK's `Agent` class extends DO). `generateLesson()` runs a
two-step LLM workflow — outline first, then a full lesson that feeds
the outline and the student's weak spots into the second prompt.
`this.schedule()` wakes the DO 24h later for the review reminder.

**User input.** Chat UI in `public/`, served as static assets from the
same Worker. Talks to the agent over `POST /api/:session/:method`,
which the Worker routes directly to the DO stub.

**Memory / state.** Two layers inside the agent. `this.state` holds
the small, UI-facing stuff (streak, last quiz score, total quizzes
taken). `this.sql` holds the things that grow — topics, weak spots,
quiz history, message log. Both are persistent across restarts,
deploys, and DO hibernation.

## Layout

```
cf_ai_learning_coach/
├── src/
│   └── index.ts          # LearningCoach DO + Worker fetch handler
├── public/
│   ├── index.html        # Chat UI
│   ├── styles.css        # Styling
│   └── app.js            # Client logic, quiz flow, intent routing
├── wrangler.jsonc        # Cloudflare deploy config
├── package.json
├── tsconfig.json
├── README.md
```

## Running it

You need Node 18+ and a Cloudflare account. Workers AI has a free tier
(about 10k neurons a day) — a lesson + quiz round-trip is well under
one neuron so you can play with it indefinitely.

```bash
git clone https://github.com/vidyarth980/cf_ai_learning_coach
cd cf_ai_learning_coach
npm install
npx wrangler login
npm run dev
```

Or skip local and deploy straight to your own Cloudflare account:

```bash
npm run deploy
```

You'll get a URL like `https://cf-ai-learning-coach.<your-subdomain>.workers.dev`.

## Try it

Open the URL. From the quick-action buttons or the chat box:

1. `Teach me about big-O notation` — a lesson appears in a purple card.
2. `Quiz me on big-O notation` — 3 MCQs show up in the quiz panel.
3. Answer them and hit **Submit**. The sidebar fills in with your
   score, any missed concepts, and your mastery for big-O.
4. Now try `What is object-oriented programming?` — regular chat.
   Llama will answer, and because it has your study history as
   context, it'll naturally reference what you've been working on.
5. Change the session name in the top-right to something new. The
   whole dashboard goes empty. Switch back — it's all still there.

## What I had to figure out

This section is the honest version, because a couple of things in the
Cloudflare docs are easy to miss and they cost me real time during
the build.

**`experimentalDecorators` must be OFF.** The Agents SDK uses TC39
standard decorators for `@callable()`, not the TypeScript legacy
variant. If you set `experimentalDecorators: true` in `tsconfig.json`
(which is a common default), `@callable()` silently stops working at
runtime — no error, the RPC calls just never fire. The docs warn
about this but it's easy to trigger. This repo's `tsconfig.json` has
`target: "ES2021"` and no `experimentalDecorators` flag, which is
what you want.

**The `agents` SDK has peer deps.** `npm install agents` alone isn't
enough — it lazy-imports `ai` and `zod` for JSON-schema validation on
tool calls, and the Wrangler bundler fails at build time if they're
not in `node_modules`. I hit `Could not resolve "ai"` on the first
deploy. Fix: `npm install ai zod` explicitly. Both are listed as deps
in `package.json` here.

**First deploy needs a `workers.dev` subdomain.** Your Cloudflare
account doesn't have one by default. If your first `npm run deploy`
fails with `code: 10063 — You need a workers.dev subdomain`, go to
`dash.cloudflare.com` → Workers & Pages in the sidebar. Opening that
page auto-creates the subdomain. Then `npm run deploy` again.

**Workers AI response shapes vary.** Llama 3.3 doesn't always return
`{ response: "some string" }` — when its output looks structured
(valid JSON, for example), it sometimes returns `{ response: {...},
tool_calls: [], usage: {...} }` with `response` already parsed into
an object. My first `callLLM()` helper only checked the string case
and accidentally stringified the entire envelope, which broke quiz
parsing until I caught it with `npx wrangler tail`. The current
helper handles both shapes.

**I don't use `AgentClient` from the CDN.** I originally tried to
load it via `esm.sh` so the frontend would have no build step, but
that specific build has a constructor bug that throws on our
arguments. Simpler approach: plain `fetch('/api/...')` calls that
hit the Worker, which forwards them to the DO via standard Durable
Object RPC. No WebSocket, no CDN dependency. The tradeoff is that
we refresh the sidebar after each action instead of getting pushed
updates, but in practice that's when state actually changes, so you
don't notice.

## Troubleshooting

**Nothing happens when I click Send.** Open DevTools → Console and
look for a red error. If it says anything about `AgentClient` or
`undefined.replace`, your browser is serving a cached old `app.js`;
right-click the reload button → "Empty Cache and Hard Reload".

**"The model returned invalid JSON" in the quiz.** Llama occasionally
returns malformed JSON for the quiz prompt. The parser has a fallback
so the UI never crashes. Just hit Reset and retry — it usually goes
through on the next attempt. If it keeps happening, check
`npx wrangler tail` to see the raw Llama response.

**Reminder message never appears.** It's scheduled 24h after a
lesson. For demos, drop the delay in `src/index.ts` — search for
`this.schedule(60 * 60 * 24, ...)` and change the number to `60`
(one minute) or `10` (ten seconds).

**The reset button doesn't seem to do anything.** It does — it
wipes the session's SQL tables and state — but you need to look at
the sidebar to see it worked. The chat messages re-render from an
empty history after the page reloads.

## Notes on design

The thing that makes this feel like a coach rather than a chatbot is
the **weak-spot tracking loop**. Every missed quiz question
increments a counter against the specific concept it tested. When
you later ask for a lesson on the same topic, the system prompt
includes those concepts verbatim and tells Llama to spend extra
attention on them. Same thing when generating a new quiz. The
student ends up with a system that actively steers them toward the
stuff they don't know.

I deliberately split state into `this.state` vs `this.sql`:

- `this.state` is small (streak, last score, current topic) and
  syncs to the client. Perfect for the sidebar badges.
- `this.sql` is for things that grow — topic list, message history,
  weak spots — where broadcasting every change would be wasteful.

One DO instance per session name (via `idFromName`) means multiple
students (or multiple browser tabs using different session names)
each get a completely isolated SQLite database. Demo-friendly: open
two tabs with different sessions and you can see the memory is
genuinely separate.

## License

MIT.
