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
  status: SessionStatus;
  createdAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
}

export interface UserSession {
  userId: string;
  sessionId: string;
  customName: string | null;
  joinedAt: FirebaseFirestore.Timestamp;
}

export interface Device {
  deviceId: string;
  fcmToken: string;
  createdAt: FirebaseFirestore.Timestamp;
}
