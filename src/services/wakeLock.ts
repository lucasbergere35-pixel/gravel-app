/**
 * Maintien de l'écran allumé (Screen Wake Lock API).
 * - iPhone : Safari ≥ 16.4 ; dans une appli « écran d'accueil », fiable depuis iOS 18.4 environ.
 * - Le navigateur relâche le verrou quand l'appli passe en arrière-plan :
 *   on le redemande automatiquement au retour (handleVisible).
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor(private readonly onChange: (active: boolean) => void = () => {}) {}

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  get active(): boolean {
    return this.sentinel !== null;
  }

  get enabled(): boolean {
    return this.wanted;
  }

  /** Retourne true si l'écran restera allumé. */
  async enable(): Promise<boolean> {
    this.wanted = true;
    return this.acquire();
  }

  async disable(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    try {
      await s?.release();
    } catch {
      /* déjà relâché */
    }
    this.onChange(false);
  }

  async handleVisible(): Promise<void> {
    if (this.wanted && !this.sentinel) await this.acquire();
  }

  private async acquire(): Promise<boolean> {
    if (!ScreenWakeLock.supported || document.visibilityState !== 'visible') return false;
    if (this.sentinel) return true;
    try {
      const s = await navigator.wakeLock.request('screen');
      s.addEventListener('release', () => {
        if (this.sentinel === s) {
          this.sentinel = null;
          this.onChange(false);
        }
      });
      this.sentinel = s;
      this.onChange(true);
      return true;
    } catch {
      this.onChange(false);
      return false;
    }
  }
}
