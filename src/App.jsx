import { useEffect, useMemo, useState } from "react";

const PROFILE_FLAGS = {
  "copy-rename": { copyRename: true },
  regression: { copyRename: true, regression: true },
  discovery: { discovery: true },
  "demo-head": { copyRename: true, regression: true, discovery: true },
  "dom-refactor": { domRefactor: true },
  "removed-control": { removedControl: true },
  timeout: { timeout: true },
};

const STAGE_TITLES = {
  "use-case": "Choose a route",
  team: "Set up your crew",
  "invite-confirm": "Confirm invitations",
  solo: "Choose a starting point",
  done: "Workspace ready",
  error: "Setup interrupted",
  timeout: "Setup still in progress",
};

class ApiError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = "ApiError";
    this.payload = payload;
  }
}

async function apiRequest(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { message: raw };
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload.error?.message || payload.message || payload.error || `Request failed (${response.status})`,
      payload,
    );
  }

  return payload;
}

function profileName(profile) {
  if (typeof profile === "string" && profile) return profile;
  if (profile && typeof profile === "object") {
    return profile.id || profile.name || profile.key || "baseline";
  }
  return "baseline";
}

function statePath(state, authenticated) {
  if (!authenticated) return "/login";
  const stage = state?.stage || "use-case";
  if (stage === "use-case") return "/onboarding/use-case";
  if (stage === "team") return "/onboarding/team";
  if (stage === "invite-confirm") return "/onboarding/team/invitations";
  if (stage === "solo") return "/onboarding/solo";
  if (stage === "done") return `/done/${state?.outcome || "workspace-ready"}`;
  if (stage === "error") return "/error";
  if (stage === "timeout") return "/timeout";
  return "/onboarding";
}

function updateLocation(path) {
  if (!path || typeof path !== "string") return;
  try {
    const next = new URL(path, window.location.origin);
    if (next.origin === window.location.origin) {
      window.history.replaceState({}, "", `${next.pathname}${next.search}${next.hash}`);
    }
  } catch {
    // A malformed optional navigateTo should not break the fixture UI.
  }
}

function readableError(error) {
  if (!error) return "Nimbus could not complete that request.";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  if (typeof error.code === "string") return error.code.replaceAll("_", " ");
  return "Nimbus could not complete that request.";
}

function mergeActionResponse(previous, response) {
  return {
    ...previous,
    ...(typeof response.authenticated === "boolean"
      ? { authenticated: response.authenticated }
      : null),
    ...(response.user ? { user: response.user } : null),
    ...(response.profile ? { profile: response.profile } : null),
    state: response.state || previous.state,
  };
}

