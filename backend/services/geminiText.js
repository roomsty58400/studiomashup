// ─── Génération de texte via l'API Gemini (gratuite, avec repli automatique
// sur d'autres modèles si le modèle prioritaire n'a plus de quota) ─────────
// Extrait de routes/prompt.js (31/07) pour être réutilisé par d'autres
// fonctionnalités IA du site (ex : assistant de génération de playlist
// DJPLAYLIST) sans dupliquer la logique de repli entre modèles, déjà
// éprouvée/déboguée là-bas (comptes gratuits : la plupart des modèles listés
// par l'API ont quota=0, cf. commentaire historique ci-dessous).

async function listGeminiModels(apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    { signal: AbortSignal.timeout(8000) }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.models || [])
    .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
    .map(m => m.name.replace("models/", ""))
    .sort((a, b) => {
      const score = s => s.includes("flash") ? 0 : s.includes("pro") ? 1 : 2;
      return score(a) - score(b);
    });
}

// Modèle qui a fonctionné la dernière fois (en mémoire process) : sur un
// compte gratuit, la plupart des modèles listés par l'API ont quota=0 et
// échouent systématiquement (cf. logs "Quota exceeded ... limit: 0") — sans
// ce cache, CHAQUE requête réessayait tous ces modèles avant de retomber sur
// le seul qui marche, gaspillant du temps (et plusieurs appels réseau) à
// chaque appel.
let cachedWorkingModel = null;

const PRIORITY_MODELS = ["gemini-flash-lite-latest", "gemini-2.0-flash-lite", "gemini-1.5-flash-latest"];

async function tryModel(model, apiKey, userPrompt, generationConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.75, ...generationConfig },
      }),
      signal: AbortSignal.timeout(20000),
    });

    const data = await response.json();
    if (data.error) return { error: `${model}: ${data.error.message}` };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) return { error: `${model}: réponse vide` };

    return { text: text.trim() };
  } catch (err) {
    return { error: `${model}: ${err.message}` };
  }
}

// generationConfig optionnel (ex: { responseMimeType: "application/json" }
// pour forcer une sortie JSON stricte sur les modèles qui le supportent).
export async function generateText(apiKey, userPrompt, generationConfig) {
  let lastError = "";
  const tried = new Set();

  const priorityOrder = [cachedWorkingModel, ...PRIORITY_MODELS].filter(Boolean);
  for (const model of priorityOrder) {
    if (tried.has(model)) continue;
    tried.add(model);
    const result = await tryModel(model, apiKey, userPrompt, generationConfig);
    if (result.text) {
      console.log(`[Gemini] succès avec ${model}`);
      cachedWorkingModel = model;
      return result.text;
    }
    lastError = result.error;
    console.warn(`[Gemini] ${lastError}`);
  }

  const models = await listGeminiModels(apiKey);
  console.log("[Gemini] Repli sur la liste complète:", models.slice(0, 5));
  if (models.length === 0) throw new Error("Aucun modèle Gemini disponible sur ce compte");

  for (const model of models) {
    if (tried.has(model)) continue;
    tried.add(model);
    const result = await tryModel(model, apiKey, userPrompt, generationConfig);
    if (result.text) {
      console.log(`[Gemini] succès avec ${model}`);
      cachedWorkingModel = model;
      return result.text;
    }
    lastError = result.error;
    console.warn(`[Gemini] ${lastError}`);
  }

  throw new Error(`Tous les modèles ont échoué. Dernier : ${lastError}`);
}
