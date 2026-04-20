/**
 * LearningCoach — a personal learning agent.
 *
 * Architecture (maps to the four required components):
 *   1. LLM:           Llama 3.3 70B (fp8-fast) via Workers AI binding `env.AI`.
 *   2. Coordination:  Durable Object (one instance per user/session) via the
 *                     Agents SDK. Multi-step flows (generate_lesson, generate_quiz,
 *                     grade_quiz) orchestrate several LLM calls and persist
 *                     intermediate state between them.
 *   3. User input:    Chat UI served from /public via the ASSETS binding; the
 *                     browser uses AgentClient (Agents SDK) to call these
 *                     @callable methods on the Durable Object over WebSocket.
 *                     Routing is handled by `routeAgentRequest()` from the SDK.
 *   4. Memory/state:  Two layers.
 *                       - this.state (small, synced, hot UI state)
 *                       - this.sql   (topics, quizzes, weak-spot history)
 *                     Plus this.schedule() for "come back and review" prompts.
 */

import { Agent, routeAgentRequest } from "agents";

// -- Types -------------------------------------------------------------------

export interface Env {
  AI: Ai;
  LearningCoach: DurableObjectNamespace;
  ASSETS: Fetcher;
}

type CoachState = {
  // Small, UI-facing state. Syncs to the client in real time via WebSocket.
  currentTopic: string | null;
  lastLessonAt: number | null;
  lastQuizScore: number | null;
  streak: number;
  totalQuizzesTaken: number;
};

type TopicRow = {
  id: string;
  title: string;
  created_at: number;
  last_studied_at: number;
  mastery: number; // 0..100
};

type WeakSpotRow = {
  id: string;
  topic_id: string;
  concept: string;
  miss_count: number;
  last_missed_at: number;
};

type QuizQuestion = {
  id: string;
  question: string;
  choices: string[];
  answer_index: number;
  concept: string;
  explanation: string;
};

type QuizRow = {
  id: string;
  topic_id: string;
  questions_json: string; // JSON-serialised QuizQuestion[]
  created_at: number;
  score: number | null;
  completed_at: number | null;
};

// The chat message shape we persist. (Kept separate from the model's
// message shape so we can add metadata like `kind` without breaking the LLM
// call.)
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  kind?: "chat" | "lesson" | "quiz" | "quiz_result" | "reminder";
};

// The Workers AI Llama 3.3 model ID. See:
// https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

// -- The Agent ---------------------------------------------------------------

export class LearningCoach extends Agent<Env, CoachState> {
  initialState: CoachState = {
    currentTopic: null,
    lastLessonAt: null,
    lastQuizScore: null,
    streak: 0,
    totalQuizzesTaken: 0,
  };

