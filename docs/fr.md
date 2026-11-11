# Nobø Hub

Amène dans Gladys les **zones d'un Nobø Hub** (Nobø Energy Control, aussi
vendu comme Ecohub), sur votre réseau local, par l'API locale que Glen Dimplex
a publiée pour le hub (version 1.1). Sans compte, sans cloud.

> Jamais testé avec un vrai appareil : écrit d'après le seul document officiel
> de l'API. Sans lien avec Glen Dimplex Nordic, ni soutenu ni approuvé par lui.
> Dites-nous ce qui marche et ce qui ne marche pas.

## Ce que vous obtenez

Un appareil par **zone** du hub :

| Fonctionnalité      | Ce que c'est                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| Température         | La température de la zone (son Nobø Switch ou son capteur), si le hub en a une  |
| Température confort | La température confort de la zone (°C, nombres entiers, 7 à 30)                 |
| Température éco     | La température éco de la zone                                                   |
| Mode                | Programme hebdomadaire, confort, éco ou absent : le choix en place pour la zone |
| Mode en cours       | Confort, éco, absent ou arrêt : ce que fait la zone maintenant (lecture seule)  |

Et un appareil pour le **hub**, avec le mode de toute la maison.

Le « mode en cours » est déduit ici des dérogations et du programme
hebdomadaire de la zone, à l'heure locale du fuseau configuré : le hub ne
l'envoie pas. Les programmes sont lus en commençant par le lundi (à vérifier
sur un vrai hub). Une température que le hub ne connaît pas (`N/A`) ne publie
rien.

## Installation

1. Relevez le **numéro de série** du hub sur son étiquette (12 chiffres) et
   saisissez-le. Le hub le demande à chaque connexion. Il est gardé par Gladys
   dans sa base, jamais réaffiché, envoyé seulement à votre hub.
2. Laissez l'**adresse IP** vide : Gladys écoute le hub, qui s'annonce toutes
   les 2 s sur le port UDP 10000 (Gladys demande cette permission à
   l'installation). Si votre réseau bloque cette annonce, donnez au hub une
   adresse fixe dans votre box et saisissez-la.
3. Vérifiez le **fuseau horaire** (Europe/Oslo par défaut ; Europe/Paris en
   France) : l'heure locale est envoyée au hub à chaque connexion, comme le
   fait l'application Nobø.
4. Ouvrez **Découverte**, ajoutez les zones voulues.

Le hub accepte deux clients locaux à la fois : l'application Nobø sur le même
réseau en compte un.

## Commandes (désactivées par défaut)

Sans option, Gladys ne fait que lire, et peut passer en **mode absent (hors
gel)**, toujours permis. Aucune commande ne passe par un interrupteur : un
« éteins tout » n'atteint jamais le chauffage.

- **Autoriser les commandes de mode** : confort, éco ou retour au programme
  hebdomadaire, pour une zone ou toute la maison. Gladys écrit une dérogation
  constante, telle que le hub la définit.
- **Autoriser les commandes de température** : les températures confort et
  éco d'une zone, nombres entiers de 7 à 30 °C, confort jamais sous éco.

Chaque commande est décidée sur l'état de la session en cours (le hub pousse
chaque changement à ses clients) et confirmée par la réponse du hub. Sans
réponse en 3,5 s, Gladys affiche « envoyée, sans confirmation » ; si le hub
répond d'autres valeurs, « pas appliquée » ; sans session téléchargée,
« rien envoyé ». Les commandes partent une à une (une scène qui règle
plusieurs zones attend son tour).

### Le mode absent

Le mode absent (hors gel) d'une zone ou de toute la maison est la commande
protectrice : ni option, ni session absente, ni file pleine ne le refusent. Il
passe devant les commandes en attente, et celles de sa cible (toutes, pour
toute la maison) sont abandonnées. Tant que le hub ne le montre pas appliqué,
il est gardé dans `/data` et réécrit : si le hub ne répond pas en 3,5 s, la
connexion est jugée figée, fermée, et le mode absent écrit sur la suivante,
après son téléchargement, ou 3 s au plus après la poignée de main si le
téléchargement ne se termine pas (6 fois au plus en 15 minutes). Après un
redémarrage, il part dès que Gladys a redonné la configuration (le hub demande
le numéro de série, jamais écrit dans `/data`). Il n'est plus renvoyé dès
qu'un mode plus récent de la même cible est parti de Gladys, ou dès que le hub
montre un autre mode posé ensuite (application, interrupteur) ; un changement
de température ne l'arrête pas.

Le mode absent de toute la maison n'atteint pas les zones qui n'autorisent pas
les dérogations (un réglage de la zone dans l'application Nobø) : réglez ces
zones une par une.

Il peut quand même échouer, et Gladys le dit : quand le hub le refuse (une
réponse `E00`, son message affiché), ou quand le hub ne le montre pas en
15 minutes ou 6 envois : un avertissement est alors journalisé et l'état
nomme la zone (ou toute la maison), jusqu'à un mode absent confirmé ou une
autre commande cliquée.

Un hub qui n'envoie rien pendant 75 s est interrogé de nouveau ; sans réponse
en 20 s, la connexion est fermée puis rouverte.

## États et dépannage

- « Saisissez le numéro de série à 12 chiffres » : champ vide ou sans
  12 chiffres.
- « Le hub a refusé ce numéro de série » : vérifiez l'étiquette. Rien n'est
  renvoyé tout seul ; enregistrez un nouveau numéro, ou appuyez sur **Tester
  la connexion** pour un nouvel essai.
- « Aucun hub de ce numéro de série entendu » : saisissez l'adresse IP du hub.
- « Le hub ne répond pas » : nouveaux essais après 5 s, 10 s, 20 s… jusqu'à
  5 minutes.

## Vie privée

Le numéro de série n'apparaît ni dans les journaux, ni dans les états, ni dans
`/data`, ni dans les identifiants des appareils : seuls ses 9 premiers
chiffres, que le hub annonce lui-même sur votre réseau, nomment le hub.
`/data` garde les commandes « absent » en attente, l'heure du dernier essai de
connexion et, après un refus, 8 bits d'une empreinte salée du numéro refusé.
