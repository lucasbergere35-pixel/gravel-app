/**
 * Écran « Profil » : caractéristiques du cycliste + sauvegarde de toutes les données.
 */
import { buildBackup, describeBackup, parseBackup, type Backup } from '../../core/backup';
import { LEVEL_LABELS, type Level } from '../../core/nutrition/recommendations';
import { dumpAll, getProfile, restoreAll, saveProfile, type Profile, type Sex } from '../../services/db';
import { readTextFile, shareOrDownload } from '../../services/files';
import { toast } from '../components/toast';
import { append, el, errorMessage } from '../dom';
import { describeHelp } from '../help';
import { icon, type IconName } from '../icons';
import type { View } from '../router';

interface NumField {
  key: 'weightKg' | 'heightCm' | 'age' | 'bikeKg' | 'avgSpeedKmh';
  label: string;
  short: string;
  unit: string;
  icon: IconName;
  min: number;
  max: number;
  step: number;
  help?: string;
}

const NUM_FIELDS: NumField[] = [
  { key: 'weightKg', label: 'Poids (kg)', short: 'Poids', unit: 'kg', icon: 'user', min: 30, max: 200, step: 0.5 },
  { key: 'heightCm', label: 'Taille (cm)', short: 'Taille', unit: 'cm', icon: 'move-horizontal', min: 120, max: 220, step: 1 },
  { key: 'age', label: 'Âge', short: 'Âge', unit: 'ans', icon: 'hourglass', min: 10, max: 100, step: 1 },
  { key: 'bikeKg', label: 'Poids du vélo équipé (kg)', short: 'Vélo équipé', unit: 'kg', icon: 'bike', min: 5, max: 40, step: 0.5, help: 'Vélo équipé : vélo + sacoches + bidons pleins.' },
  { key: 'avgSpeedKmh', label: 'Vitesse moyenne en gravel (km/h)', short: 'Vitesse moyenne', unit: 'km/h', icon: 'gauge', min: 5, max: 45, step: 0.5, help: 'Vitesse moyenne : ta moyenne habituelle en roulant, montées comprises, hors pauses.' },
];

function radioGroup<T extends string>(name: string, legend: string, options: Record<T, string>, value: T): { node: HTMLElement; get: () => T } {
  const inputs = (Object.keys(options) as T[]).map((k) => {
    const input = el('input', { type: 'radio', name, value: k, id: `${name}-${k}`, checked: k === value });
    return { k, input, label: el('label', { for: `${name}-${k}` }, input, options[k]) };
  });
  return {
    node: el(
      'div',
      { class: 'form-row stacked' },
      el('span', { class: 'row-label' }, legend),
      el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': legend }, ...inputs.map((i) => i.label)),
    ),
    get: () => (inputs.find((i) => i.input.checked)?.k ?? value) as T,
  };
}