  /**
   * Ensure SQL tables exist. Called on every boot. `CREATE TABLE IF NOT EXISTS`
   * is cheap and idempotent; this is the recommended pattern for Agents since
   * each DO wakes fresh but the SQLite file persists.
   */
  async onStart(): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_studied_at INTEGER NOT NULL,
        mastery INTEGER NOT NULL DEFAULT 0
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS weak_spots (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        concept TEXT NOT NULL,
        miss_count INTEGER NOT NULL DEFAULT 1,
        last_missed_at INTEGER NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topics(id)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS quizzes (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        score INTEGER,
        completed_at INTEGER
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        kind TEXT
      )
    `;
  }

  // ========================================================================
  // Callable methods — invoked from the browser over HTTP.
  // ========================================================================

  /**
   * Simple chat turn. Includes the user's topic list and recent weak spots as
   * context so the coach feels like it "remembers" the student.
   */

  async chat(
    userMessage: string,
  ): Promise<{ reply: string; messages: ChatMessage[] }> {
    const now = Date.now();
    const userId = crypto.randomUUID();

    this.sql`
      INSERT INTO messages (id, role, content, created_at, kind)
      VALUES (${userId}, 'user', ${userMessage}, ${now}, 'chat')
    `;

    const memoryContext = this.buildMemoryContext();
    const recent = this.recentMessages(10);

    const systemPrompt = `You are a patient, encouraging personal learning coach.
You remember what the student has studied, what they struggle with, and you
adapt your replies to their level. Keep answers concise (under 180 words) and
end with either a follow-up question or a concrete next action (e.g. "Want a
quick 3-question quiz on this?").

${memoryContext}`;

    const reply = await this.callLLM([
      { role: "system", content: systemPrompt },
      ...recent.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ]);

    const replyId = crypto.randomUUID();
    this.sql`
      INSERT INTO messages (id, role, content, created_at, kind)
      VALUES (${replyId}, 'assistant', ${reply}, ${Date.now()}, 'chat')
    `;

    return { reply, messages: this.recentMessages(20) };
  }

  /**
   * Multi-step workflow: generate a short lesson on a topic.
   *   Step 1 — outline the lesson (LLM call 1).
   *   Step 2 — expand the outline into a full lesson (LLM call 2), reusing
   *            any weak spots we've recorded for this topic so the lesson
   *            targets them.
   *   Step 3 — persist the topic, update state, and schedule a review.
   *
   * Splitting the work into two LLM calls yields more structured lessons than
   * a single "write me a lesson" prompt.
   */

  async generateLesson(topic: string): Promise<{
    topicId: string;
    lesson: string;
    outline: string[];
  }> {
    const now = Date.now();
    const topicId = await this.upsertTopic(topic);

    // ---- Step 1: outline --------------------------------------------------
    const outlineRaw = await this.callLLM([
      {
        role: "system",
        content:
          "You output ONLY a JSON array of 3 to 5 short strings — the key " +
          "concepts of a beginner-to-intermediate lesson on the user's topic. " +
          "No prose, no markdown, no wrapping object. Example: " +
          '["Idea 1","Idea 2","Idea 3"]',
      },
      { role: "user", content: `Topic: ${topic}` },
    ]);
    const outline = this.safeParseStringArray(outlineRaw, [
      "Overview",
      "Core concepts",
      "Common pitfalls",
    ]);

    // ---- Step 2: the lesson itself, aware of known weak spots -----------
    const weakSpots = this.sql<WeakSpotRow>`
      SELECT * FROM weak_spots WHERE topic_id = ${topicId}
      ORDER BY miss_count DESC LIMIT 5
    `;
    const weakSpotHint =
      weakSpots.length > 0
        ? `\n\nThe student has previously struggled with: ${weakSpots
            .map((w) => w.concept)
            .join(", ")}. Give those extra attention.`
        : "";

    const lesson = await this.callLLM([
      {
        role: "system",
        content:
          "You are a skilled teacher. Write a clear, focused lesson (~300 " +
          "words) with short paragraphs. Include one simple concrete example. " +
          "No headings, no bullet points — just prose the student can read " +
          "straight through." +
          weakSpotHint,
      },
      {
        role: "user",
        content: `Topic: ${topic}\nCover these points in order: ${outline.join(
          " | ",
        )}`,
      },
    ]);

    // ---- Step 3: persist + update state + schedule review ---------------
    this.sql`
      UPDATE topics SET last_studied_at = ${now} WHERE id = ${topicId}
    `;
    this.sql`
      INSERT INTO messages (id, role, content, created_at, kind)
      VALUES (${crypto.randomUUID()}, 'assistant', ${lesson}, ${now}, 'lesson')
    `;
    this.setState({
      ...this.state,
      currentTopic: topic,
      lastLessonAt: now,
    });

    // Schedule a follow-up nudge in 24 hours. Demonstrates the Agents SDK
    // scheduler — the DO will wake itself up and run `reviewReminder`.
    await this.schedule(60 * 60 * 24, "reviewReminder", { topicId, topic });

    return { topicId, lesson, outline };
  }

  /**
   * Generate a quiz targeting the student's weakest concepts for this topic.
   * Returns the quiz WITHOUT the answers so the client can't cheat.
   */

  async generateQuiz(
    topic: string,
    numQuestions: number = 3,
  ): Promise<{
    quizId: string;
    questions: Array<Omit<QuizQuestion, "answer_index" | "explanation">>;
  }> {
    const topicId = await this.upsertTopic(topic);
    const n = Math.min(Math.max(numQuestions, 1), 5);

    const weakSpots = this.sql<WeakSpotRow>`
      SELECT * FROM weak_spots WHERE topic_id = ${topicId}
      ORDER BY miss_count DESC LIMIT 5
    `;
    const focusLine =
      weakSpots.length > 0
        ? `Focus especially on: ${weakSpots.map((w) => w.concept).join(", ")}.`
        : "";

    const raw = await this.callLLM([
      {
        role: "system",
        content:
          `You produce multiple-choice quizzes as strict JSON.\n` +
          `Your response MUST start with '{' and end with '}'. No prose, no ` +
          `markdown fences, no commentary before or after. Schema:\n` +
          `{"questions":[{"id":"q1","question":"...","choices":["A","B","C","D"],` +
          `"answer_index":0,"concept":"short concept name","explanation":"why"}]}\n` +
          `Rules:\n` +
          `- Exactly ${n} questions.\n` +
          `- Each question has exactly 4 choices.\n` +
          `- answer_index is 0-based (0, 1, 2, or 3).\n` +
          `- Keep explanations under 25 words.`,
      },
      { role: "user", content: `Topic: ${topic}. ${focusLine}` },
    ]);

    const parsed = this.safeParseQuiz(raw, n);
    const quizId = crypto.randomUUID();

    this.sql`
      INSERT INTO quizzes (id, topic_id, questions_json, created_at)
      VALUES (${quizId}, ${topicId}, ${JSON.stringify(parsed)}, ${Date.now()})
    `;

    // Strip answers before sending to the client.
    const clientQuestions = parsed.map((q) => ({
      id: q.id,
      question: q.question,
      choices: q.choices,
      concept: q.concept,
    }));

    return { quizId, questions: clientQuestions };
  }

  /**
   * Grade a quiz submission. Updates weak-spot counters for any missed
   * concepts and the user's running mastery score for the topic.
   */

  async gradeQuiz(
    quizId: string,
    answers: Record<string, number>,
  ): Promise<{
    score: number;
    total: number;
    perQuestion: Array<{
      id: string;
      correct: boolean;
      correctIndex: number;
      explanation: string;
      concept: string;
    }>;
    feedback: string;
  }> {
    const [quiz] = this.sql<QuizRow>`
      SELECT * FROM quizzes WHERE id = ${quizId}
    `;
    if (!quiz) throw new Error(`No quiz with id ${quizId}`);
    if (quiz.completed_at) throw new Error("Quiz already graded");

    const questions: QuizQuestion[] = JSON.parse(quiz.questions_json);
    const now = Date.now();
    let correctCount = 0;
    const perQuestion = [] as Array<{
      id: string;
      correct: boolean;
      correctIndex: number;
      explanation: string;
      concept: string;
    }>;

    for (const q of questions) {
      const picked = answers[q.id];
      const correct = picked === q.answer_index;
      if (correct) {
        correctCount++;
      } else {
        // Record the miss so future lessons/quizzes can target it.
        this.recordWeakSpot(quiz.topic_id, q.concept, now);
      }
      perQuestion.push({
        id: q.id,
        correct,
        correctIndex: q.answer_index,
        explanation: q.explanation,
        concept: q.concept,
      });
    }

    const score = Math.round((correctCount / questions.length) * 100);

    this.sql`
      UPDATE quizzes SET score = ${score}, completed_at = ${now}
      WHERE id = ${quizId}
    `;

    // Roll mastery toward the latest score (exponential moving average).
    const [topicRow] = this.sql<TopicRow>`
      SELECT * FROM topics WHERE id = ${quiz.topic_id}
    `;
    if (topicRow) {
      const newMastery = Math.round(topicRow.mastery * 0.6 + score * 0.4);
      this.sql`
        UPDATE topics SET mastery = ${newMastery}, last_studied_at = ${now}
        WHERE id = ${quiz.topic_id}
      `;
    }

    // Ask Llama for one paragraph of personalised feedback.
    const missed = perQuestion.filter((p) => !p.correct).map((p) => p.concept);
    const feedback = await this.callLLM([
      {
        role: "system",
        content:
          "You give brief (under 80 words), encouraging quiz feedback. " +
          "Mention what the student got right, what to revisit, and suggest " +
          "one concrete next step. No lists, just a single paragraph.",
      },
      {
        role: "user",
        content: `Score: ${score}%. Missed concepts: ${
          missed.length > 0 ? missed.join(", ") : "none"
        }.`,
      },
    ]);

    this.setState({
      ...this.state,
      lastQuizScore: score,
      totalQuizzesTaken: this.state.totalQuizzesTaken + 1,
      streak: score >= 70 ? this.state.streak + 1 : 0,
    });

    this.sql`
      INSERT INTO messages (id, role, content, created_at, kind)
      VALUES (${crypto.randomUUID()}, 'assistant', ${feedback}, ${now}, 'quiz_result')
    `;

    return { score, total: questions.length, perQuestion, feedback };
  }

  /**
   * Dashboard data: everything the frontend needs to render the sidebar.
   */

  async getDashboard(): Promise<{
    state: CoachState;
    topics: TopicRow[];
    weakSpots: Array<WeakSpotRow & { topic_title: string }>;
    recentMessages: ChatMessage[];
  }> {
    const topics = this.sql<TopicRow>`
      SELECT * FROM topics ORDER BY last_studied_at DESC
    `;
    const weakSpots = this.sql<WeakSpotRow & { topic_title: string }>`
      SELECT w.*, t.title AS topic_title
      FROM weak_spots w JOIN topics t ON t.id = w.topic_id
      ORDER BY w.miss_count DESC, w.last_missed_at DESC
      LIMIT 10
    `;
    return {
      state: this.state,
      topics,
      weakSpots,
      recentMessages: this.recentMessages(30),
    };
  }

  /**
   * Manual reset — useful for demos. Clears all memory.
   */

  async reset(): Promise<{ ok: true }> {
    this.sql`DELETE FROM messages`;
    this.sql`DELETE FROM weak_spots`;
    this.sql`DELETE FROM quizzes`;
    this.sql`DELETE FROM topics`;
    this.setState({ ...this.initialState });
    return { ok: true };
  }

  // ========================================================================
  // Scheduled task — runs in the background when the DO wakes itself up.
  // ========================================================================

  /**
   * Fires 24h after a lesson. Leaves a reminder in the message log so it
   * shows up the next time the student opens the app.
   */
  async reviewReminder(payload: { topicId: string; topic: string }) {
    const [topicRow] = this.sql<TopicRow>`
      SELECT * FROM topics WHERE id = ${payload.topicId}
    `;
    if (!topicRow) return; // topic was deleted — nothing to do.

    const msg =
      `👋 Quick check-in: you studied "${payload.topic}" yesterday. ` +
      `Want to lock it in with a short quiz? Just say "quiz me on ${payload.topic}".`;

    this.sql`
      INSERT INTO messages (id, role, content, created_at, kind)
      VALUES (${crypto.randomUUID()}, 'assistant', ${msg}, ${Date.now()}, 'reminder')
    `;
  }

  // ========================================================================
  // Private helpers.
  // ========================================================================

  private async callLLM(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    // We cast to `any` deliberately — modern @cloudflare/workers-types infers
    // per-model response shapes, which is stricter than we need here.
    const out = (await (this.env.AI as any).run(MODEL, {
      messages,
      max_tokens: 800,
    })) as unknown;

    // Workers AI responses come in a few shapes depending on model/version:
    //   1. Plain string   (older models)
    //   2. { response: "..." }               (most text models)
    //   3. { response: {...object...}, ... } (Llama 3.3 sometimes does this
    //      when it thinks the response is structured — e.g. valid JSON)
    //   4. { response: "...", tool_calls, usage, ... } (full envelope)
    if (typeof out === "string") return out;
    if (out && typeof out === "object" && "response" in out) {
      const r = (out as any).response;
      if (typeof r === "string") return r;
      // Structured response — re-serialise it so downstream JSON parsers
      // (like safeParseQuiz) can pick it up.
      if (r !== null && r !== undefined) return JSON.stringify(r);
    }
    return JSON.stringify(out);
  }

  private buildMemoryContext(): string {
    const topics = this.sql<TopicRow>`
      SELECT * FROM topics ORDER BY last_studied_at DESC LIMIT 5
    `;
    const weak = this.sql<WeakSpotRow & { topic_title: string }>`
      SELECT w.*, t.title AS topic_title
      FROM weak_spots w JOIN topics t ON t.id = w.topic_id
      ORDER BY w.miss_count DESC LIMIT 5
    `;

    const parts: string[] = [];
    if (topics.length > 0) {
      parts.push(
        `Recent topics the student has studied: ${topics
          .map((t) => `${t.title} (mastery ${t.mastery}%)`)
          .join("; ")}.`,
      );
    }
    if (weak.length > 0) {
      parts.push(
        `Concepts they've struggled with: ${weak
          .map((w) => `${w.concept} [${w.topic_title}]`)
          .join("; ")}.`,
      );
    }
    if (this.state.streak > 0) {
      parts.push(`Current passing-quiz streak: ${this.state.streak}.`);
    }
    return parts.length > 0
      ? `Known about this student:\n${parts.join("\n")}`
      : "";
  }

  private recentMessages(limit: number): ChatMessage[] {
    // Query ASC ordered for feeding into the LLM / rendering the UI.
    const rows = this.sql<ChatMessage>`
      SELECT * FROM (
        SELECT * FROM messages ORDER BY created_at DESC LIMIT ${limit}
      ) ORDER BY created_at ASC
    `;
    return rows;
  }

  private async upsertTopic(title: string): Promise<string> {
    const normalized = title.trim().toLowerCase();
    const [existing] = this.sql<TopicRow>`
      SELECT * FROM topics WHERE lower(title) = ${normalized} LIMIT 1
    `;
    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql`
      INSERT INTO topics (id, title, created_at, last_studied_at, mastery)
      VALUES (${id}, ${title.trim()}, ${now}, ${now}, 0)
    `;
    return id;
  }

  private recordWeakSpot(topicId: string, concept: string, now: number): void {
    const [existing] = this.sql<WeakSpotRow>`
      SELECT * FROM weak_spots
      WHERE topic_id = ${topicId} AND concept = ${concept}
      LIMIT 1
    `;
    if (existing) {
      this.sql`
        UPDATE weak_spots
        SET miss_count = miss_count + 1, last_missed_at = ${now}
        WHERE id = ${existing.id}
      `;
    } else {
      this.sql`
        INSERT INTO weak_spots (id, topic_id, concept, miss_count, last_missed_at)
        VALUES (${crypto.randomUUID()}, ${topicId}, ${concept}, 1, ${now})
      `;
    }
  }

  private safeParseStringArray(raw: string, fallback: string[]): string[] {
    try {
      // LLMs occasionally wrap JSON in ```json fences — strip them.
      const cleaned = raw
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed.slice(0, 5);
      }
    } catch {
      /* fall through */
    }
    return fallback;
  }

  private safeParseQuiz(raw: string, expectedCount: number): QuizQuestion[] {
    // Llama 3.3 can't be fully trusted to output pure JSON. It often:
    //   - wraps output in ```json ... ``` fences
    //   - prefixes with "Here is the quiz:" or similar
    //   - adds trailing commentary
    // Strategy: extract the largest brace-matched JSON object from the raw
    // response, ignoring everything outside it.
    const extracted = extractJsonObject(raw) ?? raw.trim();

    let questions: QuizQuestion[] = [];
    try {
      const parsed = JSON.parse(extracted);
      const arr = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(arr)) throw new Error("not an array");

      questions = arr.map((q: any, i: number) => {
        const choices = Array.isArray(q.choices) ? q.choices.slice(0, 4) : [];
        while (choices.length < 4) choices.push("(no option)");
        const answerIndex = Math.max(
          0,
          Math.min(3, Number.isInteger(q.answer_index) ? q.answer_index : 0),
        );
        return {
          id: typeof q.id === "string" ? q.id : `q${i + 1}`,
          question: String(q.question ?? "Question missing"),
          choices: choices.map(String),
          answer_index: answerIndex,
          concept: String(q.concept ?? "general"),
          explanation: String(q.explanation ?? ""),
        };
      });
    } catch (err) {
      console.error("Quiz JSON parse failed. Raw response:", raw);
      // Fallback so the UI never crashes mid-demo.
      questions = Array.from({ length: expectedCount }, (_, i) => ({
        id: `q${i + 1}`,
        question: "The model returned invalid JSON — please try again.",
        choices: ["Retry", "Retry", "Retry", "Retry"],
        answer_index: 0,
        concept: "parser_fallback",
        explanation: "The LLM output could not be parsed as quiz JSON.",
      }));
    }

    return questions.slice(0, expectedCount);
  }
}

