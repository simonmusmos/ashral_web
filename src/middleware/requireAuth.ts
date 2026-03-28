import { Request, Response, NextFunction } from "express";
import { getAuth } from "../services/firebase";

// Attach the verified Firebase uid to the request so routes can use it
declare global {
  namespace Express {
    interface Request {
      uid?: string;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header", code: "UNAUTHORIZED" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token", code: "UNAUTHORIZED" });
  }
}
