/** Lecture de fichiers choisis par l'utilisateur, et export (partage iOS ou téléchargement). */

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function readTextFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`« ${file.name} » est trop volumineux (max 25 Mo).`);
  }
  return file.text();
}

/** Nom de fichier sûr à partir d'un titre. */
export function safeFileName(name: string, extension: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || 'export'}.${extension}`;
}

/**
 * Sur iPhone : ouvre le menu de partage (« Enregistrer dans Fichiers », AirDrop, mail…).
 * Ailleurs ou si non supporté : téléchargement classique.
 * Retourne false si l'utilisateur a annulé.
 */
export async function shareOrDownload(fileName: string, content: string, mimeType: string): Promise<boolean> {
  const file = new File([content], fileName, { type: mimeType });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      // Autre erreur : on se rabat sur le téléchargement.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
