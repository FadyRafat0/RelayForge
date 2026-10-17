const $ = (selector) => document.querySelector(selector);
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const explanations = {
  success:
    "The repeated ingestion request returned 200 with the original event. Only one delivery and one receiver effect were created.",
  retry:
    "Two HTTP 500 responses scheduled retries with exponential backoff and jitter. The third attempt succeeded under the same delivery ID.",
  dead: "HTTP 400 is a permanent failure. The delivery became dead after one attempt, with no receiver effect.",
  replay:
    "The receiver configuration was repaired, then an audited replay reopened the same delivery. Attempt history and delivery identity were preserved.",
};
let scenarios = [],
  selected,
  playbackTimers = [],
  playbackActive = false;
function stopPlayback() {
  playbackTimers.forEach(clearTimeout);
  playbackTimers = [];
  playbackActive = false;
  $("#play-button").textContent = "▶ Play recorded trace";
  $("#playback-status").textContent = "Recorded data";
  document
    .querySelectorAll("#timeline .dim")
    .forEach((item) => item.classList.remove("dim"));
}
function badge(status) {
  return element(
    "span",
    `badge ${status}`,
    status === "succeeded" ? "Succeeded" : "Dead letter",
  );
}
function showScenario(key) {
  stopPlayback();
  selected = scenarios.find((scenario) => scenario.key === key);
  if (!selected) return;
  document.querySelectorAll("#delivery-rows tr").forEach((row) => {
    const active = row.dataset.key === key;
    row.classList.toggle("selected-row", active);
    row.querySelector("button").setAttribute("aria-pressed", String(active));
  });
  $("#selected-key").textContent = selected.event_type;
  $("#detail-title").textContent = selected.title;
  $("#detail-status").replaceChildren(badge(selected.status));
  $("#delivery-id").textContent = `delivery / ${selected.id}`;
  $("#case-explanation").textContent = explanations[key];
  $("#effect-proof").textContent =
    `✓ ${selected.receiver_effects} committed receiver effect${selected.receiver_effects === 1 ? "" : "s"} · ${selected.attempt_count} persisted attempt${selected.attempt_count === 1 ? "" : "s"}`;
  const origin = Date.parse(selected.created_at);
  const events = [
    {
      at: origin,
      title: "Event accepted",
      detail: "HTTP 201 · event + delivery committed",
      status: "ok",
    },
    ...selected.attempts.map((attempt) => ({
      at: Date.parse(attempt.started_at),
      title: `Attempt ${attempt.attempt_number}`,
      detail: `HTTP ${attempt.http_status ?? "network failure"} · ${attempt.outcome}`,
      status: attempt.outcome === "succeeded" ? "ok" : "fail",
    })),
    ...selected.replays.map((replay) => ({
      at: Date.parse(replay.replayed_at),
      title: "Manual replay accepted",
      detail: `HTTP 202 · ${replay.reason}`,
      status: "audit",
    })),
  ].sort((a, b) => a.at - b.at);
  $("#timeline").replaceChildren(
    ...events.map((event) => {
      const item = element("li", event.status);
      item.dataset.offset = String(Math.max(0, event.at - origin));
      const line = element("div", "attempt-line");
      line.append(
        element("span", "", event.title),
        element("code", "", `+${((event.at - origin) / 1000).toFixed(2)}s`),
      );
      item.append(line, element("div", "attempt-meta", event.detail));
      return item;
    }),
  );
  $("#play-button").disabled = false;
}
$("#delivery-rows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-case]");
  if (button) showScenario(button.dataset.case);
});
$("#play-button").addEventListener("click", () => {
  if (playbackActive) {
    stopPlayback();
    return;
  }
  playbackActive = true;
  $("#play-button").textContent = "■ Stop playback";
  $("#playback-status").textContent = "Recorded trace · 4× playback";
  const items = [...$("#timeline").children];
  items.forEach((item) => item.classList.add("dim"));
  items.forEach((item) =>
    playbackTimers.push(
      setTimeout(
        () => item.classList.remove("dim"),
        Number(item.dataset.offset) / 4,
      ),
    ),
  );
  playbackTimers.push(
    setTimeout(
      () => {
        stopPlayback();
        $("#playback-status").textContent = "Playback complete · recorded data";
      },
      Math.max(...items.map((item) => Number(item.dataset.offset))) / 4 + 600,
    ),
  );
});

