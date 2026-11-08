/**
 * Écran « Profil ». Étape 1 : seulement la vitesse moyenne (utilisée pour la durée estimée).
 * Étape 3 : poids, taille, âge, sexe, poids du vélo, niveau.
 */
import { getProfile, saveProfile } from '../../services/db';
import { toast } from '../components/toast';
import { el, errorMessage } from '../dom';
import type { View } from '../router';

export const profileView: View = async (root) => {
  const profile = await getProfile();

  const speed = el('input', {
    type: 'number',
    id: 'avg-speed',
    inputmode: 'decimal',
    min: 5,
    max: 45,
    step: 0.5,
    value: profile.avgSpeedKmh,
    required: true,
  });

  const form = el(
    'form',
    { class: 'card stack' },
    el('label', { for: 'avg-speed', class: 'field-label' }, 'Vitesse moyenne en gravel (km/h)'),
    speed,
    el('p', { class: 'muted' }, 'Ta moyenne habituelle sur une sortie complète (montées comprises), hors pauses.'),
    el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Enregistrer'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = Number.parseFloat(speed.value.replace(',', '.'));
    if (!Number.isFinite(value) || value < 5 || value > 45) {
      toast('Indique une vitesse entre 5 et 45 km/h.', 'error');
      return;
    }
    try {
      await saveProfile({ ...profile, avgSpeedKmh: value });
      toast('Profil enregistré', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  root.append(
    el('h1', {}, 'Profil'),
    form,
    el('p', { class: 'muted' }, 'Poids, taille, âge, poids du vélo… arriveront avec le plan nutrition (étape 3).'),
  );
};
