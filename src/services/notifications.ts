import * as admin from "firebase-admin";
import { getFirestore, getMessaging } from "./firebase";

export interface NotifyPayload {
  title: string;
  body: string;
  priority: "high" | "normal";
}

// FCM error codes that indicate a token is permanently invalid
const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

function buildMessage(
  token: string,
  payload: NotifyPayload,
  // platform unknown at this level — send with both Android + APNs config
): admin.messaging.Message {
  return {
    token,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    android: {
      priority: payload.priority === "high" ? "high" : "normal",
      notification: { sound: "default" },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          ...(payload.priority === "high"
            ? { interruptionLevel: "time-sensitive" as const }
            : {}),
        },
      },
    },
  };
}

export async function sendNotifications(
  userId: string,
  payload: NotifyPayload
): Promise<number> {
  const db = getFirestore();
  const messaging = getMessaging();

  const devicesSnap = await db
    .collection("users")
    .doc(userId)
    .collection("devices")
    .get();

  if (devicesSnap.empty) return 0;

  const results = await Promise.allSettled(
    devicesSnap.docs.map(async (doc) => {
      const { fcmToken } = doc.data() as { fcmToken: string };
      const message = buildMessage(fcmToken, payload);
      try {
        await messaging.send(message);
        console.log(`[notify] sent to device=${doc.id} user=${userId}`);
        return true;
      } catch (err: unknown) {
        const fcmErr = err as admin.FirebaseError;
        if (INVALID_TOKEN_CODES.has(fcmErr.code ?? "")) {
          console.warn(
            `[notify] stale token for device=${doc.id} user=${userId} — removing`
          );
          await doc.ref.delete();
        } else {
          console.error(
            `[notify] FCM error device=${doc.id}:`,
            fcmErr.code,
            fcmErr.message
          );
        }
        return false;
      }
    })
  );

  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}
