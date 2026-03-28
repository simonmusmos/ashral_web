export type SessionStatus =
  | "active"
  | "waiting_for_input"
  | "running"
  | "completed"
  | "error";

export interface Session {
  sessionId: string;
  agent: string;
  name: string;
  userId: string | null;
  status: SessionStatus;
  createdAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
}

export interface Device {
  deviceId: string;
  fcmToken: string;
  createdAt: FirebaseFirestore.Timestamp;
}
