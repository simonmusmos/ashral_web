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
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sessionRef(sessionId: string) {
  return getFirestore().collection("sessions").doc(sessionId);
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

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /sessions
router.post("/", async (req: Request, res: Response) => {
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
    userId: null,
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

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  const { userId } = parse.data;
  const db = getFirestore();
  const now = admin.firestore.Timestamp.now();

  // Create users/{userId} doc if it doesn't exist
  const userRef = db.collection("users").doc(userId);
  await userRef.set({ createdAt: now }, { merge: true });

  // Link the user to the session
  await sessionRef(id).update({ userId });

  console.log(`[session] joined session=${id} userId=${userId}`);
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

  if (!data.userId) {
    console.log(`[notify] session=${id} has no linked user — skipping`);
    res.status(200).json({ skipped: true, reason: "no user linked" });
    return;
  }

  const sent = await sendNotifications(data.userId as string, parse.data);
  console.log(`[notify] session=${id} userId=${data.userId} sent=${sent}`);
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

  await sessionRef(id).delete();

  console.log(`[session] deleted session=${id}`);
  res.status(204).send();
});

export default router;
