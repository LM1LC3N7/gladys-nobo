// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device, feature and option
// names, refusals of a command), in English and French.
// -----------------------------------------------------------------------------

import { ACTIVE, FEATURES as F, MODE } from './constants.js';

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

export const FEATURE_NAMES = {
  [F.TEMPERATURE]: both('Temperature', 'Température'),
  [F.COMFORT]: both('Comfort temperature', 'Température confort'),
  [F.ECO]: both('Eco temperature', 'Température éco'),
  [F.MODE]: both('Mode', 'Mode'),
  [F.ACTIVE]: both('Mode in force', 'Mode en cours'),
};

export const HUB_MODE_NAME = both('Mode of the whole house', 'Mode de toute la maison');

export const MODE_NAMES = {
  [MODE.SCHEDULE]: both('Week profile', 'Programme hebdomadaire'),
  [MODE.COMFORT]: both('Comfort', 'Confort'),
  [MODE.ECO]: both('Eco', 'Éco'),
  [MODE.AWAY]: both('Away (anti-frost)', 'Absent (hors gel)'),
};

export const ACTIVE_NAMES = {
  [ACTIVE.OFF]: both('Off', 'Arrêt'),
  [ACTIVE.AWAY]: both('Away (anti-frost)', 'Absent (hors gel)'),
  [ACTIVE.ECO]: both('Eco', 'Éco'),
  [ACTIVE.COMFORT]: both('Comfort', 'Confort'),
};

export const zoneName = (name, id) =>
  name ? both(`${name} (Nobø)`, `${name} (Nobø)`) : both(`Zone ${id} (Nobø)`, `Zone ${id} (Nobø)`);
export const hubName = (name) =>
  name ? both(`${name} (Nobø hub)`, `${name} (hub Nobø)`) : both('Nobø hub', 'Hub Nobø');

