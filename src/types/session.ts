export type SessionStatus =
  | "active"
  | "waiting_for_input"
  | "running"
  | "completed"
  | "error";

export type Platform = "android" | "ios";

export interface Session {
  sessionId: string;
  agent: string;
  name: string;
  status: SessionStatus;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
}

export interface Device {
  deviceId: string;
  fcmToken: string;
  userId: string;
  platform: Platform;
  registeredAt: FirebaseFirestore.Timestamp;
}