const components = {
  api: {
    title: "API: accept an obligation, not a promise of instant delivery.",
    body: "The API validates input and commits the event plus matching deliveries in one PostgreSQL transaction. A unique idempotency key arbitrates concurrent submissions. Same key and data return the original event; changed data return 409.",
    source: "src/events/store.ts",
  },
  postgres: {
    title: "PostgreSQL: delivery state survives queue failures.",
    body: "Events, delivery states, leases, attempt history and replay audits live in SQL. The dispatcher publishes first, then records its queue marker. A crash between those steps can duplicate a job, so reconciliation and workers must tolerate repetition.",
    source: "src/dispatch/batch.ts",
  },
  dispatcher: {
    title: "Dispatcher: reconcile the database with the queue.",
    body: "The dispatcher first recovers expired worker leases, then locks a bounded batch of due pending deliveries. It publishes their IDs and commits queue markers afterward. Stale pending work is republished after 60 seconds, so queue loss or an interrupted handoff does not erase the database obligation.",
    source: "src/dispatcher.ts",
  },
  redis: {
    title: "Redis Streams: coordinate workers without owning the truth.",
    body: "Consumer groups assign jobs. Workers acknowledge only after a durable outcome; idle pending messages can be reclaimed. A separate atomic Lua token bucket applies endpoint limits across worker processes.",
    source: "src/queue/redis.ts",
  },
  worker: {
    title: "Workers: claim briefly, release SQL, then send HTTP.",
    body: "Workers persist a 30-second lease and unique ownership token before sending. They do not hold a database connection across the HTTP request. Completion checks ownership, and expired claims consume their attempt budget before recovery.",
    source: "src/worker/claims.ts",
  },
  receiver: {
    title: "Receiver: verify the request, deduplicate the effect.",
    body: "HMAC verification checks the raw body, delivery metadata and timestamp. A unique receiver/delivery key and a transaction commit the receipt and example SQL effect together. Identical retries return success without applying the effect again; external effects need their own idempotency.",
    source: "src/receiver/inbox.ts",
  },
};
function showComponent(key) {
  const component = components[key];
  if (!component) return;
  const link = element("a", "", `Read ${component.source} ↗`);
  link.href = `https://github.com/FadyRafat0/RelayForge/blob/main/${component.source}`;
  $("#component-detail").replaceChildren(
    element("h2", "", component.title),
    element("p", "", component.body),
    link,
  );
  document.querySelectorAll("[data-component]").forEach((button) => {
    button.classList.toggle("active", button.dataset.component === key);
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.component === key),
    );
  });
}
document
  .querySelectorAll("[data-component]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      showComponent(button.dataset.component),
    ),
  );
showComponent("postgres");
function renderView() {
  const view = [
    "overview",
    "deliveries",
    "architecture",
    "benchmarks",
  ].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : "overview";
  stopPlayback();
  $("#overview-intro").hidden = view !== "overview";
  $("#traces-panel").hidden = !["overview", "deliveries"].includes(view);
  $("#architecture-panel").hidden = view !== "architecture";
  $("#benchmarks-panel").hidden = view !== "benchmarks";
  $("#breadcrumb").textContent = {
    overview: "Overview",
    deliveries: "Delivery explorer",
    architecture: "Architecture",
    benchmarks: "Benchmarks",
  }[view];
  document.querySelectorAll("[data-view]").forEach((link) => {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}
window.addEventListener("hashchange", renderView);
document.querySelectorAll("[data-go]").forEach((button) =>
  button.addEventListener("click", () => {
    location.hash = button.dataset.go;
  }),
);
renderView();
$("#local-button").addEventListener("click", () =>
  $("#local-dialog").showModal(),
);
$("#local-dialog .close").addEventListener("click", () =>
  $("#local-dialog").close(),
);
$("#copy-command").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#docker-command").textContent);
    $("#copy-status").textContent = "Command copied.";
  } catch {
    $("#copy-status").textContent = "Select and copy the command above.";
  }
});

