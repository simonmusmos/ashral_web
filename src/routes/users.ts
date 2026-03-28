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

// POST /users/:userId/devices
router.post("/:userId/devices", async (req: Request, res: Response) => {
  const { userId } = req.params;
  const parse = AddDeviceSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message, code: "VALIDATION_ERROR" });
    return;
  }

  const { fcmToken } = parse.data;
  // Use the token itself as the doc ID so re-registering the same token is idempotent
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
