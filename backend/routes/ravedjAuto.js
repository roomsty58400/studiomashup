import express from "express";
import { runRavedjAutomation } from "../services/ravedjAutomation.js";

const router = express.Router();

// ── Job d'automatisation RaveDJ (navigateur masqué) ───────────────────────
// Même convention que routes/mashup.js (jobs en mémoire + endpoint de
// statut) : POST démarre le job et répond IMMÉDIATEMENT avec un jobId (la
// séquence complète peut prendre plusieurs minutes, pas question de garder
// la requête HTTP ouverte tout ce temps) ; GET /:id/status est interrogé en
// polling par le frontend pour l'avancement.
const jobs = new Map();
const updateJob = (id, patch) => jobs.set(id, { ...(jobs.get(id) || {}), ...patch, updatedAt: Date.now() });

router.post("/", (req, res) => {
  const { urlA, urlB } = req.body || {};
  if (!urlA || !urlB) return res.status(400).json({ error: "urlA et urlB (liens YouTube) sont requis" });

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  updateJob(jobId, { status: "running", step: 0, label: "En file d'attente..." });
  res.json({ jobId });

  runRavedjAutomation({ urlA, urlB, onProgress: (patch) => updateJob(jobId, { status: "running", ...patch }) })
    .then((result) => updateJob(jobId, { status: "done", step: 7, label: "Terminé.", ...result }))
    .catch((e) => updateJob(jobId, { status: "error", error: e.message }));
});

router.get("/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job introuvable" });
  res.json(job);
});

export default router;
