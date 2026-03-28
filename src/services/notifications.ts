import * as admin from "firebase-admin";
import { getFirestore, getMessaging } from "./firebase";
import { Device, Platform } from "../types/session";

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
  platform: Platform
): admin.messaging.Message {
  const base: admin.messaging.Message = {
    token,
    notification: {
      title: payload.title,
      body: payload.body,
    },
  };

  if (platform === "android") {
    base.android = {
      priority: payload.priority === "high" ? "high" : "normal",
      notification: {
        sound: "default",
      },
    };
  } else {
    base.apns = {
      payload: {
        aps: {
          sound: "default",
          ...(payload.priority === "high"
            ? { interruptionLevel: "time-sensitive" as const }
            : {}),
        },
      },
    };
  }

  return base;
}

export async function sendNotifications(
  sessionId: string,
  devices: Device[],
  payload: NotifyPayload
): Promise<number> {
  if (devices.length === 0) return 0;

  const db = getFirestore();
  const messaging = getMessaging();

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const message = buildMessage(device.fcmToken, payload, device.platform);
      try {
        await messaging.send(message);
        console.log(
          `[notify] sent to device ${device.deviceId} (session=${sessionId})`
        );
        return { success: true, deviceId: device.deviceId };
      } catch (err: unknown) {
        const fcmErr = err as admin.FirebaseError;
        if (INVALID_TOKEN_CODES.has(fcmErr.code ?? "")) {
          console.warn(
            `[notify] invalid token for device ${device.deviceId} — removing from session ${sessionId}`
          );
          await db
            .collection("sessions")
            .doc(sessionId)
            .collection("devices")
            .doc(device.deviceId)
            .delete();
        } else {
          console.error(
            `[notify] FCM error for device ${device.deviceId}:`,
            fcmErr.code,
            fcmErr.message
          );
        }
        return { success: false, deviceId: device.deviceId };
      }
    })
  );

  return results.filter(
    (r) => r.status === "fulfilled" && r.value.success
  ).length;
}
