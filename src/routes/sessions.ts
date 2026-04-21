import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import * as admin from "firebase-admin";
import { z } from "zod";
import { getFirestore } from "../services/firebase";
import { sendNotifications } from "../services/notifications";
import { extractNotificationBody } from "../services/openai";
import { SessionStatus } from "../types/session";

const router = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateSessionSchema = z.object({
  agent: z.string().min(1),
  name: z.string().min(1),
});

const PendingActionSchema = z.object({
  question: z.string().optional(),
  options: z.array(z.string()),
});

const UpdateStatusSchema = z.object({
  status: z.enum([
    "active",
    "waiting_for_input",
    "running",
    "completed",
    "error",
    "terminated",
  ] as [SessionStatus, ...SessionStatus[]]),
  pendingAction: PendingActionSchema.optional(),
});

const NotifySchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  priority: z.enum(["high", "normal"]).default("high"),
  rawText: z.string().max(1000).optional(),
});

const RespondSchema = z.object({
  userId: z.string().min(1),
  action: z.string().min(1),
});

const AgentSessionSchema = z.object({
  agentSessionId: z.string().min(1),
});

const JoinSchema = z.object({
  userId: z.string().min(1),
  customName: z.string().optional(),
});

const UpdateMemberSchema = z.object({
  customName: z.string().min(1),
});

const AppendOutputSchema = z.object({
  text: z.string().min(1).max(16000),
  stream: z.enum(["stdout", "stderr"]).default("stdout"),
});

const UpdateStatsSchema = z.object({
  calls: z.number().int().min(0).optional(),
  tokens: z.number().int().min(0).optional(),
  files: z.number().int().min(0).optional(),
  cost: z.number().min(0).optional(),
});

const CompleteSessionSchema = z.object({
  output: z.string().max(100_000).optional(),
});

const GetOutputQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userSessionId(userId: string, sessionId: string) {
  return `${userId}_${sessionId}`;
}

function sessionRef(sessionId: string) {
  return getFirestore().collection("sessions").doc(sessionId);
}

function userSessionRef(userId: string, sessionId: string) {
  return getFirestore()
    .collection("userSessions")
    .doc(userSessionId(userId, sessionId));
}

function outputRef(sessionId: string) {
  return sessionRef(sessionId).collection("output");
}

async function getSessionOrFail(
  sessionId: string,
  res: Response
): Promise<FirebaseFirestore.DocumentData | null> {
  const snap = await sessionRef(sessionId).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Session not found", code: "NOT_FOUND" });
    return null;
  }

  const data = snap.data()!;
  const now = admin.firestore.Timestamp.now();
  if (data.expiresAt && data.expiresAt < now) {
    res.status(404).json({ error: "Session has expired", code: "SESSION_EXPIRED" });
    return null;
  }

  return data;
}

// ─── Semver helpers ──────────────────────────────────────────────────────────

function parseSemver(v: string): [number, number, number] | null {
  const parts = v.trim().replace(/^v/, "").split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some(isNaN)) return null;
  return nums as [number, number, number];
}

// Returns true if `a` is strictly less than `b`
function semverLt(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /sessions
router.post("/", async (req: Request, res: Response) => {
  const clientVersion = req.headers["x-ashral-version"] as string | undefined;
  const minVersion = process.env.MIN_CLI_VERSION;

  if (clientVersion && minVersion) {
    const client = parseSemver(clientVersion);
    const min = parseSemver(minVersion);
    if (client && min && semverLt(client, min)) {
      res.status(426).json({
        error: `Client version ${clientVersion} is no longer supported. Please run: npm install -g ashral`,
      });
      return;
    }
  }

  const parse = CreateSessionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const { agent, name } = parse.data;
  const sessionId = uuidv4();
  const shortId = sessionId.replace(/-/g, '').slice(0, 8);
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + 24 * 60 * 60 * 1000)
  );

  await sessionRef(sessionId).set({
    agent,
    name,
    shortId,
    status: "active" as SessionStatus,
    createdAt: now,
    expiresAt,
  });

  console.log(`[session] created session=${sessionId} agent=${agent} name="${name}"`);
  res.status(201).json({ sessionId });
});

// POST /sessions/:id/join
router.post("/:id/join", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = JoinSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const sessionData = await getSessionOrFail(id, res);
  if (!sessionData) return;

  const { userId, customName } = parse.data;
  const db = getFirestore();
  const now = admin.firestore.Timestamp.now();

  // Create users/{userId} doc if it doesn't exist
  await db.collection("users").doc(userId).set({ createdAt: now }, { merge: true });

  // Upsert pivot row — idempotent, safe to call multiple times
  await userSessionRef(userId, id).set(
    { userId, sessionId: id, customName: customName ?? null, joinedAt: now },
    { merge: true }
  );

  console.log(`[session] joined session=${id} userId=${userId}`);
  res.status(200).json({
    ok: true,
    session: {
      sessionId: id,
      name: sessionData.name,
      agent: sessionData.agent,
      status: sessionData.status,
    },
  });
});

