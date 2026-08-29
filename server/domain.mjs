export const TEST_ACCOUNT = Object.freeze({
  id: "usr_demo",
  email: "demo@example.com",
  password: "branchpoint",
  name: "Demo User",
});

export const SESSION_COOKIE = "nimbus_sid";
export const SESSION_ID = "nimbus-demo-session";

export const SUPPORTED_PROFILES = Object.freeze([
  "baseline",
  "dom-refactor",
  "copy-rename",
  "regression",
  "discovery",
  "demo-head",
  "removed-control",
  "timeout",
]);

const PROFILE_SET = new Set(SUPPORTED_PROFILES);

const PATHS = Object.freeze({
  login: "/login",
  useCase: "/onboarding/use-case",
  team: "/onboarding/team",
  inviteConfirm: "/onboarding/team/invitations",
  solo: "/onboarding/solo",
  teamInviteDone: "/done/team-invite",
  teamSkipDone: "/done/team-skip",
  soloStarterDone: "/done/solo-starter",
  soloBlankDone: "/done/solo-blank",
  deferredDone: "/done/setup-deferred",
  soloImportDone: "/done/solo-import",
  blankError: "/error",
  deferredError: "/error",
  processing: "/timeout",
});

export class DomainError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeProfile(value) {
  const profile = typeof value === "string" ? value.trim() : "";
  const selected = profile || "baseline";
  if (!PROFILE_SET.has(selected)) {
    throw new DomainError(
      500,
      "invalid_profile",
      `Unsupported QA profile: ${selected}`,
      { supported: [...SUPPORTED_PROFILES] },
    );
  }
  return selected;
}

export function featuresForProfile(value) {
  const profile = normalizeProfile(value);
  return {
    domVariant: profile === "dom-refactor" ? "refactor" : "baseline",
    starterLabel:
      profile === "copy-rename" ||
      profile === "regression" ||
      profile === "demo-head"
        ? "Use a starter"
        : "Starter template",
    importEnabled: profile === "discovery" || profile === "demo-head",
    blankRegression: profile === "regression" || profile === "demo-head",
    laterRegression: profile === "regression" || profile === "demo-head",
    removedControl: profile === "removed-control" ? "choose_starter" : null,
    timeoutAction: profile === "timeout" ? "choose_later" : null,
  };
}

export function initialJourney() {
  return {
    stage: "use-case",
    outcome: null,
    plan: null,
    selection: null,
    path: PATHS.useCase,
  };
}

export function createInitialState(value = "baseline") {
  const profile = normalizeProfile(value);
  return {
    schemaVersion: 1,
    profile,
    revision: 0,
    session: null,
    journey: initialJourney(),
    nextEventSeq: 1,
    events: [],
  };
}

export function publicUser() {
  return {
    id: TEST_ACCOUNT.id,
    email: TEST_ACCOUNT.email,
    name: TEST_ACCOUNT.name,
  };
}

export function publicJourney(root) {
  return { ...root.journey };
}

export function isAuthenticated(root, sessionId) {
  return Boolean(
    sessionId && root.session && root.session.id === sessionId,
  );
}

function appendEvent(root, event) {
  const persisted = {
    seq: root.nextEventSeq,
    profile: root.profile,
    ...event,
  };
  root.nextEventSeq += 1;
  root.events.push(persisted);
  return persisted;
}

function setJourney(root, next) {
  root.journey = {
    stage: next.stage,
    outcome: next.outcome ?? null,
    plan: next.plan ?? root.journey.plan ?? null,
    selection: next.selection ?? null,
    path: next.path,
  };
}

export function login(root, credentials) {
  const email = credentials?.email;
  const password = credentials?.password;
  if (email !== TEST_ACCOUNT.email || password !== TEST_ACCOUNT.password) {
    throw new DomainError(
      401,
      "invalid_credentials",
      "Email or password is incorrect.",
    );
  }

  const from = root.session ? root.journey.stage : null;
  root.session = { id: SESSION_ID, userId: TEST_ACCOUNT.id };
  root.journey = initialJourney();
  const event = appendEvent(root, {
    type: "login",
    action: null,
    from,
    to: root.journey.stage,
    outcome: null,
    path: root.journey.path,
  });

  return {
    event,
    sessionId: SESSION_ID,
    user: publicUser(),
    state: publicJourney(root),
  };
}

export function logout(root, sessionId) {
  if (!isAuthenticated(root, sessionId)) {
    root.session = null;
    return { event: null };
  }

  const from = root.journey.stage;
  root.session = null;
  const event = appendEvent(root, {
    type: "logout",
    action: null,
    from,
    to: null,
    outcome: root.journey.outcome,
    path: PATHS.login,
  });
  return { event };
}

