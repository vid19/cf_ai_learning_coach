# PROMPTS.md — How I prompted Claude to build this

The assignment asks me to document the AI prompts I used while building
this. Rather than paste a raw transcript, I've turned it into the more
useful thing: the lessons I took away about prompting an LLM to build
a real, deployable project — illustrated with the actual prompts and
moments from building `cf_ai_learning_coach`.

Everything below is grounded in this specific repo. The prompts shown
are ones I actually used; the mistakes shown are ones Claude actually
made that I had to catch.

---

## 1. Don't paste the whole spec and say "build it"

The worst thing you can do with a take-home assignment brief is paste
it verbatim into a chat window and say "build this for me." You'll
get generic tutorial code that technically satisfies the spec and
reads like every other submission.

**What I did instead.** I pasted the assignment, but immediately made
the assistant narrow the problem:

> I want to do this end-to-end so I can submit. What would you build?

Claude offered four ideas. I picked one — Personal Learning Coach —
because the "memory" requirement would be _visibly doing something_,
not decorative. The coach remembers your weak spots; a generic
chatbot's "memory" would just be chat history.

**Takeaway:** force the model to pick a direction before it writes
code. Cheap ideas are better than expensive reworks.

---

## 2. Make the model verify its own knowledge before writing code

LLMs trained a year ago will confidently write code against APIs that
no longer exist. Cloudflare's Agents SDK moved fast recently. Training
data alone would have given me stale code.

**What I did.** Before the first line of code was written, I got
Claude to fetch the current docs:

> Before you write anything, read the current Cloudflare Agents docs
> and verify: the Agents SDK import surface, the Llama 3.3 model ID
> on Workers AI, and the wrangler.jsonc shape for a DO binding.

This one instruction saved me from at least three bugs that would
have shipped silently:

- Claude had initially planned a hand-rolled `/api/agent/:sessionId/:method`
  router. Reading the live docs revealed the SDK's own
  `routeAgentRequest()` helper.
- Claude's default `tsconfig.json` had `experimentalDecorators: true`.
  The docs _explicitly warn_ this silently breaks `@callable()` at
  runtime with no error. Caught before first deploy.
- Claude's first guess at the Llama 3.3 model ID was close but not
  exact. Verified against the live Workers AI catalog:
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

**Takeaway:** "read the docs first" is the single highest-ROI prompt
instruction when working with fast-moving frameworks.

---

## 3. Describe systems, not syntax

When I wanted the multi-step lesson workflow, I didn't ask for the
TypeScript. I described the _flow_:

> `generateLesson` should do this:
>
> 1. Outline the lesson (LLM call 1): get back 3-5 bullet concepts.
> 2. Expand into a full lesson (LLM call 2). This call must be aware
>    of the student's known weak spots for this topic — pull them from
>    SQL and mention them in the system prompt.
> 3. Persist the topic, update state, and schedule a review reminder
>    for 24h later.

You can see in `src/index.ts` that this is almost exactly what
`generateLesson` does. If I'd said "write me a function that generates
a lesson," I'd have gotten one LLM call, no weak-spot feedback, no
schedule.

**Takeaway:** describe the _control flow and data flow_; let the LLM
fill in the idioms. It's much better at the latter than the former.

---

## 4. Make constraints explicit and upfront

The prompts that produced bad code were the ones that left constraints
implicit. The ones that worked first try front-loaded them.

**Example that worked:**

> Write the chat UI as a single HTML file + CSS file + vanilla JS
> module. No React, no bundler, no build step. A reviewer should be
> able to clone and run with one command.

I got exactly that. Total dev-dependency count in `package.json` is
just TypeScript, wrangler, and workers-types. Nothing to compile.

**Example that didn't work first time:**

> Handle the Workers AI response.

Too loose. Claude wrote a helper that handled `{ response: "string" }`
but not `{ response: { object }, tool_calls: [], usage: {...} }`,
which is what Llama 3.3 actually returns when its output is
structured. I only caught this with `wrangler tail` after quizzes
kept coming back as "model returned invalid JSON" despite Llama
producing perfect output. Lesson: the next time I write that prompt
it'll be "handle the Workers AI response, accounting for both string
and object shapes in the `response` field."

**Takeaway:** constraints you don't state are constraints the model
will guess at — and its guesses are biased toward the most common
case, not your case.

---

## 5. When debugging, show evidence, not symptoms

"It doesn't work" is useless to an LLM. The prompts that fixed bugs
fastest were the ones with raw evidence attached.

**The moment that mattered most in this project:**