async function loadTraces() {
  try {
    const response = await fetch("./traces.json");
    if (!response.ok) throw new Error("Unavailable");
    const recording = await response.json();
    scenarios = recording.scenarios;
    if (!Array.isArray(scenarios) || scenarios.length !== 4)
      throw new Error("Invalid recording");
    $(".recorded-date").textContent =
      `Captured ${new Date(recording.recorded_at).toISOString().slice(0, 10)}`;
    const values = [
      [
        "RECORDED DELIVERIES",
        scenarios.length,
        "Four verified delivery scenarios",
      ],
      [
        "DELIVERY ATTEMPTS",
        scenarios.reduce((n, s) => n + s.attempt_count, 0),
        "Every attempt preserved",
      ],
      [
        "RECEIVER EFFECTS",
        scenarios.reduce((n, s) => n + s.receiver_effects, 0),
        "Committed SQL effects",
      ],
      [
        "DEAD LETTERS",
        scenarios.filter((s) => s.status === "dead").length,
        "Permanent failure, inspectable",
      ],
    ];
    $("#stats").replaceChildren(
      ...values.map(([label, value, description], index) => {
        const card = element("div", "stat");
        card.append(
          element("span", "", label),
          element("strong", index === 2 ? "green" : "", String(value)),
          element("small", "", description),
        );
        return card;
      }),
    );
    $("#case-count").textContent = `${scenarios.length} scenarios`;
    $("#delivery-rows").replaceChildren(
      ...scenarios.map((scenario) => {
        const row = element("tr");
        row.dataset.key = scenario.key;
        const name = element("td");
        const button = element("button", "scenario-button", scenario.title);
        button.dataset.case = scenario.key;
        button.append(element("small", "", scenario.event_type));
        name.append(button);
        const status = element("td");
        status.append(badge(scenario.status));
        row.append(
          name,
          status,
          element("td", "mono", String(scenario.attempt_count)),
        );
        return row;
      }),
    );
    showScenario("retry");
  } catch {
    $("#trace-error").hidden = false;
    $("#trace-error").textContent =
      "The recorded traces could not be loaded. Refresh this page or inspect showcase/traces.json in the repository.";
    $("#stats").replaceChildren(
      element("div", "stat", "Recording unavailable"),
    );
    $(".recorded-date").textContent = "Recording unavailable";
  }
}
async function loadBenchmarks() {
  try {
    const response = await fetch("./benchmarks.json");
    if (!response.ok) throw new Error("Unavailable");
    const { runs } = await response.json();
    $("#benchmark-rows").replaceChildren(
      ...runs.map((run) => {
        const row = element("tr");
        for (const value of [
          `${run.rate} events/sec`,
          `${run.succeeded}/${run.expected}`,
          `${run.ingestion_p95_ms.toFixed(2)} ms`,
          `${(run.delivery_p95_ms / 1000).toFixed(2)} s`,
        ])
          row.append(element("td", "", value));
        return row;
      }),
    );
    const max = Math.max(...runs.map((run) => run.delivery_p95_ms));
    $("#latency-chart").replaceChildren(
      element(
        "div",
        "chart-title",
        "Delivery p95 · persisted event → receiver effect",
      ),
      ...runs.map((run) => {
        const row = element("div", "chart-row");
        const track = element("div", "chart-track");
        const bar = element("div", "chart-bar");
        bar.style.width = `${(run.delivery_p95_ms / max) * 100}%`;
        track.append(bar);
        row.append(
          element("span", "", `${run.rate} events/sec`),
          track,
          element(
            "span",
            "mono",
            `${(run.delivery_p95_ms / 1000).toFixed(2)} s`,
          ),
        );
        return row;
      }),
      element(
        "div",
        "chart-note",
        "Measured locally · 16 logical CPUs visible to Docker · about 7.60 GiB Docker memory · no per-container CPU limits",
      ),
    );
  } catch {
    $("#latency-chart").textContent =
      "Benchmark data unavailable. Raw measurements remain available in the GitHub repository.";
  }
}
await Promise.all([loadTraces(), loadBenchmarks()]);
