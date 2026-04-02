const sessions = new Map();

function defaultLeadProfile() {
  return {
    name: null,
    company: null,
    role: null,
    phone: null,
    email: null,
    useCase: null,
    budget: null,
    timeline: null,
    teamSize: null,
    authority: null
  };
}

function defaultSession(sessionId) {
  return {
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    leadProfile: defaultLeadProfile(),
    transcript: [],
    qualification: {
      score: 0,
      status: "discovery",
      missingFields: ["name", "company", "useCase", "budget", "timeline"],
      bant: {
        budget: null,
        authority: null,
        need: null,
        timeline: null
      },
      scoreOutOf10: 0,
      labelKey: "cold",
      label: "Cold \u2744\uFE0F",
      nextQuestion: "What are you looking to solve right now?",
      summary: "Share the requirement and Lead Sathi will qualify the lead live."
    }
  };
}

export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, defaultSession(sessionId));
  }

  return sessions.get(sessionId);
}

export function updateSession(sessionId, updater) {
  const current = getSession(sessionId);
  const next = updater(current);
  next.updatedAt = new Date().toISOString();
  sessions.set(sessionId, next);
  return next;
}

export function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}
