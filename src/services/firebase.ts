import * as admin from "firebase-admin";
import * as fs from "fs";

let app: admin.app.App | null = null;

function initFirebase(): admin.app.App {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set");
  }

  let credential: admin.credential.Credential;

  // Detect whether it's a file path or an inline JSON string
  if (raw.trim().startsWith("{")) {
    const serviceAccount = JSON.parse(raw) as admin.ServiceAccount;
    credential = admin.credential.cert(serviceAccount);
  } else {
    if (!fs.existsSync(raw)) {
      throw new Error(`Service account file not found: ${raw}`);
    }
    const serviceAccount = JSON.parse(
      fs.readFileSync(raw, "utf-8")
    ) as admin.ServiceAccount;
    credential = admin.credential.cert(serviceAccount);
  }

  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  return admin.initializeApp({ credential, storageBucket });
}

export function getFirebaseApp(): admin.app.App {
  if (!app) {
    app = initFirebase();
  }
  return app;
}

export function getFirestore(): FirebaseFirestore.Firestore {
  return getFirebaseApp().firestore();
}

export function getMessaging(): admin.messaging.Messaging {
  return getFirebaseApp().messaging();
}

export function getAuth(): admin.auth.Auth {
  return getFirebaseApp().auth();
}

export function getStorageBucket(): ReturnType<admin.storage.Storage["bucket"]> {
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error("FIREBASE_STORAGE_BUCKET environment variable is not set");
  }
  return getFirebaseApp().storage().bucket();
}
