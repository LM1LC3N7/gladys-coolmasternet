// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = (uid) => both(`Air conditioner ${uid}`, `Climatisation ${uid}`);

export const FEATURE_NAMES = {
  [FEATURES.POWER]: both('On/off', 'Marche/arrêt'),
  [FEATURES.MODE]: both('Mode', 'Mode'),
  [FEATURES.SETPOINT]: both('Setpoint', 'Consigne'),
  [FEATURES.FAN]: both('Fan speed', 'Ventilation'),
  [FEATURES.SWING]: both('Louver', 'Volet'),
  [FEATURES.ROOM]: both('Room temperature', 'Température de la pièce'),
  [FEATURES.FILTER]: both('Filter to clean', 'Filtre à nettoyer'),
  [FEATURES.ERROR]: both('Error code', "Code d'erreur"),
};

export const MODE_NAMES = {
  auto: both('Automatic', 'Automatique'),
  cool: both('Cooling', 'Froid'),
  heat: both('Heating', 'Chauffage'),
  dry: both('Drying', 'Déshumidification'),
  fan: both('Fan only', 'Ventilation seule'),
};

export const FAN_NAMES = {
  auto: both('Automatic', 'Automatique'),
  low: both('Low', 'Faible'),
  med: both('Medium', 'Moyenne'),
  high: both('High', 'Forte'),
};

export const SWING_NAMES = {
  auto: both('Swing (automatic)', 'Balayage (automatique)'),
  horizontal: both('Horizontal', 'Horizontal'),
  30: both('30°', '30°'),
  45: both('45°', '45°'),
  60: both('60°', '60°'),
  vertical: both('Vertical', 'Vertical'),
  stop: both('Stopped', 'Arrêté'),
};

export const ERROR_TEXTS = {
  none: both('No error', 'Aucune erreur'),
};

/** The integration status and the button. */
export const T = {
  noAddress: both(
    'Enter the IP address of each CoolMasterNet bridge, then save.',
    "Saisissez l'adresse IP de chaque passerelle CoolMasterNet, puis enregistrez.",
  ),
  invalid: (typed) =>
    both(
      `Invalid address(es) ignored: ${typed} (an IPv4 address or a host name, optional port).`,
      `Adresse(s) invalide(s) ignorée(s) : ${typed} (une adresse IPv4 ou un nom d'hôte, port facultatif).`,
    ),
  dropped: (count) =>
    both(
      `${count} address(es) ignored: 4 bridges at most.`,
      `${count} adresse(s) ignorée(s) : 4 passerelles au plus.`,
    ),
  connecting: both('Reading the bridges…', 'Lecture des passerelles…'),
  connected: (count, total, units) =>
    both(
      `Connected: ${count} of ${total} bridge${total === 1 ? '' : 's'} answering, ${units} unit${units === 1 ? '' : 's'}.`,
      `Connecté : ${count} passerelle${count === 1 ? '' : 's'} sur ${total} répond${count === 1 ? '' : 'ent'}, ${units} unité${units === 1 ? '' : 's'}.`,
    ),
  unreachable: (names) => both(`No answer from: ${names}.`, `Pas de réponse de : ${names}.`),
  unverified: (names) =>
    both(
      `Serial number unreadable this time, states not shown: ${names}.`,
      `Numéro de série illisible cette fois, états non affichés : ${names}.`,
    ),
  otherBridge: (names) =>
    both(
      `Another bridge now answers at: ${names} (new devices in the Discovery tab).`,
      `Une autre passerelle répond désormais à : ${names} (nouveaux appareils dans l'onglet Découverte).`,
    ),
  duplicate: (pairs) =>
    both(
      `Same bridge typed twice, read once: ${pairs}.`,
      `Même passerelle saisie deux fois, lue une seule fois : ${pairs}.`,
    ),
  noUnits: (names) =>
    both(`No indoor unit listed by: ${names}.`, `Aucune unité intérieure listée par : ${names}.`),
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
    waiting: (name, wait) =>
      both(
        `${name}: read again in ${wait.en} (never sooner than the interval).`,
        `${name} : relue dans ${wait.fr} (jamais plus tôt que l'intervalle).`,
      ),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  swingDisabled: both(
    'The louver is not read: turn on "Read the louvers" in the configuration. Not sent.',
    "Le volet n'est pas lu : activez « Lire les volets » dans la configuration. Non envoyée.",
  ),
  unknownUnit: both(
    'This unit is not read by the integration right now (bridge not answering, or another bridge at its address): not sent.',
    "Cette unité n'est pas lue par l'intégration en ce moment (passerelle sans réponse, ou autre passerelle à son adresse) : non envoyée.",
  ),
  otherBridge: both(
    'The bridge at this address is not the one of this unit (serial number): not sent.',
    "La passerelle à cette adresse n'est pas celle de cette unité (numéro de série) : non envoyée.",
  ),
  identityUnknown: both(
    'The serial number of the bridge could not be read just before: not sent.',
    "Le numéro de série de la passerelle n'a pas pu être relu juste avant : non envoyée.",
  ),
  badValue: both('Invalid value: not sent.', 'Valeur invalide : non envoyée.'),
  outOfRange: (min, max) =>
    both(
      `The setpoint must be between ${min} and ${max} °C: not sent.`,
      `La consigne doit être entre ${min} et ${max} °C : non envoyée.`,
    ),
  stillRunning: both(
    'Another command to this unit is still running: not sent.',
    'Une autre commande vers cette unité est encore en cours : non envoyée.',
  ),
  cancelled: both(
    'Cancelled by a stop command sent to the same unit: not sent.',
    "Annulée par une commande d'arrêt envoyée à la même unité : non envoyée.",
  ),
  tooSlow: both(
    'The bridge answered too slowly to send the command in time: not sent. Try again.',
    'La passerelle a répondu trop lentement pour envoyer la commande à temps : non envoyée. Réessayez.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the unit could not be read just before (${reason}): command not sent.`,
      `L'état de l'unité n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  incompleteState: both(
    'The bridge gave an incomplete state (a value this integration cannot read): command not sent.',
    "La passerelle a donné un état incomplet (une valeur que l'intégration ne sait pas lire) : commande non envoyée.",
  ),
  previousPending: both(
    'The previous command is not visible yet: not sent, try again in a few seconds.',
    "La commande précédente n'est pas encore visible : non envoyée, réessayez dans quelques secondes.",
  ),
  notSent: (reason) =>
    both(
      `The bridge could not be reached (${reason}): command not sent.`,
      `La passerelle n'a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  refused: both(
    'The bridge refused the command (unknown or unsupported by this unit).',
    'La passerelle a refusé la commande (inconnue ou non prise en charge par cette unité).',
  ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the unit in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l'état de l'unité dans quelques secondes.`,
    ),
};
