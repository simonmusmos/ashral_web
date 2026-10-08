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
  /** Highest output chunk seq assigned so far */
  outputSeq?: number;
  devServerPort?: number | null;
  previewUrl?: string | null;
  previewRequested?: boolean;
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
  /** Per-session, gap-free order. Missing on chunks written before seq existed. */
  seq?: number;
  text: string;
  stream: "stdout" | "stderr";
  /** Set when one message was split across chunks; clients merge the parts */
  messageId?: string;
  part?: number;
  parts?: number;
  createdAt: FirebaseFirestore.Timestamp;
}

/** A mobile → CLI message waiting to be picked up (sessions/{id}/inbox) */
export interface InboxResponse {
  type: "text" | "image";
  action: string;
  createdAt: FirebaseFirestore.Timestamp;
}