/**
 * Pull the first brace-balanced `{...}` block out of an arbitrary string.
 * Used to salvage JSON from LLM responses that sometimes include leading
 * commentary, code fences, or trailing explanations.
 *
 * Returns the matched substring, or null if no balanced block was found.
 * Ignores braces that appear inside double-quoted strings so we don't
 * mis-match on a `"}"` literal.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

// ============================================================================
// Worker entrypoint.
//
// Two paths:
//   - /api/:sessionId/:method  →  our own simple HTTP RPC. Calls a method on
//     the LearningCoach Durable Object directly via standard DO RPC. This is
//     what the browser UI uses.
//   - Anything else →  tries `routeAgentRequest(request, env)` first (so
//     WebSocket upgrades / other Agents-SDK features still work), then falls
//     back to the static assets binding (the chat UI in /public).
//
// We use our own /api/ route rather than the SDK's HTTP scheme because the
// SDK's @callable HTTP dispatch URL differs between versions; calling the
// DO's public methods directly via `stub.methodName()` is a guaranteed-stable
// Durable Object runtime feature.
// ============================================================================

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Simple HTTP RPC: POST /api/:sessionId/:method, body { args: [...] }.
    const apiMatch = url.pathname.match(/^\/api\/([^/]+)\/([^/]+)\/?$/);
    if (apiMatch) {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "content-type": "application/json" },
        });
      }
      const [, sessionId, method] = apiMatch;
      try {
        const body = (await request.json().catch(() => ({}))) as {
          args?: unknown[];
        };
        const args = Array.isArray(body.args) ? body.args : [];

        const id = env.LearningCoach.idFromName(sessionId);
        const stub = env.LearningCoach.get(id) as any;

        if (typeof stub[method] !== "function") {
          return new Response(
            JSON.stringify({ error: `Unknown method: ${method}` }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }

        const result = await stub[method](...args);
        return new Response(JSON.stringify(result ?? null), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err?.message ?? String(err) }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    }

    // Fall through to the Agents SDK router (handles WebSocket etc.), then
    // static assets.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
