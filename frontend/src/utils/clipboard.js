export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    console.error("Erreur copie", err);
    return { ok: false, error: err };
  }
}
