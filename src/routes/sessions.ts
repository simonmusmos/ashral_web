import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import * as admin from "firebase-admin";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { getFirestore } from "../services/firebase";
import { sendNotifications } from "../services/notifications";
import { Device, SessionStatus } from "../types/session";

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
  fcmToken: z.string().min(1),
  platform: z.enum(["android", "ios"]),
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

// ─── CLI-facing routes ────────────────────────────────────────────────────────

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
    updatedAt: now,
    expiresAt,
  });

  console.log(`[session] created session=${sessionId} agent=${agent} name="${name}"`);
  res.status(201).json({ sessionId });
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

  await sessionRef(id).update({
    status: parse.data.status,
    updatedAt: admin.firestore.Timestamp.now(),
  });

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

  const devicesSnap = await sessionRef(id).collection("devices").get();
  const devices: Device[] = devicesSnap.docs.map((doc) => ({
    deviceId: doc.id,
    ...(doc.data() as Omit<Device, "deviceId">),
  }));

  if (devices.length === 0) {
    console.log(`[notify] no devices registered for session=${id}`);
    res.status(200).json({ sent: 0 });
    return;
  }

  const sent = await sendNotifications(id, devices, parse.data);
  console.log(`[notify] session=${id} sent=${sent}/${devices.length}`);
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

  // Delete all devices in the subcollection first
  const devicesSnap = await sessionRef(id).collection("devices").get();
  const batch = getFirestore().batch();
  devicesSnap.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(sessionRef(id));
  await batch.commit();

  console.log(`[session] deleted session=${id}`);
  res.status(204).send();
});

// ─── App-facing routes ────────────────────────────────────────────────────────

// POST /sessions/:id/join
router.post("/:id/join", requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  const parse = JoinSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const data = await getSessionOrFail(id, res);
  if (!data) return;

  const { fcmToken, platform } = parse.data;
  const deviceId = uuidv4();
  const now = admin.firestore.Timestamp.now();

  await sessionRef(id).collection("devices").doc(deviceId).set({
    fcmToken,
    userId: req.uid!,
    platform,
    registeredAt: now,
  });

  console.log(
    `[device] registered deviceId=${deviceId} userId=${req.uid} platform=${platform} session=${id}`
  );
  res.status(201).json({
    deviceId,
    session: {
      sessionId: id,
      name: data.name,
      agent: data.agent,
      status: data.status,
    },
  });
});

// DELETE /sessions/:id/leave
router.delete("/:id/leave", requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const snap = await sessionRef(id).get();
  if (!snap.exists) {
    res.status(404).json({ error: "Session not found", code: "NOT_FOUND" });
    return;
  }

  // Remove all devices belonging to this user for this session
  const devicesSnap = await sessionRef(id)
    .collection("devices")
    .where("userId", "==", req.uid!)
    .get();

  if (devicesSnap.empty) {
    res.status(404).json({ error: "No registered devices found for this user in this session", code: "NOT_FOUND" });
    return;
  }

  const batch = getFirestore().batch();
  devicesSnap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  console.log(
    `[device] unregistered userId=${req.uid} from session=${id} (${devicesSnap.size} device(s))`
  );
  res.status(204).send();
});

export default router;