function assertAuthenticated(root, sessionId) {
  if (!isAuthenticated(root, sessionId)) {
    throw new DomainError(401, "authentication_required", "Sign in first.");
  }
}

function transitionFor(root, action) {
  const { stage } = root.journey;
  const features = featuresForProfile(root.profile);

  if (stage === "use-case") {
    if (action === "choose_team") {
      return {
        stage: "team",
        plan: "team",
        selection: null,
        path: PATHS.team,
      };
    }
    if (action === "choose_solo") {
      return {
        stage: "solo",
        plan: "solo",
        selection: null,
        path: PATHS.solo,
      };
    }
    if (action === "choose_later") {
      if (features.timeoutAction === action) {
        return {
          stage: "timeout",
          plan: "later",
          selection: "later",
          outcome: "deferred-timeout",
          path: PATHS.processing,
        };
      }
      if (features.laterRegression) {
        return {
          stage: "error",
          plan: "later",
          selection: "later",
          outcome: "later-regression",
          path: PATHS.deferredError,
        };
      }
      return {
        stage: "done",
        plan: "later",
        selection: "later",
        outcome: "setup-deferred",
        path: PATHS.deferredDone,
      };
    }
  }

  if (stage === "team") {
    if (action === "invite_team") {
      return {
        stage: "invite-confirm",
        plan: "team",
        selection: "invite",
        path: PATHS.inviteConfirm,
      };
    }
    if (action === "skip_invites") {
      return {
        stage: "done",
        plan: "team",
        selection: "skip-invites",
        outcome: "team-skip",
        path: PATHS.teamSkipDone,
      };
    }
  }

  if (stage === "invite-confirm" && action === "confirm_invites") {
    return {
      stage: "done",
      plan: "team",
      selection: "invite",
      outcome: "team-invite",
      path: PATHS.teamInviteDone,
    };
  }

  if (stage === "solo") {
    if (action === "choose_starter") {
      if (features.removedControl === action) {
        throw new DomainError(
          409,
          "action_unavailable",
          "The starter control is unavailable in this profile.",
          { action, profile: root.profile },
        );
      }
      return {
        stage: "done",
        plan: "solo",
        selection: "starter",
        outcome: "solo-starter",
        path: PATHS.soloStarterDone,
      };
    }
    if (action === "choose_blank") {
      if (features.blankRegression) {
        return {
          stage: "error",
          plan: "solo",
          selection: "blank",
          outcome: "blank-regression",
          path: PATHS.blankError,
        };
      }
      return {
        stage: "done",
        plan: "solo",
        selection: "blank",
        outcome: "solo-blank",
        path: PATHS.soloBlankDone,
      };
    }
    if (action === "choose_import") {
      if (!features.importEnabled) {
        throw new DomainError(
          409,
          "action_unavailable",
          "CSV import is unavailable in this profile.",
          { action, profile: root.profile },
        );
      }
      return {
        stage: "done",
        plan: "solo",
        selection: "import",
        outcome: "solo-import",
        path: PATHS.soloImportDone,
      };
    }
  }

  throw new DomainError(
    409,
    "invalid_transition",
    `Action ${action} is not valid from stage ${stage}.`,
    { action, stage },
  );
}

export function applyAction(root, sessionId, input) {
  assertAuthenticated(root, sessionId);
  const action = input?.action;
  if (typeof action !== "string" || !/^[a-z][a-z0-9_]*$/.test(action)) {
    throw new DomainError(
      400,
      "invalid_action",
      "action must be a lowercase underscore identifier.",
    );
  }
  if (
    input?.payload !== undefined &&
    (input.payload === null ||
      typeof input.payload !== "object" ||
      Array.isArray(input.payload))
  ) {
    throw new DomainError(400, "invalid_payload", "payload must be an object.");
  }

  const from = root.journey.stage;
  const next = transitionFor(root, action);
  setJourney(root, next);
  const event = appendEvent(root, {
    type: "action",
    action,
    from,
    to: root.journey.stage,
    outcome: root.journey.outcome,
    path: root.journey.path,
  });
  return { event, state: publicJourney(root) };
}

export function sessionView(root, sessionId) {
  const authenticated = isAuthenticated(root, sessionId);
  return {
    authenticated,
    profile: root.profile,
    user: authenticated ? publicUser() : null,
    state: authenticated ? publicJourney(root) : null,
    features: featuresForProfile(root.profile),
  };
}

export function qaStateView(root) {
  return {
    profile: root.profile,
    revision: root.revision,
    authenticated: Boolean(root.session),
    user: root.session ? publicUser() : null,
    state: publicJourney(root),
    features: featuresForProfile(root.profile),
    eventCount: root.events.length,
  };
}

export const ROUTES = PATHS;