export const profileView: View = async (root) => {
  const profile = await getProfile();

  const inputs = new Map<NumField['key'], HTMLInputElement>();
  const fields = NUM_FIELDS.map((f) => {
    const input = el('input', { type: 'number', id: `p-${f.key}`, inputmode: 'decimal', min: f.min, max: f.max, step: f.step, value: profile[f.key], required: true });
    inputs.set(f.key, input);
    return el('label', { class: 'form-row', for: `p-${f.key}` }, el('span', { class: 'row-label' }, icon(f.icon), f.short), input, el('span', { class: 'unit' }, f.unit));
  });
  const sex = radioGroup<Sex>('sex', 'Sexe', { homme: 'Homme', femme: 'Femme' }, profile.sex);
  const level = radioGroup<Level>('level', 'Niveau', LEVEL_LABELS, profile.level);

  const form = el(
    'form',
    {},
    el('div', { class: 'group-title' }, 'Moi'),
    el('div', { class: 'group' }, fields[0], fields[1], fields[2], sex.node),
    el('div', { class: 'group-title' }, 'À vélo'),
    el('div', { class: 'group' }, fields[3], fields[4], level.node),
    el(
      'p',
      { class: 'group-footer' },
      ...NUM_FIELDS.filter((f) => f.help).map((f) => `${f.help} `),
      'Le niveau ajuste la quantité de glucides visée pendant l’effort (un intestin non entraîné tolère moins).',
    ),
    el('button', { type: 'submit', class: 'btn btn-primary btn-block', style: 'margin-top:16px' }, icon('check'), 'Enregistrer'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next: Profile = { ...profile, sex: sex.get(), level: level.get(), complete: true };
    for (const f of NUM_FIELDS) {
      const v = Number.parseFloat(inputs.get(f.key)!.value.replace(',', '.'));
      if (!Number.isFinite(v) || v < f.min || v > f.max) {
        toast(`${f.label} : indique une valeur entre ${f.min} et ${f.max}.`, 'error');
        inputs.get(f.key)!.focus();
        return;
      }
      next[f.key] = v;
    }
    try {
      await saveProfile(next);
      Object.assign(profile, next);
      toast('Profil enregistré', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  // ---------- Mes données ----------
  const exportBtn = el('button', { type: 'button', class: 'form-row row-btn' }, el('span', { class: 'row-label' }, icon('download'), 'Exporter mes données'), el('span', { class: 'row-value' }, icon('chevron-right')));
  exportBtn.addEventListener('click', async () => {
    try {
      const backup = buildBackup(await dumpAll());
      const date = backup.exportedAt.slice(0, 10);
      await shareOrDownload(`gravel-compagnon-sauvegarde-${date}.json`, JSON.stringify(backup), 'application/json');
    } catch (err) {
      toast(`Export impossible : ${errorMessage(err)}`, 'error');
    }
  });

  const importInput = el('input', { type: 'file', id: 'backup-input', class: 'visually-hidden' });
  const importLabel = el('label', { for: 'backup-input', class: 'form-row row-btn' }, el('span', { class: 'row-label' }, icon('upload'), 'Importer une sauvegarde'), el('span', { class: 'row-value' }, icon('chevron-right')));
  const confirmBox = el('div', { class: 'card confirm-box', hidden: true });
  let pendingBackup: Backup | null = null;

  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    try {
      pendingBackup = parseBackup(await readTextFile(file));
    } catch (err) {
      toast(errorMessage(err), 'error');
      return;
    }
    const yes = el('button', { type: 'button', class: 'btn btn-primary' }, 'Importer');
    const no = el('button', { type: 'button', class: 'btn' }, 'Annuler');
    confirmBox.replaceChildren(
      el('p', {}, el('strong', {}, 'Importer : '), describeBackup(pendingBackup), pendingBackup.exportedAt ? ` (sauvegarde du ${new Date(pendingBackup.exportedAt).toLocaleDateString('fr-FR')})` : '', ' ?'),
      el('p', { class: 'muted' }, 'Les éléments déjà présents avec le même identifiant seront remplacés ; les autres sont conservés.'),
      el('div', { class: 'row' }, yes, no),
    );
    confirmBox.hidden = false;
    no.addEventListener('click', () => {
      pendingBackup = null;
      confirmBox.hidden = true;
    });
    yes.addEventListener('click', async () => {
      if (!pendingBackup) return;
      yes.disabled = true;
      try {
        await restoreAll(pendingBackup.stores);
        toast('Données importées', 'success');
        location.reload(); // recharge le profil et les listes
      } catch (err) {
        toast(`Import impossible : ${errorMessage(err)}`, 'error');
        yes.disabled = false;
      }
    });
  });

  append(
    root,
    el('h1', {}, 'Profil'),
    profile.complete ? null : el('div', { class: 'card notice' }, icon('info'), 'Complète ton profil : il sert à estimer ta dépense énergétique et ton plan nutrition.'),
    form,
    el('div', { class: 'group-title' }, 'Réglages'),
    el(
      'div',
      { class: 'group' },
      el('a', { href: '#/aliments', class: 'form-row' }, el('span', { class: 'row-label' }, icon('apple'), 'Mes aliments'), el('span', { class: 'row-value' }, icon('chevron-right'))),
      el('a', { href: '#/cartes', class: 'form-row' }, el('span', { class: 'row-label' }, icon('map'), 'Cartes hors ligne'), el('span', { class: 'row-value' }, icon('chevron-right'))),
    ),
    el('div', { class: 'group-title' }, 'Mes données'),
    el('div', { class: 'group' }, exportBtn, importLabel),
    importInput,
    el('p', { class: 'group-footer' }, describeHelp.backup),
    confirmBox,
  );
};
