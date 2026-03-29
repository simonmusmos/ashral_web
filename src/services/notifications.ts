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

function buildMessage(token: string, payload: NotifyPayload): admin.messaging.Message {
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
  sessionId: string,
  memberIds: string[],
  payload: NotifyPayload
): Promise<number> {
  if (memberIds.length === 0) return 0;

  const db = getFirestore();
  const messaging = getMessaging();

  // Collect all device docs across all members in parallel
  const deviceSnapshots = await Promise.all(
    memberIds.map((userId) =>
      db.collection("users").doc(userId).collection("devices").get()
    )
  );

  // Flatten into { userId, doc } pairs so we can log context on failure
  const allDevices = deviceSnapshots.flatMap((snap, i) =>
    snap.docs.map((doc) => ({ userId: memberIds[i], doc }))
  );

  if (allDevices.length === 0) return 0;

  const results = await Promise.allSettled(
    allDevices.map(async ({ userId, doc }) => {
      const { fcmToken } = doc.data() as { fcmToken: string };
      try {
        await messaging.send(buildMessage(fcmToken, payload));
        console.log(`[notify] sent session=${sessionId} device=${doc.id} user=${userId}`);
        return true;
      } catch (err: unknown) {
        const fcmErr = err as admin.FirebaseError;
        if (INVALID_TOKEN_CODES.has(fcmErr.code ?? "")) {
          console.warn(
            `[notify] stale token device=${doc.id} user=${userId} — removing`
          );
          await doc.ref.delete();
        } else {
          console.error(
            `[notify] FCM error device=${doc.id} user=${userId}:`,
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