/** Connection statuses. */
export const STATUS = {
  connected: (zones) =>
    both(`Connected to the hub: ${zones} zone(s).`, `Connecté au hub : ${zones} zone(s).`),
  connecting: both('Connecting to the hub…', 'Connexion au hub…'),
  serialMissing: both(
    'Enter the 12-digit serial number of the hub (on its label).',
    'Saisissez le numéro de série à 12 chiffres du hub (sur son étiquette).',
  ),
  serialInvalid: both(
    'The serial number must have 12 digits.',
    'Le numéro de série doit avoir 12 chiffres.',
  ),
  awayNotApplied: (zoneId) =>
    zoneId === null
      ? both(
          'Away mode of the whole house NOT applied: the hub never showed it (6 sends or 15 min). Set it again or check the hub.',
          'Mode absent de toute la maison NON appliqué : le hub ne l’a jamais montré (6 envois ou 15 min). Reposez-le ou vérifiez le hub.',
        )
      : both(
          `Away mode of zone ${zoneId} NOT applied: the hub never showed it (6 sends or 15 min). Set it again or check the hub.`,
          `Mode absent de la zone ${zoneId} NON appliqué : le hub ne l’a jamais montré (6 envois ou 15 min). Reposez-le ou vérifiez le hub.`,
        ),
  timezoneInvalid: both(
    'The time zone is not a known IANA name (e.g. Europe/Oslo, Europe/Paris): fix it.',
    'Le fuseau horaire n’est pas un nom IANA connu (ex. Europe/Oslo, Europe/Paris) : corrigez-le.',
  ),
  hostInvalid: both(
    'The address is not a unicast IP address of your network: fix it or leave it empty.',
    'L’adresse n’est pas une adresse IP de votre réseau : corrigez-la ou laissez-la vide.',
  ),
  serialRefused: both(
    'The hub refused this serial number: check the 12 digits on its label and save them again.',
    'Le hub a refusé ce numéro de série : vérifiez les 12 chiffres de son étiquette et enregistrez-les de nouveau.',
  ),
  versionRefused: both(
    'The hub does not speak the API version 1.1: not supported.',
    'Le hub ne parle pas l’API version 1.1 : non pris en charge.',
  ),
  notFound: (wait) =>
    both(
      `No hub with this serial number heard on the network: new try in ${wait} s. Enter its IP address if the network blocks the broadcast.`,
      `Aucun hub de ce numéro de série entendu sur le réseau : nouvel essai dans ${wait} s. Saisissez son adresse IP si le réseau bloque la diffusion.`,
    ),
  unreachable: (wait) =>
    both(
      `The hub does not answer: new try in ${wait} s.`,
      `Le hub ne répond pas : nouvel essai dans ${wait} s.`,
    ),
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys: new try in ${wait} s.`,
      `La configuration n’a pas pu être lue dans Gladys : nouvel essai dans ${wait} s.`,
    ),
};

/** Refusals and results of a command (the error message of the command in Gladys). */
export const COMMAND = {
  modesOff: both(
    'Mode commands are off: allow them in the configuration of the integration.',
    'Les commandes de mode sont désactivées : autorisez-les dans la configuration de l’intégration.',
  ),
  setpointsOff: both(
    'Temperature commands are off: allow them in the configuration of the integration.',
    'Les commandes de température sont désactivées : autorisez-les dans la configuration de l’intégration.',
  ),
  notReady: both(
    'Nothing sent: the hub is not connected, or its data is not downloaded yet.',
    'Rien envoyé : le hub n’est pas connecté, ou ses données ne sont pas encore téléchargées.',
  ),
  unknownZone: both(
    'Nothing sent: the hub does not know this zone.',
    'Rien envoyé : le hub ne connaît pas cette zone.',
  ),
  otherHub: both(
    'Nothing sent: this device belongs to another hub.',
    'Rien envoyé : cet appareil appartient à un autre hub.',
  ),
  badValue: both('Nothing sent: value not supported.', 'Rien envoyé : valeur non prise en charge.'),
  outOfRange: (min, max) =>
    both(
      `Nothing sent: a whole number from ${min} to ${max} °C is expected.`,
      `Rien envoyé : un nombre entier de ${min} à ${max} °C est attendu.`,
    ),
  comfortBelowEco: both(
    'Nothing sent: the comfort temperature cannot be below the eco temperature.',
    'Rien envoyé : la température confort ne peut pas être sous la température éco.',
  ),
  queueFull: both(
    'Nothing sent: too many commands waiting.',
    'Rien envoyé : trop de commandes en attente.',
  ),
  late: both(
    'Nothing sent: the hub was busy too long with other commands.',
    'Rien envoyé : le hub a été occupé trop longtemps par d’autres commandes.',
  ),
  cancelled: both(
    'Nothing sent: an away command came after this one.',
    'Rien envoyé : une commande « absent » est arrivée après celle-ci.',
  ),
  refused: (message) =>
    both(`The hub refused the command (${message}).`, `Le hub a refusé la commande (${message}).`),
  notApplied: both(
    'Sent, but the hub answered with other values: not applied.',
    'Envoyée, mais le hub a répondu avec d’autres valeurs : pas appliquée.',
  ),
  unconfirmed: both(
    'Sent, without confirmation from the hub yet.',
    'Envoyée, sans confirmation du hub pour l’instant.',
  ),
  awayPending: both(
    'Away mode kept: it is sent as soon as the hub answers (6 times at most within 15 min).',
    'Mode absent retenu : il part dès que le hub répond (6 fois au plus en 15 min).',
  ),
  awaySent: both(
    'Away mode sent, without confirmation yet: sent again on a new connection until the hub shows it (6 times at most within 15 min).',
    'Mode absent envoyé, sans confirmation pour l’instant : renvoyé sur une nouvelle connexion jusqu’à ce que le hub le montre (6 fois au plus en 15 min).',
  ),
  otherOutOfRange: (min, max) =>
    both(
      `Nothing sent: the other temperature of the zone, read from the hub, is not a whole number from ${min} to ${max} °C; set it first.`,
      `Rien envoyé : l’autre température de la zone, lue sur le hub, n’est pas un nombre entier de ${min} à ${max} °C ; réglez-la d’abord.`,
    ),
};

export const TEST = {
  ok: (zones, components) =>
    both(
      `Connected: ${zones} zone(s), ${components} component(s).`,
      `Connecté : ${zones} zone(s), ${components} composant(s).`,
    ),
};
