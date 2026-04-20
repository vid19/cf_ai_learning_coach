// Personal Learning Coach — browser client.
//
const sessionInput = document.getElementById("session");
const SESSION_KEY = "cf_ai_learning_coach.session";
sessionInput.value = localStorage.getItem(SESSION_KEY) || "demo-student";
sessionInput.addEventListener("change", () => {
  const v = sessionInput.value.trim() || "demo-student";
  sessionInput.value = v;
  localStorage.setItem(SESSION_KEY, v);
  location.reload();
});
localStorage.setItem(SESSION_KEY, sessionInput.value);

const INSTANCE = encodeURIComponent(sessionInput.value);

async function rpc(method, args = []) {
  const url = `/api/${INSTANCE}/${encodeURIComponent(method)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC ${method} failed: ${res.status} ${text}`);
  }
  return res.json();
}

const agent = new Proxy(
  {},
  {
    get:
      (_t, method) =>
      (...args) =>
        rpc(String(method), args),
  },
);

const messagesEl = document.getElementById("messages");
const quizPanel = document.getElementById("quizPanel");
const composer = document.getElementById("composer");
const inputEl = document.getElementById("input");
const resetBtn = document.getElementById("resetBtn");
const topicsEl = document.getElementById("topics");
const weakSpotsEl = document.getElementById("weakSpots");
const streakEl = document.getElementById("streak");
const quizCountEl = document.getElementById("quizCount");
const lastScoreEl = document.getElementById("lastScore");