function ArrowGlyph() {
  return (
    <svg viewBox="0 0 26 14" aria-hidden="true">
      <path d="M1 7h22M17 1l6 6-6 6" />
    </svg>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function RouteSketch() {
  return (
    <svg className="route-sketch" viewBox="0 0 254 360" aria-hidden="true">
      <path className="route-sketch__grid" d="M22 22h210v316H22zM22 101h210M22 180h210M22 259h210M74 22v316M127 22v316M180 22v316" />
      <path className="route-sketch__line" d="M58 52c61 18 5 76 68 92 59 15 82-14 79 48-3 66-102 27-123 91-10 31 19 44 63 42" />
      <circle cx="58" cy="52" r="8" />
      <circle cx="126" cy="144" r="8" />
      <circle cx="82" cy="283" r="8" />
      <path className="route-sketch__accent" d="M145 325h62M199 317l8 8-8 8" />
      <text x="72" y="49">START</text>
      <text x="141" y="141">CHOOSE</text>
      <text x="96" y="280">ARRIVE</text>
    </svg>
  );
}

function RouteMap({ stage }) {
  const position =
    stage === "use-case"
      ? 0
      : ["team", "solo", "invite-confirm"].includes(stage)
        ? 1
        : 2;

  const steps = [
    ["01", "Orientation"],
    ["02", "The route"],
    ["03", "Arrival"],
  ];

  return (
    <nav className="route-map" aria-label="Workspace setup progress">
      <p className="eyebrow">Route index</p>
      <ol>
        {steps.map(([number, label], index) => (
          <li
            key={number}
            className={index < position ? "is-complete" : index === position ? "is-current" : ""}
            aria-current={index === position ? "step" : undefined}
          >
            <span className="route-map__number">{number}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function FieldNote({ stage }) {
  const notes = {
    "use-case": [
      "Field note 01",
      "Routes shape the defaults, not the destination. Pick the way you work today; every setting remains editable later.",
    ],
    team: [
      "Field note 02A",
      "A shared trail can begin with everyone on board, or with a quiet camp that you open up later.",
    ],
    "invite-confirm": [
      "Field note 02B",
      "One last check before the invitations leave. Nimbus keeps the setup reversible until you confirm.",
    ],
    solo: [
      "Field note 02C",
      "A starting point is simply scaffolding. Choose structure, open space, or bring an existing map with you.",
    ],
    done: [
      "Field note 03",
      "You have arrived. The route is recorded, the workspace is ready, and every choice can be revisited.",
    ],
    error: [
      "Route advisory",
      "This branch ended before arrival. Your earlier choices remain intact and no partial workspace was published.",
    ],
    timeout: [
      "Route advisory",
      "This branch has not reached a terminal marker. It stays here intentionally so a runner can record the timeout.",
    ],
  };
  const [label, text] = notes[stage] || notes["use-case"];

  return (
    <aside className="field-note" aria-label={label}>
      <span>{label}</span>
      <p>{text}</p>
    </aside>
  );
}

function ChoiceCard({ index, label, description, detail, onChoose, disabled, tone = "forest" }) {
  return (
    <button
      type="button"
      className={`choice-card choice-card--${tone}`}
      aria-label={label}
      aria-busy={disabled || undefined}
      disabled={disabled}
      onClick={onChoose}
    >
      <span className="choice-card__index" aria-hidden="true">
        {String(index).padStart(2, "0")}
      </span>
      <span className="choice-card__body">
        <strong>{label}</strong>
        <span>{description}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className="choice-card__arrow" aria-hidden="true">
        <ArrowGlyph />
      </span>
    </button>
  );
}

function StageHeader({ folio, kicker, title, introduction }) {
  return (
    <header className="stage-header">
      <div className="stage-header__meta">
        <span>{kicker}</span>
        <span>Folio {folio}</span>
      </div>
      <h1>{title}</h1>
      <p>{introduction}</p>
    </header>
  );
}

function UseCaseStage({ flags, act, pending }) {
  const options = [
    {
      action: "choose_team",
      label: "Team plan",
      description: "Invite people and shape one shared workspace.",
      detail: "Best for projects with a common trail",
    },
    {
      action: "choose_solo",
      label: "Solo plan",
      description: "Start quietly, with room to invite people later.",
      detail: "Best for focused, independent work",
    },
    {
      action: "choose_later",
      label: "Decide later",
      description: "Keep your place and choose after you have explored.",
      detail: "No defaults are locked in",
    },
  ];

  const ordered = flags.domRefactor ? [options[2], options[0], options[1]] : options;

  return (
    <section className="stage" aria-labelledby="use-case-title">
      <StageHeader
        folio="01 / 03"
        kicker="Orientation"
        title="How will you use Nimbus?"
        introduction="Choose the route that feels closest to the work ahead. This only tunes your starting conditions."
      />
      <span id="use-case-title" className="sr-only">Choose a Nimbus use case</span>
      <div className={`choice-grid choice-grid--three ${flags.domRefactor ? "choice-grid--reframed" : ""}`}>
        {ordered.map((option, index) => (
          <ChoiceCard
            key={option.action}
            index={index + 1}
            {...option}
            disabled={Boolean(pending)}
            onChoose={() => act(option.action)}
            tone={option.action === "choose_later" ? "paper" : "forest"}
          />
        ))}
      </div>
    </section>
  );
}

function TeamStage({ act, pending }) {
  return (
    <section className="stage" aria-labelledby="team-stage-title">
      <StageHeader
        folio="02A / 03"
        kicker="Shared route"
        title="Bring your people along."
        introduction="A team workspace works with one person or many. Decide whether the invitations should leave now."
      />
      <span id="team-stage-title" className="sr-only">Choose how to invite teammates</span>
      <div className="choice-grid choice-grid--two">
        <ChoiceCard
          index={1}
          label="Invite teammates"
          description="Review and send the prepared invitations now."
          detail="3 invitations are ready to confirm"
          disabled={Boolean(pending)}
          onChoose={() => act("invite_team")}
        />
        <ChoiceCard
          index={2}
          label="Skip invites"
          description="Open the workspace first and invite people later."
          detail="Members can always be added from settings"
          disabled={Boolean(pending)}
          onChoose={() => act("skip_invites")}
          tone="paper"
        />
      </div>
    </section>
  );
}

function InviteConfirmStage({ act, pending }) {
  return (
    <section className="stage stage--dialog" aria-labelledby="invite-stage-title">
      <div className="dialog-map" aria-hidden="true">
        <RouteSketch />
      </div>
      <dialog className="confirm-dialog" open aria-modal="true" aria-labelledby="invite-stage-title" aria-describedby="invite-copy">
        <span className="confirm-dialog__stamp" aria-hidden="true">Ready</span>
        <p className="eyebrow">Final checkpoint · 02B</p>
        <h1 id="invite-stage-title">Send three invitations?</h1>
        <p id="invite-copy">
          Each person will receive a single invitation to the new Nimbus workspace. No reminders are sent automatically.
        </p>
        <ul className="invite-list" aria-label="Prepared invitations">
          <li><span>AK</span><span><strong>Alex Kim</strong><small>Product</small></span></li>
          <li><span>MO</span><span><strong>Morgan Ortiz</strong><small>Design</small></span></li>
          <li><span>JL</span><span><strong>Jordan Lee</strong><small>Engineering</small></span></li>
        </ul>
        <button
          type="button"
          className="primary-action"
          aria-label="Send invitations"
          aria-busy={Boolean(pending) || undefined}
          disabled={Boolean(pending)}
          onClick={() => act("confirm_invites")}
        >
          <span>{pending ? "Sending invitations…" : "Send invitations"}</span>
          <ArrowGlyph />
        </button>
      </dialog>
    </section>
  );
}

function SoloStage({ flags, act, pending }) {
  const starterLabel = flags.copyRename ? "Use a starter" : "Starter template";
  const options = [];

  if (!flags.removedControl) {
    options.push({
      action: "choose_starter",
      label: starterLabel,
      description: "Begin with a considered project structure already in place.",
      detail: "Includes a roadmap, tasks, and weekly review",
    });
  }

  options.push({
    action: "choose_blank",
    label: "Blank workspace",
    description: "Begin with an open field and shape every detail yourself.",
    detail: "No sample projects or default views",
    tone: "paper",
  });

  if (flags.discovery) {
    options.push({
      action: "choose_import",
      label: "Import from CSV",
      description: "Bring existing records across from a spreadsheet.",
      detail: "A new route discovered in this edition",
      tone: "coral",
    });
  }

  const ordered = flags.domRefactor ? [...options].reverse() : options;

  return (
    <section className="stage" aria-labelledby="solo-stage-title">
      <StageHeader
        folio="02C / 03"
        kicker="Independent route"
        title="Pick a starting point."
        introduction="Structure can help, and empty space can too. Everything here remains editable once the workspace opens."
      />
      <span id="solo-stage-title" className="sr-only">Choose a workspace starting point</span>
      <div className={`choice-grid ${ordered.length > 2 ? "choice-grid--three" : "choice-grid--two"}`}>
        {ordered.map((option, index) => (
          <ChoiceCard
            key={option.action}
            index={index + 1}
            {...option}
            disabled={Boolean(pending)}
            onChoose={() => act(option.action)}
          />
        ))}
      </div>
    </section>
  );
}

function outcomeCopy(state) {
  const source = [state?.outcome, state?.plan, state?.selection, ...(state?.path || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (source.includes("import") || source.includes("csv")) {
    return ["Records imported", "Your existing records have a new home.", "Solo · CSV import", "IM"];
  }
  if (source.includes("starter") || source.includes("template")) {
    return ["Starter project created", "A thoughtful structure is waiting for your first idea.", "Solo · Starter", "ST"];
  }
  if (source.includes("blank") || source.includes("empty")) {
    return ["Empty workspace ready", "A clear field, ready to take the shape of your work.", "Solo · Blank", "BL"];
  }
  if (source.includes("skip") && source.includes("invite")) {
    return ["Team workspace ready", "Your shared space is open; invitations can wait.", "Team · Invites skipped", "TS"];
  }
  if (source.includes("invite")) {
    return ["Invitations sent", "Three people now have a route into the workspace.", "Team · Invitations", "TI"];
  }
  if (source.includes("later") || source.includes("defer")) {
    return ["Progress saved for later", "Your place is marked. Continue whenever the route is clearer.", "Deferred setup", "DL"];
  }
  return ["Workspace ready", "Nimbus is set up and ready for the work ahead.", "Setup complete", "OK"];
}

function DoneStage({ state }) {
  const [title, copy, route, initials] = outcomeCopy(state);
  return (
    <section className="terminal terminal--success" aria-labelledby="done-title">
      <div className="terminal__seal" aria-hidden="true">
        <span>{initials}</span>
        <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" /><path d="M27 53l15 15 31-36" /></svg>
      </div>
      <p className="eyebrow">Arrival confirmed · 03</p>
      <h1 id="done-title">{title}</h1>
      <p className="terminal__lede">{copy}</p>
      <dl className="arrival-record">
        <div><dt>Status</dt><dd><span className="status-dot" />Setup complete</dd></div>
        <div><dt>Recorded route</dt><dd>{route}</dd></div>
        <div><dt>Account</dt><dd>demo@example.com</dd></div>
      </dl>
      <p className="terminal__footnote">Everything below this point can be changed from workspace settings.</p>
    </section>
  );
}

function ErrorStage({ state }) {
  const source = [state?.error, state?.outcome, state?.selection, ...(state?.path || [])]
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ")
    .toLowerCase();
  const routeMessage = source.includes("blank")
    ? "The blank workspace could not be created."
    : source.includes("later") || source.includes("defer")
      ? "Nimbus could not save this setup for later."
      : readableError(state?.error);

  return (
    <section className="terminal terminal--error" role="alert" aria-labelledby="error-title">
      <div className="terminal__seal terminal__seal--error" aria-hidden="true">
        <span>!</span>
        <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" /><path d="M50 27v31M50 70v2" /></svg>
      </div>
      <p className="eyebrow">Route ended · 03</p>
      <h1 id="error-title">Something went off route.</h1>
      <p className="terminal__lede">{routeMessage}</p>
      <div className="error-record">
        <span>Setup incomplete</span>
        <p>Your signed-in session and earlier choices are safe. No partial workspace was published.</p>
      </div>
    </section>
  );
}

function TimeoutStage() {
  return (
    <section className="terminal terminal--timeout" aria-labelledby="timeout-title">
      <div className="timeout-compass" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="eyebrow">No arrival marker · 03</p>
      <h1 id="timeout-title">This route is taking longer than expected.</h1>
      <p className="terminal__lede">Nimbus has not reached a finished screen.</p>
      <div className="waiting-line" role="status" aria-live="polite">
        <span className="waiting-line__pulse" />
        Still preparing your workspace…
      </div>
      <p className="terminal__footnote">This fixture intentionally remains here so the QA runner can record a timeout.</p>
    </section>
  );
}

function UnknownStage({ stage, reload, pending }) {
  return (
    <section className="terminal terminal--error" role="alert">
      <p className="eyebrow">Unknown route</p>
      <h1>The field guide lost its place.</h1>
      <p className="terminal__lede">The server returned an unsupported stage: {String(stage)}</p>
      <button type="button" className="primary-action" onClick={reload} disabled={pending}>
        <span>Reload current session</span><ArrowGlyph />
      </button>
    </section>
  );
}

function LoginScreen({ onLogin, pending, error }) {
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("");

  function submit(event) {
    event.preventDefault();
    onLogin({ email, password });
  }

  return (
    <div className="login-shell" data-stage="login">
      <header className="login-header">
        <a className="brand" href="/" aria-label="Nimbus home">
          <BrandMark />
          <span>Nimbus</span>
        </a>
        <span className="fixture-label">Browser QA fixture · Edition 01</span>
      </header>
      <main className="login-layout">
        <section className="login-intro" aria-labelledby="login-intro-title">
          <p className="eyebrow">A field guide to better work</p>
          <h1 id="login-intro-title">Begin where every good route begins.</h1>
          <p>Sign in, find your bearings, and shape a workspace around the way you actually work.</p>
          <RouteSketch />
        </section>
        <section className="login-panel" aria-labelledby="login-title">
          <div className="login-panel__folio">Entry card · 00</div>
          <h2 id="login-title">Welcome back.</h2>
          <p>Use the test account supplied with this run.</p>
          <form onSubmit={submit} className="login-form">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <button
              type="submit"
              className="primary-action primary-action--wide"
              aria-label="Sign in"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              <span>{pending ? "Signing in…" : "Sign in and continue"}</span>
              <ArrowGlyph />
            </button>
          </form>
          <p className="login-panel__note">A deterministic workspace is restored for every test session.</p>
        </section>
      </main>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <BrandMark />
      <p>Opening the field guide…</p>
    </div>
  );
}

function FatalScreen({ message, retry }) {
  return (
    <main className="fatal-screen" role="alert">
      <p className="eyebrow">Connection note</p>
      <h1>The fixture did not answer.</h1>
      <p>{message}</p>
      <button type="button" className="primary-action" onClick={retry}>
        <span>Try the session again</span><ArrowGlyph />
      </button>
    </main>
  );
}

function WorkspaceShell({ session, pending, onAction, onLogout, reload }) {
  const stage = session.state?.stage || "use-case";
  const profile = profileName(session.profile);
  const flags = PROFILE_FLAGS[profile] || {};

  let content;
  if (stage === "use-case") content = <UseCaseStage flags={flags} act={onAction} pending={pending} />;
  else if (stage === "team") content = <TeamStage act={onAction} pending={pending} />;
  else if (stage === "invite-confirm") content = <InviteConfirmStage act={onAction} pending={pending} />;
  else if (stage === "solo") content = <SoloStage flags={flags} act={onAction} pending={pending} />;
  else if (stage === "done") content = <DoneStage state={session.state} />;
  else if (stage === "error") content = <ErrorStage state={session.state} />;
  else if (stage === "timeout") content = <TimeoutStage />;
  else content = <UnknownStage stage={stage} reload={reload} pending={Boolean(pending)} />;

  return (
    <div
      className="app-shell"
      data-fixture-profile={profile}
      data-stage={stage}
      data-outcome={session.state?.outcome || ""}
    >
      <header className="app-header">
        <a className="brand" href="/" aria-label="Nimbus home">
          <BrandMark />
          <span>Nimbus</span>
        </a>
        <div className="app-header__edition">
          <span>Field guide</span>
          <span aria-hidden="true">/</span>
          <span>Workspace setup</span>
        </div>
        <button
          type="button"
          className="text-action"
          aria-label="Sign out of Nimbus"
          onClick={onLogout}
          disabled={pending === "logout"}
        >
          Sign out
        </button>
      </header>

      <div className="app-layout">
        <aside className="guide-rail">
          <RouteMap stage={stage} />
          <RouteSketch />
          <FieldNote stage={stage} />
        </aside>
        <main className="stage-canvas" aria-busy={Boolean(pending)}>
          {content}
        </main>
      </div>

      <footer className="app-footer">
        <span>Nimbus field guide · 2026</span>
        <span>Deterministic fixture / State persisted locally</span>
        <span>{STAGE_TITLES[stage] || "Unknown route"}</span>
      </footer>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [authError, setAuthError] = useState("");
  const [pending, setPending] = useState("");
  const [announcement, setAnnouncement] = useState("");

  async function loadSession(signal) {
    setLoading(true);
    setLoadError("");
    try {
      const next = await apiRequest("/api/session", { signal });
      setSession(next);
      updateLocation(statePath(next.state, next.authenticated));
    } catch (error) {
      if (error.name !== "AbortError") setLoadError(readableError(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadSession(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const stage = session?.authenticated ? session.state?.stage || "use-case" : "login";
    const title = stage === "login" ? "Sign in" : STAGE_TITLES[stage] || "Workspace setup";
    document.title = `Nimbus — ${title}`;
    document.documentElement.dataset.fixtureProfile = profileName(session?.profile);
    return () => {
      delete document.documentElement.dataset.fixtureProfile;
    };
  }, [session]);

  const currentProfile = useMemo(() => profileName(session?.profile), [session?.profile]);

  async function login(credentials) {
    setPending("login");
    setAuthError("");
    try {
      const next = await apiRequest("/api/login", { method: "POST", body: credentials });
      setSession(next);
      updateLocation(next.navigateTo || statePath(next.state, next.authenticated));
      setAnnouncement("Signed in. Workspace setup is ready.");
    } catch (error) {
      setAuthError(readableError(error));
    } finally {
      setPending("");
    }
  }

  async function action(actionName) {
    if (!session || pending) return;
    setPending(actionName);
    try {
      const response = await apiRequest("/api/action", {
        method: "POST",
        body: { action: actionName },
      });
      const next = mergeActionResponse(session, response);
      setSession(next);
      updateLocation(response.navigateTo || statePath(next.state, next.authenticated));
      const eventText =
        typeof response.event === "string"
          ? response.event
          : response.event?.label || response.event?.type || "Route updated";
      setAnnouncement(`${eventText}. ${STAGE_TITLES[next.state?.stage] || "Next stage"}.`);
    } catch (error) {
      const serverState = error.payload?.state;
      if (serverState) {
        const next = { ...session, state: serverState };
        setSession(next);
        updateLocation(statePath(serverState, true));
      } else {
        setAnnouncement(`Action failed. ${readableError(error)}`);
      }
    } finally {
      setPending("");
    }
  }

  async function logout() {
    if (pending) return;
    setPending("logout");
    try {
      const response = await apiRequest("/api/logout", { method: "POST" });
      const next = response.authenticated === false
        ? response
        : { authenticated: false, profile: currentProfile, state: { stage: "use-case" } };
      setSession(next);
      updateLocation(response.navigateTo || "/login");
      setAnnouncement("Signed out of Nimbus.");
    } catch (error) {
      setAnnouncement(`Sign out failed. ${readableError(error)}`);
    } finally {
      setPending("");
    }
  }

  if (loading) return <LoadingScreen />;
  if (loadError) return <FatalScreen message={loadError} retry={() => loadSession()} />;
  if (!session?.authenticated) {
    return <LoginScreen onLogin={login} pending={pending === "login"} error={authError} />;
  }

  return (
    <>
      <WorkspaceShell
        session={session}
        pending={pending}
        onAction={action}
        onLogout={logout}
        reload={() => loadSession()}
      />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </>
  );
}
