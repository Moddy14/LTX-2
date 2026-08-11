export async function importWithSingleReload<T>(key: string, importer: () => Promise<T>): Promise<T> {
  const storageKey = `ltx-studio.lazy-reload.${key}`;
  try {
    const imported = await importer();
    window.sessionStorage.removeItem(storageKey);
    return imported;
  } catch (error) {
    if (window.sessionStorage.getItem(storageKey) !== "attempted") {
      window.sessionStorage.setItem(storageKey, "attempted");
      window.location.reload();
      return new Promise<never>(() => undefined);
    }
    window.sessionStorage.removeItem(storageKey);
    throw error;
  }
}