// GET /sessions/:id/members/:userId
router.get("/:id/members/:userId", async (req: Request, res: Response) => {
  const { id, userId } = req.params;

  const sessionData = await getSessionOrFail(id, res);
  if (!sessionData) return;

  const snap = await userSessionRef(userId, id).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Member not found", code: "NOT_FOUND" });
    return;
  }

  const data = snap.data()!;
  res.status(200).json({
    userId: data.userId,
    customName: data.customName,
    joinedAt: data.joinedAt,
  });
});

// PATCH /sessions/:id/members/:userId
router.patch("/:id/members/:userId", async (req: Request, res: Response) => {
  const { id, userId } = req.params;
  const parse = UpdateMemberSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const sessionData = await getSessionOrFail(id, res);
  if (!sessionData) return;

  const snap = await userSessionRef(userId, id).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Member not found", code: "NOT_FOUND" });
    return;
  }

  await userSessionRef(userId, id).update({ customName: parse.data.customName });

  console.log(`[session] customName updated session=${id} userId=${userId}`);
  res.status(200).json({ ok: true });
});

// PATCH /sessions/:id/status
router.patch("/:id/status", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = UpdateStatusSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  const { status, pendingAction } = parse.data;
  const update: Record<string, unknown> = { status };

  if (pendingAction) {
    update.pendingAction = pendingAction;
  } else if (status === "running") {
    // Clear pending state when agent resumes
    update.pendingAction = admin.firestore.FieldValue.delete();
    update.pendingResponse = admin.firestore.FieldValue.delete();
  }

  await sessionRef(id).update(update);

  console.log(`[session] status updated session=${id} status=${status} pendingAction=${JSON.stringify(pendingAction ?? null)}`);
  res.status(200).json({ ok: true });
});

// POST /sessions/:id/output
router.post("/:id/output", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = AppendOutputSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  const chunkId = uuidv4();
  const createdAt = admin.firestore.Timestamp.now();
  const { text, stream } = parse.data;

  const batch = getFirestore().batch();
  batch.set(outputRef(id).doc(chunkId), {
    text,
    stream,
    createdAt,
  });
  batch.update(sessionRef(id), {
    lastOutputAt: createdAt,
    outputChunkCount: admin.firestore.FieldValue.increment(1),
  });
  await batch.commit();

  console.log(
    `[output] appended session=${id} chunk=${chunkId} stream=${stream} chars=${text.length}`
  );
  res.status(201).json({ ok: true, chunkId, createdAt });
});

// GET /sessions/:id/output
router.get("/:id/output", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = GetOutputQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  const chunksSnap = await outputRef(id)
    .orderBy("createdAt", "asc")
    .limit(parse.data.limit)
    .get();

  const chunks = chunksSnap.docs.map((doc) => {
    const chunk = doc.data();
    return {
      chunkId: doc.id,
      text: chunk.text,
      stream: chunk.stream,
      createdAt: chunk.createdAt,
    };
  });

  res.status(200).json({ chunks });
});

// POST /sessions/:id/notify
router.post("/:id/notify", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = NotifySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  const membersSnap = await getFirestore()
    .collection("userSessions")
    .where("sessionId", "==", id)
    .get();

  if (membersSnap.empty) {
    console.log(`[notify] session=${id} has no members — skipping`);
    res.status(200).json({ skipped: true, reason: "no members" });
    return;
  }

  const members = membersSnap.docs.map((doc) => ({
    userId: doc.data().userId as string,
    customName: doc.data().customName as string | null,
  }));

  const { rawText, ...basePayload } = parse.data;
  let notifyBody = basePayload.body;
  if (rawText) {
    const extracted = await extractNotificationBody(rawText);
    if (extracted) notifyBody = extracted;
  }

  const sent = await sendNotifications(id, members, { ...basePayload, body: notifyBody });
  console.log(`[notify] session=${id} members=${members.length} sent=${sent}`);
  res.status(200).json({ sent });
});

// POST /sessions/:id/reactivate — resume command re-opens a terminated session
router.post("/:id/reactivate", async (req: Request, res: Response) => {
  const { id } = req.params;
  const snap = await sessionRef(id).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Session not found", code: "NOT_FOUND" });
    return;
  }

  const expiresAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + 24 * 60 * 60 * 1000)
  );

  await sessionRef(id).update({
    status: "active" as SessionStatus,
    expiresAt,
    pendingAction: admin.firestore.FieldValue.delete(),
    pendingResponse: admin.firestore.FieldValue.delete(),
  });

  console.log(`[session] reactivated session=${id}`);
  res.status(200).json({ ok: true });
});