function addMsg(role, text, kind = "chat") {
  const el = document.createElement("div");
  el.className = `msg ${role === "user" ? "user" : kind}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function thinking(text = "Thinking…") {
  const el = document.createElement("div");
  el.className = "msg assistant thinking";
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function renderStats(state) {
  if (!state) return;
  streakEl.textContent = state.streak ?? 0;
  quizCountEl.textContent = state.totalQuizzesTaken ?? 0;
  lastScoreEl.textContent =
    state.lastQuizScore == null ? "—" : `${state.lastQuizScore}%`;
}

function renderDashboard(data) {
  if (!data) return;
  renderStats(data.state);

  if (!data.topics || data.topics.length === 0) {
    topicsEl.innerHTML =
      '<li class="empty">No topics yet. Ask me to teach you something!</li>';
  } else {
    topicsEl.innerHTML = data.topics
      .map(
        (t) =>
          `<li><span>${escapeHtml(t.title)}</span><span class="mastery">${t.mastery}%</span></li>`,
      )
      .join("");
  }

  if (!data.weakSpots || data.weakSpots.length === 0) {
    weakSpotsEl.innerHTML =
      '<li class="empty">None yet — they\'ll appear after you take a quiz.</li>';
  } else {
    weakSpotsEl.innerHTML = data.weakSpots
      .map(
        (w) =>
          `<li><span>${escapeHtml(w.concept)}</span><span class="count">×${w.miss_count}</span></li>`,
      )
      .join("");
  }

  // Restore persisted message history on first load / reconnect.
  messagesEl.innerHTML = "";
  for (const m of data.recentMessages || []) {
    addMsg(m.role, m.content, m.kind || "chat");
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

const TEACH_RE =
  /^\s*(?:teach me(?: about)?|explain(?: to me)?|learn(?: about)?|lesson on|tell me about|what (?:is|are))\s+(.+?)\s*\??$/i;

const QUIZ_RE = /^\s*(?:qui[zs]+e?|test)\s+me(?:\s+on| about)?\s+(.+?)\s*\??$/i;

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = inputEl.value.trim();
  if (!raw) return;
  inputEl.value = "";

  addMsg("user", raw);

  const quizMatch = raw.match(QUIZ_RE);
  if (quizMatch) return startQuiz(quizMatch[1]);

  const teachMatch = raw.match(TEACH_RE);
  if (teachMatch) return teach(teachMatch[1]);

  return chat(raw);
});

document.querySelectorAll(".quick-actions button").forEach((b) => {
  b.addEventListener("click", () => {
    inputEl.value = b.dataset.quick;
    composer.dispatchEvent(new Event("submit"));
  });
});

resetBtn.addEventListener("click", async () => {
  if (!confirm("Wipe this session's memory? This cannot be undone.")) return;
  try {
    await agent.reset();
  } catch (err) {
    console.error(err);
  }
  location.reload();
});

// ---- Actions --------------------------------------------------------------

async function chat(text) {
  const t = thinking();
  try {
    const res = await agent.chat(text);
    t.remove();
    addMsg("assistant", res.reply);
    refreshDashboard();
  } catch (err) {
    t.textContent = `Error: ${err.message || err}`;
  }
}

async function teach(topic) {
  const t = thinking(`Preparing a lesson on "${topic}"…`);
  try {
    const res = await agent.generateLesson(topic);
    t.remove();
    addMsg(
      "assistant",
      `Outline:\n• ${res.outline.join("\n• ")}\n\n${res.lesson}`,
      "lesson",
    );
    refreshDashboard();
  } catch (err) {
    t.textContent = `Error: ${err.message || err}`;
  }
}

async function startQuiz(topic) {
  const t = thinking(`Building a quiz on "${topic}"…`);
  try {
    const { quizId, questions } = await agent.generateQuiz(topic, 3);
    t.remove();
    renderQuiz(quizId, topic, questions);
  } catch (err) {
    t.textContent = `Error: ${err.message || err}`;
  }
}

function renderQuiz(quizId, topic, questions) {
  const answers = {};

  const header = `
    <div class="quiz-header">
      <h3>📝 Quiz: ${escapeHtml(topic)}</h3>
      <button id="submitQuiz">Submit answers</button>
    </div>
  `;

  const body = questions
    .map(
      (q, i) => `
        <div class="quiz-question" data-qid="${q.id}">
          <div class="q-text"><strong>${i + 1}.</strong> ${escapeHtml(q.question)}</div>
          <div class="quiz-choices">
            ${q.choices
              .map(
                (c, ci) =>
                  `<button type="button" class="quiz-choice" data-choice="${ci}">${String.fromCharCode(65 + ci)}. ${escapeHtml(c)}</button>`,
              )
              .join("")}
          </div>
        </div>
      `,
    )
    .join("");

  quizPanel.innerHTML = header + body;
  quizPanel.hidden = false;

  quizPanel.querySelectorAll(".quiz-question").forEach((qEl) => {
    const qid = qEl.dataset.qid;
    qEl.querySelectorAll(".quiz-choice").forEach((cBtn) => {
      cBtn.addEventListener("click", () => {
        qEl
          .querySelectorAll(".quiz-choice")
          .forEach((x) => x.classList.remove("selected"));
        cBtn.classList.add("selected");
        answers[qid] = Number(cBtn.dataset.choice);
      });
    });
  });

  document.getElementById("submitQuiz").addEventListener("click", async () => {
    if (Object.keys(answers).length < questions.length) {
      alert("Please answer every question first.");
      return;
    }
    const submitBtn = document.getElementById("submitQuiz");
    submitBtn.disabled = true;
    submitBtn.textContent = "Grading…";

    try {
      const result = await agent.gradeQuiz(quizId, answers);
      renderQuizResults(questions, result, answers);
      refreshDashboard();
    } catch (err) {
      alert(`Error grading quiz: ${err.message || err}`);
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit answers";
    }
  });
}

function renderQuizResults(questions, result, answers) {
  const perQuestion = Object.fromEntries(
    result.perQuestion.map((p) => [p.id, p]),
  );
  const passed = result.score >= 70;

  const header = `
    <div class="quiz-header">
      <h3>Results</h3>
      <div style="display:flex;gap:8px;align-items:center;">
        <span class="score-badge ${passed ? "good" : "bad"}">${result.score}% (${result.perQuestion.filter((p) => p.correct).length}/${result.total})</span>
        <button id="closeQuiz" class="secondary">Done</button>
      </div>
    </div>
  `;

  const body = questions
    .map((q, i) => {
      const r = perQuestion[q.id];
      const picked = answers[q.id];
      const choices = q.choices
        .map((c, ci) => {
          let cls = "quiz-choice";
          if (ci === r.correctIndex) cls += " correct";
          else if (ci === picked) cls += " incorrect";
          return `<div class="${cls}">${String.fromCharCode(65 + ci)}. ${escapeHtml(c)}</div>`;
        })
        .join("");
      return `
        <div class="quiz-question">
          <div class="q-text"><strong>${i + 1}.</strong> ${escapeHtml(q.question)}</div>
          <div class="quiz-choices">${choices}</div>
          ${r.explanation ? `<div class="quiz-explanation"><strong>Why:</strong> ${escapeHtml(r.explanation)}</div>` : ""}
        </div>
      `;
    })
    .join("");

  quizPanel.innerHTML = header + body;
  addMsg("assistant", result.feedback, "quiz_result");

  document.getElementById("closeQuiz").addEventListener("click", () => {
    quizPanel.hidden = true;
    quizPanel.innerHTML = "";
  });
}

async function refreshDashboard() {
  try {
    const data = await agent.getDashboard();
    renderDashboard(data);
  } catch (err) {
    console.error("Dashboard refresh failed:", err);
  }
}

refreshDashboard().then(() => {
  if (messagesEl.children.length === 0) {
    addMsg(
      "assistant",
      "Hi! I'm your learning coach. I remember what you've studied and what trips you up.\n\nTry: \"teach me about binary search\" — or pick a quick action below.",
    );
  }
});
