# Consignes permanentes BetPro

## Synchronisation obligatoire du Guide des stratégies

À la demande du propriétaire (27 novembre 2026), toute modification de BetPro doit inclure une vérification du Guide des stratégies, situé dans `index.html`, section `id="s-install"` (rubrique visible « Guide des stratégies »).

- Toute création, suppression ou modification d'une méthode, d'un moteur, d'un modèle, d'un indicateur, d'une source de données, d'un seuil de validation, d'une formule ou d'une règle de décision doit être répercutée dans le guide dans la même intervention, idéalement dans la même livraison.
- Vérifier le code réellement utilisé dans `betpro-app.js` et dans le Worker Cloudflare `pgi-betpro` avant d'écrire une définition. Décrire le principe, les données, le fonctionnement, les critères, le périmètre et les limites. Distinguer modèle indépendant, consensus de marché, estimation indicative et validation hors échantillon.
- Ne pas présenter une fonctionnalité prévue comme déjà opérationnelle. Ne jamais confondre probabilité, maturité, supériorité statistique et rentabilité garantie.
- Si une modification est uniquement visuelle ou sans effet sur la méthode, vérifier le guide et conserver les définitions exactes plutôt que les modifier artificiellement.
- Avant clôture, vérifier la cohérence du guide avec les changements et indiquer dans le compte rendu s'il a été actualisé ou contrôlé sans changement nécessaire.

## Protection de l'existant

Préserver le design, les fonctionnalités, les données historiques, la collecte automatique multisport/PMU/HKJC, les quotas Cloudflare, les seuils et l'apprentissage Benter. Ne pas forcer une activation. Effectuer des changements minimaux et garder une version récupérable. Vérifier les changements avant d'annoncer leur réussite. Ne pas créer de tâche planifiée pour cette maintenance.