// PATCH /sessions/:id/complete
router.patch("/:id/complete", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = CompleteSessionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const snap = await sessionRef(id).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Session not found", code: "NOT_FOUND" });
    return;
  }

  const update: Record<string, unknown> = {
    status: "completed" as SessionStatus,
    completedAt: admin.firestore.Timestamp.now(),
  };
  if (parse.data.output) {
    update.finalOutput = parse.data.output;
  }

  await sessionRef(id).update(update);
  console.log(`[session] completed session=${id} outputChars=${parse.data.output?.length ?? 0}`);
  res.status(200).json({ ok: true });
});

// PATCH /sessions/:id/stats — CLI increments usage counters
router.patch("/:id/stats", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = UpdateStatsSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }
  const snap = await sessionRef(id).get();
  if (!snap.exists) { res.status(404).json({ error: "Session not found" }); return; }

  const updates: Record<string, admin.firestore.FieldValue> = {};
  if (parse.data.calls)  updates["stats.calls"]  = admin.firestore.FieldValue.increment(parse.data.calls);
  if (parse.data.tokens) updates["stats.tokens"] = admin.firestore.FieldValue.increment(parse.data.tokens);
  if (parse.data.files)  updates["stats.files"]  = admin.firestore.FieldValue.increment(parse.data.files);
  if (parse.data.cost)   updates["stats.cost"]   = admin.firestore.FieldValue.increment(parse.data.cost);
  if (Object.keys(updates).length > 0) await sessionRef(id).update(updates);

  res.status(200).json({ ok: true });
});

// GET /sessions/short/:shortId — resolve an 8-char short ID to full session
router.get("/short/:shortId", async (req: Request, res: Response) => {
  const { shortId } = req.params;
  const snap = await getFirestore()
    .collection("sessions")
    .where("shortId", "==", shortId)
    .limit(1)
    .get();

  if (snap.empty) {
    res.status(404).json({ error: "Session not found", code: "NOT_FOUND" });
    return;
  }

  const doc = snap.docs[0];
  res.status(200).json({ sessionId: doc.id });
});

// GET /sessions/:id
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const data = await getSessionOrFail(id, res);
  if (!data) return;

  res.status(200).json({
    sessionId: id,
    name: data.name,
    agent: data.agent,
    status: data.status,
    createdAt: data.createdAt,
    pendingAction: data.pendingAction ?? null,
    stats: data.stats ?? null,
    agentSessionId: data.agentSessionId ?? null,
    shortId: data.shortId ?? null,
  });
});

// PATCH /sessions/:id/agent-session
router.patch("/:id/agent-session", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = AgentSessionSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  await sessionRef(id).update({ agentSessionId: parse.data.agentSessionId });
  console.log(`[session] agentSessionId saved session=${id}`);
  res.status(200).json({ ok: true });
});

// POST /sessions/:id/respond — mobile app submits a choice
router.post("/:id/respond", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = RespondSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  const now = admin.firestore.Timestamp.now();
  await sessionRef(id).update({
    pendingResponse: { action: parse.data.action, respondedAt: now },
    pendingAction: admin.firestore.FieldValue.delete(),
  });

  console.log(`[session] respond session=${id} userId=${parse.data.userId} action="${parse.data.action}"`);
  res.status(200).json({ ok: true });
});

// GET /sessions/:id/response — CLI polls for a pending response (one-time read)
router.get("/:id/response", async (req: Request, res: Response) => {
  const { id } = req.params;
  const snap = await sessionRef(id).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Session not found", code: "NOT_FOUND" });
    return;
  }

  const pending = snap.data()?.pendingResponse;
  if (!pending) {
    res.status(200).json({ response: null });
    return;
  }

  // Consume and clear the response atomically
  await sessionRef(id).update({
    pendingResponse: admin.firestore.FieldValue.delete(),
    pendingAction: admin.firestore.FieldValue.delete(),
  });

  console.log(`[session] response consumed session=${id} action="${pending.action}"`);
  res.status(200).json({ response: pending.action as string });
});

// DELETE /sessions/:id
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const snap = await sessionRef(id).get();

  if (!snap.exists) {
    res.status(404).json({ error: "Session not found", code: "NOT_FOUND" });
    return;
  }

  // Delete all pivot rows for this session, then the session doc
  const membersSnap = await getFirestore()
    .collection("userSessions")
    .where("sessionId", "==", id)
    .get();
  const outputSnap = await outputRef(id).get();

  const batch = getFirestore().batch();
  membersSnap.docs.forEach((doc) => batch.delete(doc.ref));
  outputSnap.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(sessionRef(id));
  await batch.commit();

  console.log(
    `[session] deleted session=${id} (${membersSnap.size} pivot row(s), ${outputSnap.size} output chunk(s) removed)`
  );
  res.status(204).send();
});

export default router;
