/* ============================================================
   firebase.js — single initialisation point
   Auth + Firestore only. No analytics.

   HOW TO SET UP:
   1. Go to https://console.firebase.google.com
   2. Open your project → Project Settings → Your Apps → Web
   3. Copy the firebaseConfig object and paste it below
   4. Firebase Console → Authentication → Sign-in method → Email/Password → Enable
   5. Firebase Console → Firestore Database → Create database → Start in test mode
   ============================================================ */

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── PASTE YOUR CONFIG HERE ────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBW--Fh4txekYELMB28IULoKfznap1cpyI",
  authDomain: "dashboard-project-18a19.firebaseapp.com",
  projectId: "dashboard-project-18a19",
  storageBucket: "dashboard-project-18a19.firebasestorage.app",
  messagingSenderId: "152668472647",
  appId: "1:152668472647:web:8b74a3dc3befd64b593862",
};
// ─────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db   = getFirestore(app);

console.log('[firebase.js] Initialized. Project:', firebaseConfig.projectId);