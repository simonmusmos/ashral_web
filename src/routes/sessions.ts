import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import * as admin from "firebase-admin";
import { z } from "zod";
import { getFirestore } from "../services/firebase";
import { sendNotifications } from "../services/notifications";
import { SessionStatus } from "../types/session";

const router = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateSessionSchema = z.object({
  agent: z.string().min(1),
  name: z.string().min(1),
});

const UpdateStatusSchema = z.object({
  status: z.enum([
    "active",
    "waiting_for_input",
    "running",
    "completed",
    "error",
  ] as [SessionStatus, ...SessionStatus[]]),
});

const NotifySchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  priority: z.enum(["high", "normal"]).default("high"),
});

const JoinSchema = z.object({
  userId: z.string().min(1),
  customName: z.string().optional(),
});

const UpdateMemberSchema = z.object({
  customName: z.string().min(1),
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
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + 24 * 60 * 60 * 1000)
  );

  await sessionRef(sessionId).set({
    agent,
    name,
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

  await sessionRef(id).update({ status: parse.data.status });

  console.log(`[session] status updated session=${id} status=${parse.data.status}`);
  res.status(200).json({ ok: true });
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
  const sent = await sendNotifications(id, members, parse.data);
  console.log(`[notify] session=${id} members=${members.length} sent=${sent}`);
  res.status(200).json({ sent });
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

  const batch = getFirestore().batch();
  membersSnap.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(sessionRef(id));
  await batch.commit();

  console.log(`[session] deleted session=${id} (${membersSnap.size} pivot row(s) removed)`);
  res.status(204).send();
});

export default router;
