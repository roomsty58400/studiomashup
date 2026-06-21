import express from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// ── Passport Google Strategy ──────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || "http://localhost:3001/api/auth/google/callback",
  },
  (_accessToken, _refreshToken, profile, done) => {
    // On stocke seulement les infos utiles dans la session
    const user = {
      id:     profile.id,
      name:   profile.displayName,
      email:  profile.emails?.[0]?.value || "",
      avatar: profile.photos?.[0]?.value || "",
    };
    return done(null, user);
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Routes ───────────────────────────────────────────────────────
// Lancer le flux OAuth
router.get("/google/login", passport.authenticate("google", {
  scope: ["profile", "email"],
}));

// Callback Google
router.get("/google/callback",
  passport.authenticate("google", { failureRedirect: "http://localhost:5173?auth=error" }),
  (req, res) => {
    // Succès → retour vers le frontend avec les infos en query string
    const u = req.user;
    const params = new URLSearchParams({
      auth:   "ok",
      name:   u.name,
      email:  u.email,
      avatar: u.avatar,
    });
    res.redirect(`http://localhost:5173?${params.toString()}`);
  }
);

// Infos utilisateur courant (session)
router.get("/me", (req, res) => {
  if (req.isAuthenticated()) return res.json({ user: req.user });
  res.json({ user: null });
});

// Déconnexion
router.get("/logout", (req, res) => {
  req.logout(() => {
    res.json({ ok: true });
  });
});

export { passport };
export default router;