After deploy, every quiz came back with "The model returned invalid
JSON" even though the JSON-parsing logic had a salvaging helper. I
couldn't figure out why. Instead of asking Claude to reason about
possible causes, I ran:

```bash
npx wrangler tail
```

...triggered the bug, and pasted the entire log output — including
the raw Workers AI response envelope — back into the chat. Within
one turn, Claude identified the exact bug: my `callLLM` helper was
stringifying the whole envelope `{response: {...}, tool_calls: [],
usage: {...}}` instead of unwrapping `.response` when it was an
object. Two-line fix, would have taken an hour without the log.

**Takeaway:** `wrangler tail`, browser DevTools console, Network tab
responses — copy-paste the raw output, don't paraphrase.

---

## 6. Catch the model over-apologizing and under-questioning

Two failure modes I had to correct for repeatedly:

**Over-apologizing.** When I pointed out a bug, Claude's default was
to apologize profusely and immediately rewrite a large chunk of code,
often fixing things that weren't broken. Better pattern:

> Don't rewrite. What specifically caused that behavior? Fix only
> the line that caused it.

This kept patches surgical and made regressions less likely.

**Under-questioning.** When I gave ambiguous instructions, Claude
often guessed silently rather than asking. Better pattern at the
start of the session:

> If anything about what I'm asking is ambiguous, stop and ask
> before you write code. I'd rather answer one question now than
> rewrite later.

---

## 7. Keep the AI honest about what it doesn't know

At one point during debugging, Claude said, "I'm confident this is
the correct URL for the SDK's HTTP RPC endpoint." The URL gave 404.

After that, I added an explicit rule partway through the session:

> Before you claim any Cloudflare API detail is correct, verify it
> from the current docs or tell me you're guessing.

This shifted Claude from "I'm confident" to "I believe this is the
path but let me check" — and the checks caught several things. An LLM
will tell you what its training data contained as if it's current
fact. You have to ask.

---

## 8. Be the integration engineer

The model writes the code; you run it. That split of labor is the
whole point. In this project that meant:

- **I ran every deploy.** Claude couldn't see my Cloudflare account,
  my subdomain issues, my missing peer deps. I pasted the errors;
  Claude fixed them.
- **I hard-refreshed the browser.** Multiple fixes appeared not to
  work until I realized the browser was serving cached `app.js`.
  Claude couldn't have known that; I had to.
- **I made the judgment calls.** When Claude suggested using
  `AIChatAgent` with streaming, I said no — simpler was better for a
  submission. When it suggested adding WebSocket state push, I said
  no — HTTP polling was fine. These were my calls, and that's how
  the tradeoffs got made correctly.

**Takeaway:** AI-assisted doesn't mean AI-delegated. The valuable
thing is still the judgment about what to build and when something is
good enough.

---

## 9. Things that are genuinely mine, not AI-generated

For the record, because it matters:

- Picking this application idea (a coach, not a chatbot).
- The weak-spot tracking loop — miss a quiz question → counter
  against that concept → future lesson/quiz prompts target those
  concepts so Llama pays extra attention to them. This is what makes
  the app feel like a coach rather than a trivia bot. My design.
- Per-session isolation via `idFromName(sessionName)` — my call,
  because it makes demos obviously work (open two tabs, see two
  independent brains).
- The `this.state` vs `this.sql` split (small/synced vs big/queried).
- The order of operations during deploy (test end-to-end first,
  _then_ push to GitHub).
- The visual design in `styles.css` — kept Cloudflare orange on dark
  because it matches the brand.

---

## 10. What I'd do differently next time

- Run `wrangler dev` locally before the first `wrangler deploy`. I
  skipped straight to deploy and hit a peer-dependency error (`Could
not resolve "ai"`) that `wrangler dev` would have caught in ten
  seconds.
- Pin the `agents` SDK to an exact version instead of a caret range.
  I suspect the `esm.sh` CDN build I initially used for the frontend
  client didn't match the npm version I'd installed for the server.
- Keep `wrangler tail` open in a second terminal for the entire dev
  loop, not just when I remembered. The bugs that took longest to
  find were the ones where I wasn't watching the logs.

---

## Summary: the shortlist

If I had to compress this into rules:

1. Pick a specific direction before any code is written.
2. Make the model verify its own knowledge against live docs.
3. Describe flow and data, not syntax.
4. State constraints explicitly and upfront.
5. Debug with raw logs, not paraphrased symptoms.
6. Stop over-apologetic rewrites; demand surgical fixes.
7. Ask the model to distinguish "I know" from "I'm guessing."
8. Own the judgment calls and the deploy loop yourself.

Everything else — which model, which IDE, which prompt library — is
second order.
