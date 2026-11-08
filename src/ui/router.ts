/**
 * Routeur minimal basé sur le « # » de l'URL (ex. #/itineraire/abc).
 * Avantage : fonctionne sur GitHub Pages sans configuration serveur.
 *
 * Une vue est une fonction qui remplit `root` et peut retourner une fonction
 * de nettoyage (appelée quand on quitte l'écran : arrêter le GPS, détruire la carte…).
 */
export type Cleanup = () => void;
export type View = (root: HTMLElement, params: Record<string, string>) => void | Cleanup | Promise<void | Cleanup>;

interface CompiledRoute {
  regex: RegExp;
  keys: string[];
  view: View;
  tab: string;
}

export interface RouteDef {
  /** Ex. "/itineraire/:id" */
  path: string;
  view: View;
  /** Onglet de la barre du bas à mettre en surbrillance. */
  tab: string;
}

export function navigate(path: string): void {
  location.hash = '#' + path;
}

export function startRouter(
  root: HTMLElement,
  defs: RouteDef[],
  onTabChange: (tab: string) => void,
  onError: (err: unknown) => void,
): void {
  const routes: CompiledRoute[] = defs.map((d) => {
    const keys: string[] = [];
    const pattern = d.path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    return { regex: new RegExp(`^${pattern}$`), keys, view: d.view, tab: d.tab };
  });

  let cleanup: Cleanup | null = null;
  let renderToken = 0;

  async function render(): Promise<void> {
    const token = ++renderToken;
    const path = location.hash.replace(/^#/, '') || '/';
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(err);
      }
      cleanup = null;
    }
    root.replaceChildren();
    window.scrollTo(0, 0);

    let route: CompiledRoute | undefined;
    let match: RegExpMatchArray | null = null;
    for (const r of routes) {
      match = path.match(r.regex);
      if (match) {
        route = r;
        break;
      }
    }
    if (!route || !match) {
      navigate('/');
      return;
    }
    const params: Record<string, string> = {};
    const groups = match;
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(groups[i + 1])));
    onTabChange(route.tab);

    try {
      const result = await route.view(root, params);
      if (token !== renderToken) {
        // L'utilisateur a changé d'écran pendant le chargement.
        if (typeof result === 'function') result();
        return;
      }
      if (typeof result === 'function') cleanup = result;
    } catch (err) {
      onError(err);
    }
  }

  window.addEventListener('hashchange', () => void render());
  void render();
}
