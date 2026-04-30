import { Router, Request, Response } from "express";
import * as admin from "firebase-admin";
import { z } from "zod";
import { getFirestore } from "../services/firebase";

const router = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const AddDeviceSchema = z.object({
  fcmToken: z.string().min(1),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function devicesRef(userId: string) {
  return getFirestore().collection("users").doc(userId).collection("devices");
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /users/:userId/sessions
// Returns all userSessions pivot rows for this user, joined with session data.
router.get("/:userId/sessions", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const db = getFirestore();

  const pivotSnap = await db
    .collection("userSessions")
    .where("userId", "==", userId)
    .orderBy("joinedAt", "desc")
    .get();

  if (pivotSnap.empty) {
    res.status(200).json({ sessions: [] });
    return;
  }

  // Fetch all session docs in parallel
  const sessionIds = pivotSnap.docs.map((d) => d.data().sessionId as string);
  const sessionSnaps = await Promise.all(
    sessionIds.map((id) => db.collection("sessions").doc(id).get())
  );

  const sessions = pivotSnap.docs
    .map((pivotDoc, i) => {
      const pivot = pivotDoc.data();
      const sessionSnap = sessionSnaps[i];
      if (!sessionSnap.exists) return null; // session deleted
      const session = sessionSnap.data()!;
      return {
        sessionId: pivot.sessionId,
        customName: pivot.customName,
        joinedAt: pivot.joinedAt,
        name: session.name,
        agent: session.agent,
        status: session.status,
      };
    })
    .filter(Boolean);

  res.status(200).json({ sessions });
});

// POST /users/:userId/devices
router.post("/:userId/devices", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const parse = AddDeviceSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const { fcmToken } = parse.data;
  const deviceId = Buffer.from(fcmToken).toString("base64url").slice(0, 128);
  const now = admin.firestore.Timestamp.now();

  await devicesRef(userId).doc(deviceId).set({ fcmToken, createdAt: now });

  console.log(`[device] upserted device=${deviceId} user=${userId}`);
  res.status(200).json({ ok: true });
});

// DELETE /users/:userId/devices/:fcmToken
router.delete("/:userId/devices/:fcmToken", async (req: Request, res: Response) => {
  const { userId, fcmToken } = req.params;
  const deviceId = Buffer.from(fcmToken).toString("base64url").slice(0, 128);

  await devicesRef(userId).doc(deviceId).delete();

  console.log(`[device] removed device=${deviceId} user=${userId}`);
  res.status(204).send();
});

export default router;
