export type SessionStatus =
  | "active"
  | "waiting_for_input"
  | "running"
  | "completed"
  | "error"
  | "terminated";

export interface Session {
  sessionId: string;
  agent: string;
  name: string;
  status: SessionStatus;
  createdAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
  lastOutputAt?: FirebaseFirestore.Timestamp;
  outputChunkCount?: number;
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

export interface TerminalOutputChunk {
  chunkId: string;
  text: string;
  stream: "stdout" | "stderr";
  createdAt: FirebaseFirestore.Timestamp;
}
