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

function buildMessage(token: string, payload: NotifyPayload, title: string): admin.messaging.Message {
  return {
    token,
    notification: {
      title,
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
  members: { userId: string; customName: string | null }[],
  payload: NotifyPayload
): Promise<number> {
  if (members.length === 0) return 0;

  const db = getFirestore();
  const messaging = getMessaging();

  // Fetch all device subcollections for every member in parallel
  const deviceSnapshots = await Promise.all(
    members.map(({ userId }) =>
      db.collection("users").doc(userId).collection("devices").get()
    )
  );

  const allDevices = deviceSnapshots.flatMap((snap, i) =>
    snap.docs.map((doc) => ({ userId: members[i].userId, customName: members[i].customName, doc }))
  );

  if (allDevices.length === 0) return 0;

  const results = await Promise.allSettled(
    allDevices.map(async ({ userId, customName, doc }) => {
      const { fcmToken } = doc.data() as { fcmToken: string };
      const title = customName ?? payload.title;
      try {
        await messaging.send(buildMessage(fcmToken, payload, title));
        console.log(`[notify] sent session=${sessionId} device=${doc.id} user=${userId}`);
        return true;
      } catch (err: unknown) {
        const fcmErr = err as admin.FirebaseError;
        if (INVALID_TOKEN_CODES.has(fcmErr.code ?? "")) {
          console.warn(`[notify] stale token device=${doc.id} user=${userId} — removing`);
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
