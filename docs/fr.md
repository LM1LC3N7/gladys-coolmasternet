# CoolMasterNet

Intégration Gladys non officielle pour les passerelles **CoolMasterNet** de
CoolAutomation. Une passerelle CoolMasterNet se branche sur le bus d'un système
de climatisation gainable, VRF ou multi-split (Daikin, Mitsubishi Electric,
Mitsubishi Heavy, Toshiba, LG, Samsung, Fujitsu, Hitachi, Panasonic…) et en
pilote toutes les unités intérieures. L'intégration parle à sa ligne de
commande ASCII, sur votre réseau local (port TCP 10102), sans cloud.

Jamais testé avec un vrai appareil : l'intégration suit le protocole tel que
la bibliothèque pycoolmasternet-async (utilisée par Home Assistant) le lit et
l'écrit. Sans lien avec CoolAutomation.

## Ce que vous obtenez

Un appareil Gladys par unité intérieure (L1.100, L1.101…), avec :

- **Marche/arrêt**, **Mode** (automatique, froid, chauffage,
  déshumidification, ventilation seule), **Consigne** (16 à 30 °C),
  **Ventilation** (automatique, faible, moyenne, forte ; « très faible » et
  « maximum » sont affichées mais pas envoyées) ;
- **Volet** (seulement avec l'option « Lire les volets ») ;
- **Température de la pièce**, **Filtre à nettoyer** (0 ou 1) et **Code
  d'erreur** (« Aucune erreur » ou le code du fabricant).

Les températures sont toujours en °C dans Gladys ; une passerelle réglée en
°F est convertie dans les deux sens.

## Configuration

1. Donnez une adresse IP fixe à la passerelle dans votre routeur. Vérifiez que
   son serveur ASCII sur le port 10102 est actif (il l'est par défaut).
2. Dans Gladys, ouvrez l'intégration **CoolMasterNet**, saisissez l'adresse IP
   de chaque passerelle (4 au plus, séparées par des virgules ; ajoutez
   `:port` si vous avez changé le port) et enregistrez.
3. Les unités apparaissent dans l'onglet **Découverte** : ajoutez-les.
4. Pour piloter les unités, activez **Autoriser les commandes**. Sans cette
   option, l'intégration est en lecture seule et refuse toute commande.

Options :

- **Lire les volets** : une requête de plus par unité à chaque lecture, et
  une fonctionnalité « Volet » sur chaque unité. Toutes les unités n'ont pas
  de volet motorisé.
- **Envoyer un retour à la ligne pour réveiller la passerelle** : seulement
  si la passerelle ne répond pas autrement (certains firmwares n'affichent
  leur invite qu'après un retour à la ligne).
- **Intervalle de rafraîchissement** : 60 s par défaut (30 à 600 s).

## Sécurité

La ligne de commande de la passerelle n'a pas de mot de passe : toute
machine de votre réseau peut la piloter. Gardez la passerelle sur un réseau
de confiance, jamais exposée à Internet.

Les commandes suivent des règles strictes :

- désactivées par défaut ;
- avant chaque commande, l'intégration relit le numéro de série de la
  passerelle et l'état de l'unité : si la passerelle n'est pas celle de
  l'appareil (adresse IP réattribuée) ou si l'état est illisible, rien n'est
  envoyé ;
- l'option est revérifiée juste avant l'envoi ; une commande qui ne peut pas
  partir dans les 3,5 s est refusée sans être envoyée ;
- une commande n'est confirmée que si l'état relu montre la valeur demandée ;
  sinon Gladys affiche « Commande envoyée, sans confirmation » et l'unité est
  relue 5 s plus tard ;
- la consigne est bornée de 16 à 30 °C : une valeur hors bornes est refusée ;
- l'**arrêt** n'est jamais bloqué par une autre commande en cours : il annule
  la commande en attente pour la même unité et fonctionne même juste après un
  redémarrage de l'intégration. Les arrêts passent par une voie à eux (une
  connexion de plus, jamais derrière les lectures) : un « tout éteindre »
  écrit d'un coup un `off` par unité sur une seule connexion (chaque échéance
  vérifiée juste avant son écriture), lit les réponses dans l'ordre, puis
  relit l'ensemble. Une réponse lente ne retarde jamais l'écriture des arrêts
  suivants.
  L'intégration n'ouvre jamais plus de 3 connexions à la fois vers une
  passerelle ;
- tant qu'un arrêt est en cours sur une unité, les autres commandes vers
  cette unité sont refusées (« encore en cours »).

La marche/arrêt est une fonctionnalité de climatisation
(`air-conditioning/binary`), comme pour MELCloud. Selon ce qui l'expose
(assistant vocal, HomeKit, Google Home, MCP), un « éteins tout » peut éteindre
les unités, et un « allume tout » les allumer si les commandes sont
autorisées. Les scènes « allumer / éteindre les interrupteurs » ne les
visent pas.

## Identifiants des appareils

Les appareils sont identifiés par le numéro de série de la passerelle (lu par
la commande `set`) et l'adresse de l'unité sur le bus. Si la passerelle
n'affiche aucun numéro de série à sa première lecture, l'intégration utilise
à la place l'adresse saisie (« a-192-168-1-50 »). L'identifiant choisi à la
première lecture est gardé dans `/data` pour cette adresse et ne change plus :
un numéro de série apparu ensuite (mise à jour du firmware) ne sert qu'à
vérifier que c'est bien la même passerelle, sans créer de nouveaux appareils.
Une autre passerelle à la même adresse (autre numéro de série) donne ses
propres appareils.

## Limites

- Jamais testé avec un vrai appareil.
- 4 passerelles et 64 unités par passerelle au plus.
- Un « tout éteindre » écrit tous les arrêts tout de suite, mais Gladys
  n'attend l'acquittement que 5 s : si la passerelle met plus d'environ 3,9 s
  à répondre à tous les `off`, les arrêts sont bien envoyés mais annoncés
  « envoyée, sans confirmation », et l'état est relu 5 s plus tard.
- Le nom exact du champ « numéro de série » de la commande `set` n'est pas
  documenté publiquement : l'intégration accepte « serial number »,
  « serial », « S/N », « SN », « UID » et « MAC ».
- La remise à zéro du filtre (`filt`) et l'envoi d'une température ambiante
  (`feed`) ne sont pas proposés.

## Dépannage

- **Pas de réponse** : vérifiez l'adresse, le port et que le serveur ASCII
  est actif ; essayez l'option « Envoyer un retour à la ligne ».
- **Numéro de série illisible** : les états ne sont pas affichés et les
  commandes sont refusées jusqu'à la lecture suivante.
- Le bouton **Tester la connexion** ne relit jamais une passerelle plus tôt
  que l'intervalle : il indique quand aura lieu la prochaine lecture.

## Crédits

Logique de protocole portée de
[pycoolmasternet-async](https://github.com/OnFreund/pycoolmasternet-async)
(MIT, On Freund, Steven Grimm). Voir `THIRD_PARTY_NOTICES.md`.
