/**
 * Sons des alertes, générés avec la Web Audio API (aucun fichier à télécharger).
 *
 * Contraintes iPhone :
 *  - le son doit être « débloqué » par un appui de l'utilisateur : on appelle
 *    unlock() sur le bouton « Démarrer » ;
 *  - le bouton SILENCIEUX de l'iPhone coupe ces sons (on le signale dans l'appli) ;
 *  - au retour au premier plan, iOS suspend parfois le son : resume().
 */
export type SoundKind = 'intake' | 'drink';

/** Notes (Hz) et durée de chaque son : prise = 3 notes montantes, deux fois ; boisson = 2 notes douces. */
const PATTERNS: Record<SoundKind, { notes: number[]; noteS: number; gapS: number; repeat: number; volume: number; wave: OscillatorType }> = {
  intake: { notes: [660, 880, 1175], noteS: 0.16, gapS: 0.04, repeat: 2, volume: 0.5, wave: 'triangle' },
  drink: { notes: [523, 659], noteS: 0.2, gapS: 0.08, repeat: 1, volume: 0.3, wave: 'sine' },
};

export class AlertSound {
  private ctx: AudioContext | null = null;

  constructor(public enabled: boolean) {}

  /** À appeler pendant un appui (sinon iOS refuse de jouer le son). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
      }
      void this.ctx.resume();
      // Son silencieux très court : finit de débloquer l'audio sur iOS.
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.01);
    } catch {
      /* son indisponible : les bannières suffisent */
    }
  }

  resume(): void {
    void this.ctx?.resume().catch(() => {});
  }

  play(kind: SoundKind, force = false): void {
    if ((!this.enabled && !force) || !this.ctx) return;
    try {
      const p = PATTERNS[kind];
      let t = this.ctx.currentTime + 0.05;
      for (let r = 0; r < p.repeat; r++) {
        for (const freq of p.notes) {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = p.wave;
          osc.frequency.value = freq;
          // Petite enveloppe pour éviter les « clics ».
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(p.volume, t + 0.02);
          gain.gain.linearRampToValueAtTime(0, t + p.noteS);
          osc.connect(gain).connect(this.ctx.destination);
          osc.start(t);
          osc.stop(t + p.noteS + 0.02);
          t += p.noteS + p.gapS;
        }
        t += 0.15;
      }
    } catch {
      /* ignoré */
    }
  }

  close(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
