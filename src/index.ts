import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { getFirebaseApp } from "./services/firebase";
import sessionsRouter from "./routes/sessions";
import usersRouter from "./routes/users";

// Eagerly initialize Firebase so we fail fast on bad config
getFirebaseApp();

const app = express();

// Output chunks can be up to 200k chars (see MAX_CHUNK_CHARS in routes/sessions)
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use("/sessions", sessionsRouter);
app.use("/users", usersRouter);

// 404 fallthrough
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
});

// Global error handler — never leak internals
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error] unhandled exception:", err);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
});

// Export for Vercel serverless runtime
export default app;

// Start the server when run directly (local dev)
if (require.main === module) {
  const PORT = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(PORT, () => {
    console.log(`[server] Ashral backend listening on port ${PORT}`);
  });
}
