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

function sessionRef(sessionId: string) {
  return getFirestore().collection("sessions").doc(sessionId);
}

function membersRef(sessionId: string) {
  return sessionRef(sessionId).collection("members");
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

  // Upsert member doc — allows the same user to rejoin and update their customName
  await membersRef(id).doc(userId).set({
    userId,
    customName: customName ?? null,
    joinedAt: now,
  }, { merge: true });

  console.log(`[session] joined session=${id} userId=${userId}`);
  res.status(200).json({ ok: true });
});

// GET /sessions/:id/members/:userId
router.get("/:id/members/:userId", async (req: Request, res: Response) => {
  const { id, userId } = req.params;

  const sessionData = await getSessionOrFail(id, res);
  if (!sessionData) return;

  const memberSnap = await membersRef(id).doc(userId).get();
  if (!memberSnap.exists) {
    res.status(404).json({ error: "Member not found", code: "NOT_FOUND" });
    return;
  }

  const data = memberSnap.data()!;
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

  const memberSnap = await membersRef(id).doc(userId).get();
  if (!memberSnap.exists) {
    res.status(404).json({ error: "Member not found", code: "NOT_FOUND" });
    return;
  }

  await membersRef(id).doc(userId).update({ customName: parse.data.customName });

  console.log(`[session] member customName updated session=${id} userId=${userId}`);
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

  const membersSnap = await membersRef(id).get();
  if (membersSnap.empty) {
    console.log(`[notify] session=${id} has no members — skipping`);
    res.status(200).json({ skipped: true, reason: "no members" });
    return;
  }

  const memberIds = membersSnap.docs.map((doc) => doc.id);
  const sent = await sendNotifications(id, memberIds, parse.data);
  console.log(`[notify] session=${id} members=${memberIds.length} sent=${sent}`);
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

  // Delete members subcollection then the session doc
  const membersSnap = await membersRef(id).get();
  const batch = getFirestore().batch();
  membersSnap.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(sessionRef(id));
  await batch.commit();

  console.log(`[session] deleted session=${id} (${membersSnap.size} member(s) removed)`);
  res.status(204).send();
});

export default router;
