# 🔍 Audit de fiabilité des scores — L'Éclaircie

> Audit réalisé le 25 juillet 2026 sur la branche `main` (commit `250b4aa`).
> Méthode : lecture intégrale du pipeline (`scripts/`, `supabase/functions/etl-nightly`, `src/`, `civic_tech.sql`)
> **+ téléchargement et analyse statistique du corpus réel** `Scrutins.json.zip` de la 17e législature
> (8 434 scrutins, 1,27 M de votes individuels) pour quantifier chaque problème.

---

## 0. Verdict en une page

Le score n'est pas « imprécis » : **il n'existe pas encore, et la chaîne qui doit l'alimenter est cassée à trois endroits bloquants**. Au-delà des bugs, la méthodologie actuelle produirait, même corrigée, un score non défendable publiquement — pour une raison mesurée sur les données réelles : **86 % des scrutins de l'Assemblée sont des votes d'amendements dont le libellé ne contient aucune information sémantique exploitable**.

| # | Constat | Gravité | Preuve |
|---|---|---|---|
| **P0-1** | L'insertion dans `fact_scrutin` viole 3 contraintes `NOT NULL` → aucun scrutin n'est jamais inséré | 🔴 Bloquant | `etl-nightly/index.ts:423` vs `civic_tech.sql:57` |
| **P0-2** | L'insertion dans `llm_classification` écrit une colonne inexistante (`statut`) et omet `modele_llm` (`NOT NULL`) | 🔴 Bloquant | `etl-nightly/index.ts:599` vs `civic_tech.sql:81` |
| **P0-3** | Aucune fonction de calcul de score n'existe (ni SQL, ni TS). `cache_score_groupe` / `cache_score_depute` ne sont jamais alimentées | 🔴 Bloquant | `grep cache_score src/` → 0 résultat |
| **P1-1** | 86 % des scrutins ont un libellé sans contenu sémantique → classification LLM impossible sur ce sous-corpus | 🟠 Fiabilité | 7 221/8 434 mesurés |
| **P1-2** | Participation médiane **26 %** (135 votants/577) → score député construit sur un échantillon minuscule et auto-sélectionné | 🟠 Fiabilité | mesuré sur 8 434 scrutins |
| **P1-3** | Les `SELECT` Supabase sont plafonnés silencieusement à 1 000 lignes → promesses et scrutins connus tronqués | 🟠 Fiabilité | `etl-nightly/index.ts:296,330` |
| **P1-4** | Les promesses partagées (NFP × 4 groupes, Ensemble × 3 groupes) sont dupliquées en lignes distinctes → le même texte reçoit des polarités potentiellement différentes | 🟠 Fiabilité | `partage.json` + `02-extract:415` |
| **P1-5** | `groupe_id_au_moment_du_vote` est renseigné avec le groupe **actuel** — l'inverse de l'intention documentée | 🟠 Neutralité | `etl-nightly/index.ts:480` |
| **P2-x** | Formule de score non spécifiée : absences, abstentions, motions de censure, pondération, taille d'échantillon | 🟡 Méthodo | voir §4 |

**La bonne nouvelle** : le corpus contient **1 213 scrutins sémantiquement exploitables** (dont 72 solennels avec **92 % de participation**). C'est exactement le périmètre décrit dans la spec produit d'origine (« Top 50 des textes polémiques ») et jamais implémenté. En s'y restreignant, le score devient à la fois calculable, fiable et 7× moins cher.

---

## 1. Ce que disent les données réelles

Analyse du fichier officiel `17/loi/scrutins/Scrutins.json.zip` (26 Mo, 8 434 fichiers).

### 1.1 Nature des scrutins

| Type de vote | Nombre | Part |
|---|---|---|
| Scrutin public ordinaire (`SPO`) | 8 339 | 98,9 % |
| Scrutin public solennel (`SPS`) | **72** | 0,9 % |
| Motion de censure (`MOC`) | 23 | 0,3 % |

Répartition par **contenu réel du libellé** :

| Catégorie | Nombre | Participation médiane | Exploitable par un LLM ? |
|---|---|---|---|
| Solennel | 72 | **532 / 577 (92 %)** | ✅ Oui |
| « l'ensemble de… » (vote final) | 153 | 146 (25 %) | ✅ Oui |
| Motion de procédure | 57 | 248 (43 %) | ⚠️ Avec contexte |
| Motion de censure | 23 | 143 (25 %) | ⚠️ Traitement spécial |
| Autre | 908 | 113 (20 %) | ⚠️ Variable |
| **Amendement / sous-amendement** | **7 221** | 136 (24 %) | ❌ **Non** |

### 1.2 Le problème central : des libellés vides de sens

Voici des `titre` réels tirés du corpus — c'est **la seule chose** que reçoit Gemini aujourd'hui :

```
l'amendement n° 1762 de M. Le Coq et l'amendement identique suivant à l'article 2
du projet de loi de finances pour 2025 (première lecture).

le sous-amendement n° 48 de M. Jean-Philippe Tanguy à l'amendement n° 22 de
M. de Courson à l'article 2 de la proposition de loi visant à lutter contre les
fermetures abusives de comptes bancaires (première lecture).
```

Aucun modèle, quel qu'il soit, ne peut déterminer si l'amendement n° 1762 va dans le sens de la promesse « TVA à 0 % sur les produits de première nécessité ». **Le contenu de l'amendement n'est pas dans le fichier des scrutins.** Le LLM va néanmoins produire une polarité et une `confidence` — c'est précisément le mécanisme qui fabrique un score qui « ne semble pas satisfaisant ».

À comparer avec un libellé de scrutin solennel :

```
l'ensemble de la proposition de loi visant à sortir la France du piège du
narcotrafic (première lecture).
```

Celui-ci est parfaitement classifiable.

### 1.3 Ce que le pipeline n'exploite pas

Le JSON de l'AN contient des champs directement utiles, aujourd'hui tous ignorés :

| Champ | Disponibilité | Usage recommandé |
|---|---|---|
| `typeVote.codeTypeVote` | 100 % | Filtrage + pondération (SPS ≫ SPO) |
| `objet.dossierLegislatif.dossierRef` | **2 608** scrutins (31 %) | Jointure vers *Dossiers législatifs* → titre substantiel + exposé des motifs |
| `objet.dossierLegislatif.libelle` | 2 608 | Contexte immédiat pour le LLM (ex. « L'intérêt des enfants ») |
| `demandeur.texte` | ~100 % | Signal fort (« Présidente du groupe RN ») |
| `sort.code` | 100 % | `sort_adopte` — colonne `NOT NULL` jamais remplie |
| `numero` | 100 % | Colonne `NOT NULL` jamais remplie |
| `nombreMembresGroupe` (par groupe) | 100 % | **Permet enfin de calculer l'absence** |
| `parDelegation` | **191 629 votes (15 %)** | Vote par procuration ≠ présence |
| `miseAuPoint` | fréquent | Corrections de vote déclarées a posteriori |
| `nonVotantsVolontaires` | 0 sur L17 | (rien à faire, mais à parser par sécurité) |

### 1.4 Volumétrie

1 270 476 lignes de votes individuels sur la législature complète. Avec index, on approche les limites des **500 Mo** du plan Supabase Free. En se restreignant aux 1 213 scrutins exploitables : **~180 000 lignes**, soit une marge confortable.

---

## 2. Bugs bloquants (P0) — à corriger avant toute discussion de méthodologie

### P0-1 — `fact_scrutin` : violation de contraintes `NOT NULL`

`supabase/functions/etl-nightly/index.ts:423`

```ts
.insert({
  uid_an, date_scrutin, objet, expose_des_motifs, llm_traite, pertinent
})
```

Le schéma (`civic_tech.sql:57`) impose `NOT NULL` sur **`numero`**, **`titre`** et **`sort_adopte`**, jamais fournis. Chaque insertion échoue, l'erreur est loguée puis `continue` → **le pipeline tourne « avec succès » en n'insérant rien**. C'est le mode de défaillance le plus dangereux : silencieux.

Second point : `objet` reçoit `scrutin.titre` alors que `scrutin.objet.libelle` existe, et `expose_des_motifs` est écrit en dur à `""`.

### P0-2 — `llm_classification` : colonne inexistante + `NOT NULL` manquant

`supabase/functions/etl-nightly/index.ts:599`

```ts
statut: c.confidence >= CONFIDENCE_THRESHOLD ? "auto" : "review",
```

La colonne s'appelle **`statut_validation`**. De plus **`modele_llm`** est `NOT NULL` et absent. L'insert est fait en **un seul batch tableau** : une seule ligne fautive (ou un `promesse_id` halluciné violant la clé étrangère) annule **toutes** les classifications du scrutin.

### P0-3 — Le calcul de score n'existe nulle part

`cache_score_groupe` et `cache_score_depute` sont définies dans le schéma, documentées dans `AGENT.md`… et jamais écrites : aucune fonction PL/pgSQL, aucun script, aucune référence dans `src/`. La page d'accueil `src/app/page.tsx` est encore le template `create-next-app`.

**C'est le vrai sujet de cet audit** : la formule doit être spécifiée avant d'être codée (§4).

### P0-4 — Bugs secondaires du même fichier

| Ligne | Problème |
|---|---|
| `509` | `syntheseVote.libelle`, `nbreSuffragesPour`, `nbreSuffragesContre` **n'existent pas** dans le JSON AN (les vrais champs sont `annonce` et `decompte.pour/contre`). Le prompt envoie donc toujours `RÉSULTAT : inconnu (0 pour, 0 contre)`. |
| `296` | `select("uid_an")` sans pagination → **plafonné à 1 000 lignes** par PostgREST. Au-delà de 1 000 scrutins en base, la déduplication devient fausse. |
| `330` | Idem pour `dim_promesse`. Avec 11 groupes × 50-150 promesses, on dépasse 1 000 → **des promesses disparaissent silencieusement** du contexte de classification. |
| `311` | `if (nouveauxScrutins.length >= maxScrutins) break;` — l'itération suit l'ordre **alphabétique du ZIP** (`V1`, `V10`, `V100`, `V1000`…), pas l'ordre chronologique. Avec 1 117 scrutins sur le seul mois de novembre 2025 et un plafond de 50/nuit + `LOOKBACK_DAYS=7`, des scrutins sont **définitivement perdus** — et le sous-échantillon retenu est arbitraire, donc potentiellement biaisé. |
| `287` | Le parsing complet du ZIP (8 434 fichiers, inflate individuel) dans une Edge Function limitée à **2 s de CPU** sur le plan Free est très probablement au-delà du budget. À mesurer. |
| `597` | `prompt_hash` = `btoa(...)` tronqué à 32 caractères dans une colonne `char(64)` : ce n'est pas un SHA-256, la traçabilité annoncée n'est pas assurée. |
| `480` | `groupe_id_au_moment_du_vote: dep.groupe_id` → le groupe **actuel**. Le `.dbml` documente pourtant explicitement l'inverse comme garantie anti-manipulation. |

---

## 3. Problèmes de fiabilité des données (P1)

### 3.1 L'absence n'existe pas dans le modèle

Un député absent **n'apparaît dans aucune liste** du JSON. Le pipeline ne crée donc aucune ligne pour lui. Conséquences :

- Sur un scrutin ordinaire médian, **442 députés sur 577 sont invisibles**.
- Un député dont le score repose sur 12 scrutins et un autre sur 300 reçoivent le même affichage météo, avec la même apparence d'autorité.
- Un député qui n'est présent que sur les votes où il est d'accord avec son programme obtient mécaniquement 100/100. **Le score actuel récompense l'absentéisme sélectif.**

`nombreMembresGroupe` est présent dans chaque bloc groupe : l'absence est donc **calculable**. Il faut la matérialiser explicitement (`position_vote = NULL` + un motif), et surtout **ne jamais la mélanger au score de cohérence**.

### 3.2 Promesses dupliquées entre groupes

`partage.json` attribue :
- le programme NFP à **LFI-NFP, SOC, ECOS, GDR**
- le programme Ensemble à **EPR, HOR, DEM**

`02-extract-promesses.ts:415` insère une ligne `dim_promesse` **par groupe**, avec un `id` distinct pour un texte identique. L'ETL demande ensuite à Gemini de classer chacune séparément. **Deux promesses au texte rigoureusement identique peuvent recevoir des polarités ou des confiances différentes** — et donc faire diverger les scores de LFI-NFP et du groupe SOC pour des raisons de pur bruit stochastique. C'est indéfendable si un journaliste s'en aperçoit.

Correctif : une table `dim_promesse` canonique (dédupliquée par `dedupe_hash` sur le texte seul) + une table de liaison `promesse_groupe`. Une seule classification LLM, réutilisée par tous les groupes signataires.

Conséquence connexe : **UDR (UDDPLR) et NI n'ont aucun programme** dans `scripts/data/programmes/`. Ils ne peuvent donc pas avoir de score — il faut l'afficher comme tel, pas les laisser à 0 ou absents sans explication.

Question éditoriale à trancher et à documenter publiquement : attribuer le programme « Ensemble » à HOR et DEM, et le programme NFP à quatre groupes distincts, est une hypothèse forte qui sera contestée. Elle doit être assumée en toutes lettres dans le « Mode Expert ».

### 3.3 Le `confidence_score` du LLM n'est pas une mesure de fiabilité

Le seuil `CONFIDENCE_THRESHOLD = 0.7` sur une confiance auto-déclarée par le modèle est un faux filet de sécurité. La littérature est constante : les confiances verbalisées par les LLM sont **systématiquement sur-confiantes et mal calibrées** ([On Verbalized Confidence Scores for LLMs](https://arxiv.org/html/2412.14737v2), [Assessing and Mitigating Miscalibration in LLM-Based Social Science Measurement](https://arxiv.org/html/2605.11954v1)).

Substitut robuste et peu coûteux : **l'accord inter-passes**. Classer deux fois (deux prompts formulés différemment, ou deux modèles), ne retenir en `auto` que les accords, router les désaccords vers `/admin`. C'est la recommandation issue des travaux sur la fiabilité de l'annotation LLM en science politique ([Semantic stability protocol](https://link.springer.com/article/10.1007/s11135-026-02832-9)).

### 3.4 Un seul appel pour ~1 000 promesses

Le Context Cache contient toutes les promesses de tous les groupes, tronquées à 100 caractères de citation. On demande au modèle de renvoyer uniquement les liens non nuls parmi ~1 000 candidats, en une passe. C'est le pire régime pour le rappel, et un terrain fertile pour les `promesse_id` hallucinés — jamais validés contre la liste envoyée avant l'`INSERT`.

Correctif : **pré-filtrage** avant appel LLM. Un filtre lexical (mots-clés par thème) ou par embeddings ramène le candidat set à 20-40 promesses, ce qui améliore simultanément le rappel, la précision et le coût.

---

## 4. Méthodologie du score — spécification proposée

C'est le cœur du sujet. Voici une formule défendable, auditable et calculable en SQL.

### 4.1 Principe directeur : trois indicateurs, jamais un seul

Le mélange « absence + abstention + incohérence » dans un chiffre unique est ce qui rend n'importe quel score de ce type attaquable. Séparer :

| Indicateur | Ce qu'il mesure | Affichage |
|---|---|---|
| **Cohérence** | Sur les votes exprimés et rattachés à une promesse : le vote va-t-il dans le sens de l'engagement ? | ☀️ Météo principale |
| **Présence** | Part des scrutins retenus où le député a exprimé un vote | Badge séparé |
| **Couverture** | Part des promesses du groupe effectivement testées par au moins un scrutin | Note de bas de page + Mode Expert |

La **couverture** est indispensable à la neutralité : l'ordre du jour est fixé par le gouvernement, donc *quelles* promesses sont mises à l'épreuve n'a rien d'aléatoire. Un groupe d'opposition dont 8 % des promesses ont été testées ne peut pas être comparé à un groupe de la majorité dont 40 % l'ont été. Il faut l'écrire.

### 4.2 Sélection du corpus (le levier n°1)

Ne classifier que les scrutins **`eligible = true`** :

```sql
-- Corpus retenu : ~1 213 scrutins sur 8 434 (14 %)
eligible :=
     type_vote = 'SPS'                        -- solennel      (72)
  OR type_vote = 'MOC'                        -- censure       (23)
  OR titre ILIKE 'l''ensemble %'              -- vote final    (153)
  OR (dossier_ref IS NOT NULL AND type_vote = 'SPO' AND titre NOT ILIKE '%amendement%')
```

Les amendements ne redeviennent éligibles qu'après enrichissement par le jeu de données *Amendements* de l'AN (qui contient `dispositif` et `exposeSommaire`, seuls textes réellement classifiables). À traiter en V2.

Effets : coût LLM divisé par ~7, volume DB divisé par ~7, et surtout **suppression de la principale source de bruit**.

### 4.3 Formule

Pour un député `d`, un thème `t` (ou tous), sur les scrutins éligibles :

**Étape 1 — alignement élémentaire** pour un couple (scrutin `s`, promesse `p`) :

```
a(s,p) = position_vote(d,s) × polarite(s,p)     ∈ {-1, 0, +1}
```

**Étape 2 — agrégation intra-scrutin** (correctif majeur) :

```
A(d,s) = moyenne des a(s,p) sur les promesses p liées à s
```

Sans cette étape, un scrutin rattaché à 12 promesses pèse 12 fois plus qu'un scrutin rattaché à une seule. Une seule loi de finances écraserait tout le reste du score.

**Étape 3 — pondération du scrutin** :

```
w(s) = w_type(s) × w_abst(d,s)

w_type : solennel = 3 | vote final « l'ensemble » = 2 | autre = 1
w_abst : abstention = 0,5 (A = 0)   |   vote exprimé = 1
```

L'abstention à demi-poids est un **choix éditorial** : elle ne prouve pas l'incohérence, mais ne peut pas non plus être ignorée. À documenter publiquement — quelle que soit l'option, elle doit être explicite.

**Étape 4 — score brut et normalisation** :

```
score_brut = Σ w(s)·A(d,s) / Σ w(s)          ∈ [-1, +1]
score_0_100 = round( (score_brut + 1) × 50 ) ∈ [0, 100]
```

**Étape 5 — rétrécissement (shrinkage) vers le groupe** :

```
n_eff = Σ w(s)
score_final = (n_eff × score_depute + k × score_groupe) / (n_eff + k)     avec k = 8
```

Sans cela, un député avec 3 scrutins et un député avec 200 sont affichés avec la même assurance. Le shrinkage bayésien est la correction standard et se justifie en une phrase auprès du public : *« tant qu'on a peu de votes, on part de la position de son groupe »*.

**Étape 6 — seuil de publication** :

```
si n_eff < 10  →  pas de météo. Afficher 🌫️ « Données insuffisantes »
```

Une cinquième catégorie météo « Brouillard » s'intègre naturellement à la métaphore et vaut mieux qu'un chiffre faux. Elle protège aussi juridiquement.

**Étape 7 — intervalle de crédibilité** : calculer un IC à 95 % par bootstrap sur les scrutins. Si l'intervalle chevauche deux catégories météo (ex. Nuages / Éclaircies), afficher la catégorie basse et l'incertitude. Le stocker dans `cache_score_depute` (`score_ic_bas`, `score_ic_haut`).

### 4.4 Cas particuliers à coder explicitement

| Cas | Traitement |
|---|---|
| **Motion de censure** | Vérifié sur `VTANR5L17V1` : `pour = 197, contre = 0, abstentions = 0`. **Seuls les votes « pour » sont enregistrés** — le règlement ne compte pas les opposants. Ne jamais traiter les non-votants comme des opposants. Poids nul dans la cohérence, ou indicateur dédié. |
| **Vote par délégation** (15 % des votes) | Compte pour la cohérence, **ne compte pas** pour la présence. Le champ `parDelegation` doit être persisté. |
| **`miseAuPoint`** | Corrections de vote déclarées après coup. Les ignorer expose à des démentis publics documentés. À parser et appliquer. |
| **Changement de groupe** | Le score doit utiliser `dim_depute_groupe_historique` à la date du vote, à la fois pour `groupe_id_au_moment_du_vote` **et** pour choisir les promesses de référence. |
| **Députés partis / arrivés** | Normaliser par les scrutins postérieurs à leur entrée en fonction, pas par le total de la législature. |
| **Polarités contradictoires dans un même scrutin** | Un texte peut servir la promesse A et trahir la promesse B. La moyenne (étape 2) les annule. C'est du signal, pas du bruit : l'exposer dans le Mode Expert comme « arbitrage » plutôt que de le dissoudre. |

### 4.5 Où calculer

Une fonction PL/pgSQL `refresh_scores()` appelée en fin d'ETL, plutôt qu'en TypeScript : c'est un `INSERT … SELECT` avec `GROUP BY`, la base le fera en quelques centaines de ms, et le calcul reste **auditable par n'importe qui ayant accès au schéma** — argument de neutralité qui est aussi un argument produit.

---

## 5. Comment prouver que le score est fiable

Sans mesure, « fiable » est une opinion. Protocole minimal, réalisable en une journée :

1. **Jeu de référence (gold standard)** : annoter à la main 150-200 couples (scrutin, promesse), stratifiés par groupe et par thème, dont une part de non-liens. C'est le seul investissement manuel incompressible.
2. **Métriques du mapping** : précision, rappel, F1 sur « ce scrutin concerne-t-il cette promesse ? ». La borne d'alerte est basse : la classification zero-shot de texte politique par LLM peut descendre à des F1 très faibles sans prompt calibré ([Political DEBATE, *Political Analysis*](https://www.cambridge.org/core/journals/political-analysis/article/political-debate-efficient-zeroshot-and-fewshot-classifiers-for-political-text/8D0B3E2AAF711F4812E42466DE503A13)).
3. **Métrique de la polarité** : exactitude sur ±1, conditionnellement à un mapping correct. C'est le chiffre qui compte le plus, car une polarité inversée transforme un ☀️ en ⛈️.
4. **Stabilité** : rejouer deux fois le même corpus, mesurer l'alpha de Krippendorff entre les deux passes. À `temperature: 0` on doit être très haut ; si ce n'est pas le cas, le prompt est ambigu.
5. **Sensibilité** : recalculer les scores en faisant varier les choix éditoriaux (poids de l'abstention 0 / 0,5 / 1, `k` du shrinkage 5 / 8 / 15). Si le classement météo des groupes bascule, le score est trop fragile pour être publié tel quel — et ce test doit être refait à chaque évolution.
6. **Publier ces chiffres dans l'app.** Un F1 de 0,78 affiché honnêtement vaut infiniment mieux qu'un score muet. C'est aussi le meilleur bouclier contre l'accusation de partialité.

Sur le cadrage plus large, la référence académique est le [Comparative Party Pledges Project](https://comparativepledges.net/publications/) : leur définition d'un engagement — *une déclaration engageant un parti sur une action spécifique dont on peut déterminer clairement si elle a eu lieu* — est plus stricte que le filtre de `03-review-promesses.ts`, et vaut d'être adoptée telle quelle.

---

## 6. Plan d'action priorisé

### Sprint 1 — Débloquer ✅ **fait**

1. ✅ Corriger l'insertion `fact_scrutin` : ajouter `numero`, `titre`, `sort_adopte` (`sort.code === 'adopté'`), `legislature`, `url_an` ; mapper `objet` sur `objet.libelle`.
2. ✅ Corriger l'insertion `llm_classification` : `statut` → `statut_validation`, ajouter `modele_llm`. Passer en `upsert` sur `(scrutin_id, promesse_id)`, avec repli **ligne par ligne** pour qu'une erreur n'annule pas le lot.
3. ✅ Valider les `promesse_id` retournés contre la liste envoyée avant insertion (+ rejet des polarités `0` et des doublons).
4. ✅ Paginer tous les `select()` de l'ETL par `range()`.
5. ✅ Faire échouer l'ETL bruyamment : si `scrutins_inseres === 0` alors que `scrutins_traites > 0`, statut `error` dans `etl_run_log` et HTTP 500.

Correctifs supplémentaires nécessaires pour que le point 5 fonctionne, ou trop risqués pour être différés :

6. ✅ `etl_run_log` : l'INSERT visait 5 colonnes inexistantes (`dry_run`, `scrutins_traites`, `scrutins_inseres`, `classifications_inserees`, `erreur`) et omettait `run_type` (`NOT NULL`). **Même la journalisation des erreurs échouait** — l'ETL était totalement muet.
7. ✅ `syntheseVote.libelle` / `nbreSuffragesPour` / `nbreSuffragesContre` n'existent pas : remplacés par `sort.libelle` et `syntheseVote.decompte.*`. Le modèle recevait jusqu'ici « RÉSULTAT : inconnu (0 pour, 0 contre) » sur **100 %** des scrutins.
8. ✅ `prompt_hash` : vrai SHA-256 (64 caractères) du couple (modèle, prompt système) au lieu d'un `btoa()` tronqué à 32.
9. ✅ Tri chronologique des scrutins **avant** application de `max_scrutins` (le ZIP est ordonné `V1, V10, V100…` : le plafond découpait un sous-ensemble arbitraire).
10. ✅ `llm_traite` désormais positionné même quand aucun lien n'est trouvé, et laissé à `false` si l'appel Gemini échoue (rejouable).
11. ✅ Erreurs d'insertion des votes remontées au lieu d'être ignorées ; parsing de `nonVotantsVolontaires` ajouté.

**Architecture** : la logique pure (types AN, normalisation, construction des lignes, validation des sorties LLM) est extraite dans `supabase/functions/etl-nightly/lib.ts`, sans aucune dépendance externe. Elle est donc importable à la fois par la Edge Function (Deno) et par un script de vérification local, ce qui rend l'ETL testable **sans base ni appel LLM**.

**Vérification** — `npx tsx scripts/04-verify-etl-mapping.ts` rejoue le mapping sur le corpus réel :

```
29/29 contrôles OK sur 8434 scrutins
  ✅ Colonnes NOT NULL de fact_scrutin            les 7 colonnes NOT NULL sont renseignées
  ✅ Toutes les valeurs de sort.code reconnues    repli utilisé 0×
  ✅ sort_adopte cohérent avec l'annonce          0 désaccord
  ✅ Aucun votant perdu à l'extraction            1 270 476 extraits / 1 270 476 attendus
  ✅ Résultat du vote toujours renseigné          0 "inconnu"
  ✅ promesse_id halluciné / doublon rejetés
```

Restent volontairement hors périmètre du Sprint 1, et toujours signalés par un commentaire dans le code : `groupe_id_au_moment_du_vote` (groupe actuel, à résoudre via l'historique — Sprint 2), la file d'attente persistante remplaçant `max_scrutins` (Sprint 2), et la migration de modèle (§8).

### Sprint 2 — Fiabiliser l'entrée ✅ **fait**

6. ✅ `type_vote`, `libelle_type_vote`, `categorie`, `dossier_ref`, `dossier_libelle`, `demandeur`, `eligible` ajoutés à `fact_scrutin`. Filtre du §4.2 appliqué **avant** tout appel LLM.
7. ✅ File d'attente persistante : le plafond par run ne fait plus perdre de scrutins.
8. ✅ `dim_promesse` dédupliquée (promesses canoniques + table `promesse_groupe`).
9. ✅ `par_delegation` persisté, `miseAuPoint` appliquées, `groupe_id_au_moment_du_vote` résolu via l'historique.
10. ✅ Pré-filtrage thématique lexical des promesses candidates avant l'appel Gemini.

**Migration** : `supabase/migrations/20260725120000_sprint2_corpus_et_promesses.sql` (idempotente, rejouable).

**ETL en deux phases découplées**, reliées par une file d'attente en base :

| Phase | Rôle | Coût |
|---|---|---|
| 1 — Ingestion | ZIP AN → `fact_scrutin` (avec `eligible`) + `fact_vote_individuel` | Aucun appel LLM |
| 2 — Classification | Lit `eligible = true AND llm_traite = false`, du plus ancien au plus récent | Gemini |

Un scrutin ingéré mais non classifié reste dans la file jusqu'à traitement effectif, quel que soit le nombre de runs nécessaires. Le paramètre `LOOKBACK_DAYS` passe à `0` (aucune limite de date) : la file rend la fenêtre glissante inutile — et c'est elle qui provoquait la perte définitive de scrutins.

**Corpus retenu — mesuré sur les 8 434 scrutins réels :**

| Catégorie | Total | Éligibles |
|---|---|---|
| Solennel | 72 | **72** |
| Motion de censure | 23 | **23** |
| Vote final « l'ensemble … » | 157 | **157** |
| Motion de procédure | 57 | **57** |
| Autre (votes sur articles) | 904 | **889** |
| **Amendement** | **7 221** | **0** |
| **Total** | **8 434** | **1 198 (14,2 %)** |

Deux corrections issues de la confrontation aux données réelles, absentes de la spécification initiale :

- **Apostrophe typographique** : 541 titres utilisent U+2019 au lieu de l'apostrophe ASCII. Sans normalisation, 24 votes sur « l'ensemble » d'un texte échappaient au filtre. Une régression est désormais couverte par le contrôle 7.
- **Votes de gestion de séance** : la règle du §4.2 laissait passer 14 votes de pure procédure (« prolonger la séance en cours au-delà de vingt heures ») car ils portent un `dossier_ref`. Exclusion ciblée ajoutée — formulée étroitement, car « réserve » seul attrapait la « réserve communale de sécurité civile », qui est un vrai texte de loi.

**Vérification** — 45 contrôles, toujours hors ligne :

```
45/45 contrôles OK sur 8434 scrutins
  ✅ Aucun amendement déclaré éligible               0
  ✅ Corpus éligible entre 5 % et 25 %               1198 (14,2 %)
  ✅ Votes « l'ensemble » avec apostrophe U+2019     24/24 captés
  ✅ Votes par délégation détectés                   191 629 (15,1 %)
  ✅ Mises au point extraites                        1 366 scrutins, 1 845 votes rectifiés
  ✅ Groupe résolu à la date du vote                 avant / après changement
  ✅ Pré-filtrage thématique                         36 promesses envoyées en moyenne au lieu de 300
```

**Réserve honnête sur le pré-filtrage** : le taux de détection thématique est de 100 % sur le corpus, ce qui mesure le *rappel* mais pas la *précision*. Les mots-clés n'ont pas encore été confrontés à de vraies promesses — seulement à un jeu synthétique. La qualité réelle du filtre ne sera établie que par le jeu de référence du Sprint 4. En cas de doute, le repli envoie toutes les promesses : un lien manqué coûte plus cher que quelques milliers de tokens.

**Choix éditorial appliqué** : les mises au point ne remplacent pas le vote officiel. `position_vote` conserve le vote consigné, `position_vote_corrigee` porte la rectification. Le score utilisera `COALESCE(position_vote_corrigee, position_vote)`, et le Mode Expert pourra afficher les deux.

Le Context Cache Gemini a été retiré : avec le pré-filtrage, chaque appel porte sur un jeu de promesses différent, le cache n'a plus d'objet. Cela supprime au passage le chemin de repli buggé signalé au §8.4.

### Sprint 3 — Le score ✅ **fait**

11. ✅ `refresh_scores()` en PL/pgSQL selon le §4.3 : `n_eff`, rétrécissement bayésien, intervalle de confiance, seuil de publication.
12. ✅ Catégorie météo 🌫️ « Brouillard » (`label_meteo()`), affichée dès que `publiable = false`.
13. ✅ **Présence** et **Couverture** calculées et stockées séparément de la cohérence.

**Migration** : `supabase/migrations/20260725140000_sprint3_calcul_des_scores.sql`.

Le calcul vit en SQL et non en TypeScript : quiconque a accès au schéma peut le relire et refaire le calcul. C'est un argument de neutralité autant qu'un choix technique. L'ETL l'appelle en phase 3 via `supabase.rpc("refresh_scores")`.

Les paramètres éditoriaux sont **exposés en arguments de la fonction** (`p_poids_abstention`, `p_k_shrinkage`, `p_seuil_depute`…), ce qui rend l'analyse de sensibilité du §5.5 exécutable en une requête.

#### Deux écarts assumés avec la spécification

**1. Intervalle de Wilson au lieu d'un bootstrap.** Le §4.3 prévoyait un bootstrap. Le premier jet utilisait l'erreur-type de la moyenne pondérée — et le test l'a démenti : un député dont les 12 votes sont tous alignés a une variance d'échantillon **nulle**, donc un IC de largeur zéro. C'est exactement la surconfiance que l'intervalle devait empêcher.

Le score étant un taux d'alignement (`p = (score_brut + 1)/2`, soit `score_0_100/100`), l'intervalle de Wilson est la méthode standard, correcte aux bornes, déterministe et calculable en SQL pur :

| Député | n_eff | Score | IC — erreur-type | IC — Wilson |
|---|---|---|---|---|
| d9001 (12 votes identiques) | 12 | 82 | **[75, 75]** ❌ | **[61, 93]** ✅ |
| d9005 (1 vote) | 1 | 55 | [55, 55] ❌ | [26, 81] ✅ |
| d9004 (12 votes partagés) | 12 | 52 | [25, 81] | [32, 72] |

**2. `refresh_scores()` rendue ré-entrante.** `CREATE TEMP TABLE … ON COMMIT DROP` ne libère les tables qu'au commit : deux appels dans une même transaction échouaient — précisément ce que fait l'analyse de sensibilité. Bug trouvé par le test, corrigé par des `DROP TABLE IF EXISTS` explicites.

#### Vérification exécutée

Docker n'étant pas disponible sur ce poste, les migrations et les tests ont été exécutés sur **PostgreSQL 18 réel via PGlite** (Postgres compilé en WebAssembly, sans Docker). Le schéma complet + les trois migrations s'appliquent proprement, et `supabase/tests/test_refresh_scores.sql` passe intégralement.

Le jeu d'essai est construit pour que chaque valeur attendue soit calculable à la main :

| Cas | Vérifie | Attendu | Obtenu |
|---|---|---|---|
| d9001 — 12 votes alignés | cohérence maximale + rétrécissement | 100 → 82 | ✅ |
| d9002 — 12 votes opposés | opposition totale | 0 → 22 | ✅ |
| d9003 — 12 abstentions | abstention à demi-poids | n_eff = 6 → 🌫️ | ✅ |
| d9005 — scrutin lié à 2 promesses opposées | agrégation intra-scrutin | n_eff = 1, pas 2 | ✅ |
| d9006 — scrutin solennel | pondération ×3 | n_eff = 3 | ✅ |
| d9007 — motion de censure | exclue du score | aucune ligne | ✅ |
| d9008 — vote rectifié | mise au point appliquée | score 100 | ✅ |
| d9009 — classification brouillon | ignorée | aucune ligne | ✅ |
| d9010 — transfuge | évalué sur le groupe du moment du vote | 1 ligne | ✅ |
| Couverture | promesses testées / totales | 2/3 | ✅ |
| Météo | 8 bornes + brouillard | — | ✅ |

#### Analyse de sensibilité — premier résultat

Sur le jeu d'essai, en faisant varier les arbitrages du §7 :

| Variante | Score groupe | Météo groupe | d9001 | d9003 |
|---|---|---|---|---|
| Référence (abst. 0,5 / k=8) | 55 | nuage | soleil | 🌫️ |
| Abstention ignorée (0) | 56 | nuage | soleil | *(exclu)* |
| Abstention pleine (1) | 55 | nuage | soleil | **nuage** |
| Rétrécissement faible (k=5) | 55 | nuage | soleil | 🌫️ |
| Rétrécissement fort (k=15) | 55 | nuage | **éclaircies** | 🌫️ |

La météo de **groupe** est stable sur toutes les variantes — c'est le résultat rassurant. En revanche deux basculements individuels apparaissent : d9003 sort du brouillard quand l'abstention pèse 1 (son `n_eff` passe de 6 à 12 et franchit le seuil), et d9001 perd son soleil avec un rétrécissement fort. **Les arbitrages éditoriaux ont donc un effet visible au niveau député.** Ce test devra être rejoué sur données réelles avant toute publication : si le classement des groupes bascule, le score est trop fragile pour être publié en l'état.

#### Validation sur la vraie stack Supabase locale

Rejouée ensuite sur **PostgreSQL 17.6** via `npx supabase start` + `db reset` (Docker). Trois défauts que PGlite ne pouvait pas révéler :

**1. `supabase/migrations/` n'était pas autosuffisant.** `civic_tech.sql` vit à la racine du dépôt et n'est jamais joué par le CLI. Sur un projet Supabase **neuf**, `db push` aurait appliqué uniquement les migrations Sprint 2 et 3, et la première (`ALTER TABLE dim_promesse`) aurait échoué : la table n'existe pas. Corrigé par `00000000000000_init_schema.sql`, reprise idempotente de `civic_tech.sql` (16 clés étrangères nommées et gardées). Le dossier part désormais d'une base vide et supporte le rejeu complet.

**2. `refresh_scores()` échouait via PostgREST.** Supabase active `pg_safeupdate` sur les connexions de l'API, qui rejette tout `DELETE` sans `WHERE`. L'ETL appelant la fonction par `supabase.rpc("refresh_scores")`, la phase 3 aurait échoué en production avec le code `21000` — alors qu'elle passait en SQL direct. Corrigé par `DELETE … WHERE true`.

**3. Aucune politique RLS n'existait — la base était ouverte en écriture publique.** 🔴 *(corrigé)*

Les 14 tables ont `rowsecurity = false`. Les tables créées par migration SQL n'ont pas RLS activé par défaut (contrairement à celles créées depuis le tableau de bord). Vérifié avec le rôle `anon`, celui de la clé publique embarquée dans le bundle navigateur :

| Action tentée avec la seule clé publique | Résultat |
|---|---|
| Lire les classifications en `brouillon` | **autorisé** |
| Passer une classification non validée en `publie` | **autorisé** |
| Réécrire directement `cache_score_groupe` | **autorisé** |
| `DELETE FROM fact_vote_individuel` | **autorisé** |
| Appeler `refresh_scores()` | **autorisé** |

C'était la négation du principe fondateur « l'IA propose, l'humain valide » : n'importe qui pouvait publier une classification que personne n'avait relue, ou réécrire les notes affichées. `AGENT.md` présentait pourtant la RLS comme centrale — elle n'avait simplement jamais été écrite.

**Corrigé** par `20260725160000_rls_politiques_acces.sql`, sur une stratégie de refus par défaut : RLS activée sur les 14 tables, droits d'écriture révoqués pour `anon`/`authenticated` (seconde barrière si une politique trop permissive était ajoutée un jour), puis politiques `SELECT` explicites pour ce qui est réellement public.

| Table | Accès public |
|---|---|
| `dim_groupe`, `dim_depute`, `dim_theme`, `dim_depute_groupe_historique` | lecture intégrale |
| `fact_scrutin`, `fact_vote_individuel` | lecture intégrale (données ouvertes AN) |
| `cache_score_groupe`, `cache_score_depute` | lecture intégrale, y compris `publiable = false` pour permettre l'affichage 🌫️ |
| `dim_promesse`, `promesse_groupe` | **uniquement** `est_canonique` et `statut ∈ (auto, valide, active)` |
| `llm_classification` | **uniquement** `statut_publication = 'publie'` |
| `etl_run_log` | aucun accès (coûts d'API, traces d'erreur) |
| `user_preferences`, `user_alertes` | propriétaire uniquement (`auth.uid()`) |
| `v_alignement`, `refresh_scores()` | `service_role` uniquement |

Deux pièges traités au passage : la vue `v_alignement` expose les classifications sans filtre de publication et s'exécutait avec les droits de son propriétaire (`security_invoker = true` + révocation) ; et `refresh_scores()` était appelable par `POST /rest/v1/rpc/refresh_scores` avec la seule clé publique.

**Vérification** — `supabase/tests/test_rls.sql` rejoue chaque attaque avec le rôle `anon`. 20 contrôles, tous verts :

```
OK — anon ne voit AUCUN brouillon                     (0)
OK — anon ne voit que les promesses validees          (1)
OK — anon ne voit pas le journal ETL                  (0)
OK — anon ne peut PAS publier une classification      (refuse)
OK — anon ne peut PAS reecrire les scores             (refuse)
OK — anon ne peut PAS supprimer les votes             (refuse)
OK — anon ne peut PAS injecter/falsifier une promesse (refuse)
OK — anon ne peut PAS declencher refresh_scores()     (refuse)
OK — anon ne peut PAS lire la vue v_alignement        (refuse)
OK — anon ne peut PAS vider une table                 (refuse)
OK — service_role contourne RLS (ETL + admin intacts) (t)
```

Confirmé aussi au niveau HTTP : `POST /rest/v1/rpc/refresh_scores` renvoie **401** avec la clé publique et **200** avec la clé de service.

#### La route `/admin` n'avait aucune authentification 🔴 *(corrigé)*

La RLS ne pouvait pas fermer ce trou, et ne le pouvait pas par construction : `src/lib/supabase/server.ts` instancie le client avec `SUPABASE_SERVICE_ROLE_KEY`, qui possède `BYPASSRLS` — c'est précisément ce qui fait fonctionner l'administration. Or il n'existait **ni middleware, ni vérification de session** dans `src/app/admin/` : n'importe qui connaissant l'URL pouvait valider ou retirer des promesses en production.

**Corrigé** par `20260725180000_admin_authentification.sql` + une couche applicative Next.js.

*Source d'autorisation* : table `admin_utilisateur`, plutôt qu'une variable d'environnement — la liste est auditable, modifiable sans redéploiement, et la vérification passe par la RLS, donc démontrable par un test. Une politique ne laisse voir à un utilisateur que sa propre ligne active ; personne ne peut lire la liste complète ni s'y ajouter.

*Trois barrières indépendantes*, parce qu'aucune ne suffit seule :

| Barrière | Rôle | Limite |
|---|---|---|
| `src/middleware.ts` | redirige un visiteur non authentifié | Ne protège pas les Server Actions, et un middleware Next a déjà été contourné (CVE-2025-29927) |
| `requireAdmin()` dans chaque page | bloque le rendu | — |
| `requireAdmin()` dans **chaque Server Action** | **le vrai contrôle** | — |

Ce dernier point est l'essentiel : une Server Action est un point d'entrée HTTP à part entière, appelable sans passer par l'interface. Les trois actions de `promesses/actions.ts` écrivent avec la clé de service : sans vérification propre, le middleware ne les couvrait pas.

Deux détails qui comptent : `getUser()` est utilisé partout plutôt que `getSession()` — cette dernière lit le cookie sans le valider auprès de Supabase, donc un cookie forgé passerait ; et le paramètre `?suite=` est restreint aux chemins internes commençant par `/admin`, pour éviter une redirection ouverte.

**Vérification de bout en bout**, sur la stack locale avec deux comptes réels :

| Scénario | Résultat |
|---|---|
| Visiteur non authentifié → `/admin`, `/admin/promesses` | 307 vers `/admin/login?suite=…` |
| Compte Supabase valide **mais absent** de `admin_utilisateur` | refusé, session immédiatement refermée |
| Le même, tentant ensuite `/admin/promesses` directement | renvoyé à la connexion |
| Compte autorisé | accès accordé, redirigé vers la page demandée |
| Déconnexion | retour à la page de connexion |

Et au niveau de la base, via de vrais jetons JWT : l'administrateur voit sa ligne, un utilisateur authentifié quelconque voit `[]`, un visiteur anonyme reçoit `permission denied`. Un accès révoqué (`actif = false`) cesse immédiatement d'être visible.

`supabase/tests/test_rls.sql` couvre désormais **24 contrôles**, dont l'autorisation d'administration.

**Amorçage** — le premier administrateur ne peut pas se créer lui-même, sinon la porte resterait ouverte. Procédure manuelle documentée dans la migration : créer l'utilisateur depuis le tableau de bord Supabase (sans activer l'inscription publique), puis l'insérer dans `admin_utilisateur`.

#### Écart de schéma corrigé au passage

Le test a révélé que **`civic_tech.sql` a divergé du schéma réellement utilisé** : il lui manque `dim_promesse.dedupe_hash` et `source_pdf_annee` (tous deux écrits par `02-extract-promesses.ts`), et `statut` y est `NOT NULL` alors que `02` y insère `NULL` et que `03` filtre précisément sur `NULL`. Un tiers reconstruisant la base depuis le dépôt n'obtenait donc pas le schéma de production — ce qui contredit frontalement l'objectif de vérifiabilité. Corrigé par `supabase/migrations/20260725100000_baseline_alignement_schema.sql`, entièrement conditionnelle (no-op sur la base de production).

### Sprint 4 — Prouver (1 à 2 jours)

14. Constituer le gold standard (150-200 couples).
15. Script `04-evaluate-classifications.ts` : F1 mapping, exactitude polarité, alpha inter-passes, analyse de sensibilité.
16. Passer la classification en double passe, `auto` uniquement sur accord.
17. Publier la méthodologie et les métriques dans une page `/methodologie`.

---

## 7. Les 6 arbitrages éditoriaux — recommandations argumentées

Ces choix conditionnent le score et doivent être arrêtés **puis publiés**. C'est ce qui fait la différence entre un baromètre et une opinion. Recommandation pour chacun, avec le raisonnement.

### 7.1 Abstention → **neutre à demi-poids** (`A = 0`, `w = 0,5`)

| Option | Effet | Verdict |
|---|---|---|
| Ignorée (hors numérateur *et* dénominateur) | L'abstention devient invisible | ❌ L'abstention est précisément la façon d'esquiver un engagement sans trahison visible. L'ignorer, c'est laisser passer la stratégie la plus courante. |
| Pénalisée (`A = -1` ou `-0,5`) | Assimilée à une trahison | ❌ Indéfendable : on s'abstient légitimement sur un texte qui mêle une mesure conforme et une mesure contraire. |
| **Neutre à demi-poids** | Contribue 0 au numérateur, 0,5 au dénominateur | ✅ **Retenu** |

**Pourquoi ça marche** : avec `score_brut = Σw·A / Σw`, une abstention tire mécaniquement le score vers 0, donc l'affichage vers 50/100 — la zone ☁️ **Nuages**. La propriété est élégante à expliquer au public : *« un groupe qui s'abstient systématiquement sur ses propres engagements finit sous les nuages, pas sous l'orage »*. C'est exactement la sémantique voulue.

**À ajouter obligatoirement** : un indicateur publié séparément, *« taux d'abstention sur ses propres engagements »*. La stratégie d'esquive devient ainsi une donnée factuelle affichée, pas un résidu dissous dans le composite.

### 7.2 Absence → **jamais dans la cohérence**, indicateur séparé limité aux solennels

Deux raisons de ne jamais la faire entrer dans le score de cohérence :

1. **Factuelle** : maladie, congé maternité, fonction ministérielle, mission parlementaire, déplacement officiel. Assimiler cela à une trahison d'engagement est faux, et juridiquement exposé.
2. **Technique** : **15 % des votes sont par délégation** (191 629 mesurés). Un député « présent » dans les données peut être physiquement absent. Le signal de présence est intrinsèquement bruité.

**Mais la présence doit être publiée**, comme indicateur autonome et **calculée uniquement sur les scrutins solennels**. Justification mesurée : la participation médiane y est de **92 %**, donc la norme est claire et un écart est signifiant. Sur les scrutins ordinaires (26 %), l'absence *est* la norme — un taux de présence y serait ininterprétable. C'est d'ailleurs la distinction qu'opère [Datan](https://datan.fr/statistiques/aide) entre participation aux solennels et participation à tous les votes.

**Précision de calcul** : exclure du dénominateur d'un député tout scrutin antérieur à son entrée en fonction ou postérieur à son départ.

### 7.3 Programmes communs → **on maintient, mais on change le statut de l'information**

Supprimer l'attribution reviendrait à priver **7 groupes sur 11** de toute promesse — plus de produit. Et ce serait factuellement faux : ces groupes *ont* fait campagne sur ces textes. Mais les deux cas ne se valent pas :

| Coalition | Solidité de l'attribution | Analyse |
|---|---|---|
| **NFP** → LFI-NFP, SOC, ECOS, GDR | Forte | Plateforme commune réellement signée, candidats investis sous label unique en juin 2024. C'est bien le document sur lequel ils ont fait campagne. |
| **Ensemble** → EPR, HOR, DEM | Plus faible | Horizons et le MoDem ont publié leurs propres supports et se sont distanciés à plusieurs reprises. |

**Recommandation** : garder l'attribution, mais la rendre **visible et qualifiée** plutôt que silencieuse.

- Ajouter `promesse_groupe.type_engagement ∈ {'programme_propre', 'programme_coalition'}`.
- Marqueur visuel distinct en UI + phrase explicite : *« engagement issu du programme commun X, sur lequel ce groupe a fait campagne »*.
- Quand les deux existent, publier **deux scores** : sur programme propre / sur programme de coalition. L'écart est en soi une information intéressante.

Le principe de divulgation progressive déjà inscrit dans la spec produit s'applique : on n'efface pas l'hypothèse, on la rend inspectable et on laisse le lecteur juger.

### 7.4 UDR et NI → deux traitements différents, aucun score inventé

- **NI (non-inscrits)** : par définition aucun programme commun. L'exclusion est déjà actée dans `AGENT.md` et elle est correcte. Affichage : *« pas de programme commun — score de cohérence non applicable »*. Les votes individuels de ces députés restent consultables factuellement, sans note.
- **UDR (UDDPLR)** : cas plus délicat. Le groupe s'est allié au RN pour les législatives 2024, mais **je n'ai pas trouvé de document de campagne publié en propre**. Lui attribuer le programme RN serait une hypothèse bien plus forte que le cas NFP (il n'existe pas de texte co-signé équivalent) — exactement le raccourci qui fait tomber un projet de neutralité.

**Recommandation** : **pas de score pour l'UDR en V1**. Afficher 🌫️ *« programme de campagne non disponible — nous n'avons pas identifié de document publié par ce groupe »*, avec un appel à contribution pour la source. C'est honnête, et cela transforme une lacune en signal de rigueur. À rouvrir si un document sourçable est identifié.

### 7.5 Seuil de publication → **n_eff ≥ 10** pour un député, **≥ 30** pour un groupe

La justification est purement mathématique, donc facile à défendre publiquement. Sur des valeurs dans `{-1, 0, +1}` d'écart-type ≈ 0,8 :

| n_eff | Erreur-type | IC 95 % sur l'échelle 0-100 |
|---|---|---|
| 5 | 0,36 | **± 36 points** — plus large que deux catégories météo |
| 10 | 0,25 | ± 25 points — une catégorie entière |
| 20 | 0,18 | ± 17 points |
| 50 | 0,11 | ± 11 points |

En dessous de 10, l'intervalle de confiance dépasse la largeur d'une catégorie météo : le score n'a **aucune valeur informative**, il ne fait qu'habiller du bruit. 10 est donc un plancher absolu, pas un confort ; **c'est à partir de ~20 que le score devient réellement lisible**.

Dans tous les cas : afficher `n_eff` à côté du score, et l'intervalle de confiance en Mode Expert. Sous le seuil → 🌫️ **Brouillard**, jamais un chiffre.

### 7.6 Amendements → **hors champ en V1**, réouverture ciblée en V2

Quatre raisons convergentes :

1. Le libellé seul est inexploitable (§1.2) — il faut joindre le jeu de données *Amendements* pour obtenir `dispositif` et `exposeSommaire`. La jointure passe par du parsing de texte libre (numéro + article + intitulé du texte) : fragile et coûteux à fiabiliser.
2. Participation médiane de 24 % → faible valeur au niveau député.
3. **C'est là que le vote tactique est le plus dense** : voter contre son propre amendement pour raisons de procédure, voter pour un amendement destiné à faire tomber le texte. Le rapport signal/bruit y est le pire de tout le corpus.
4. Les 1 213 scrutins non-amendements portent déjà le signal fort.

**V2 ciblée, pas exhaustive** : ne rouvrir que les amendements portant sur les dossiers ayant *déjà* fait l'objet d'un vote solennel ou d'un vote final. Ensemble bien plus petit, à forte valeur politique, et joignable proprement via `dossierRef`.

---

## 8. Choix du modèle IA — le contexte a changé

### 8.1 Alerte immédiate : les modèles utilisés s'arrêtent le 16 octobre 2026

D'après la [page officielle des dépréciations Google](https://ai.google.dev/gemini-api/docs/deprecations) :

| Modèle | Utilisé dans | Date d'arrêt | Remplaçant officiel |
|---|---|---|---|
| `gemini-2.5-flash-lite` | `etl-nightly:378,521,550`, `03-review:157` | **16 oct. 2026** | `gemini-3.1-flash-lite` |
| `gemini-2.5-flash` | `02-extract:206` | **16 oct. 2026** | `gemini-3.6-flash` |

Dans moins de trois mois, l'intégralité du pipeline cesse de fonctionner. Les coûts sont eux aussi codés en dur (`etl-nightly:583`, `02-extract:242`) et déjà faux.

### 8.2 Catalogue actuel (juillet 2026, prix officiels Google)

| Modèle | Input $/M | Output $/M | Cache read | Statut |
|---|---|---|---|---|
| `gemini-2.5-flash-lite` | 0,10 | 0,40 | 0,01 | ⚠️ arrêt 16 oct. 2026 |
| `gemini-3.1-flash-lite` | 0,25 | 1,50 | — | GA, remplaçant de 2.5 FL |
| `gemini-3.5-flash-lite` | 0,30 | 2,50 | 0,03 | Sorti le 21 juil. 2026 |
| `gemini-2.5-flash` | 0,30 | 2,50 | 0,03 | ⚠️ arrêt 16 oct. 2026 |
| `gemini-3.5-flash` | 1,50 | 9,00 | 0,15 | GA (19 mai 2026) |
| `gemini-3.6-flash` | 1,50 | 7,50 | 0,15 | Sorti le 21 juil. 2026 |

Deux faits utiles : le **Batch API** offre **-50 %** avec un SLA de 24 h — parfait pour un ETL nocturne sans contrainte de latence. Et `gemini-3.6-flash` consomme **17 % de tokens de sortie en moins** que 3.5 Flash tout en étant moins cher.

### 8.3 Le raisonnement décisif : le coût n'est plus le critère

L'architecture d'origine imposait Flash-Lite partout à cause du budget < 5 €/mois. Ce raisonnement supposait 8 434 scrutins à classifier. **Avec le corpus filtré à 1 213 scrutins (§4.2), la contrainte disparaît.**

Estimation pour le backfill complet de la législature, en double passe, avec pré-filtrage à ~30 promesses candidates (≈ 2 500 tokens in / 300 tokens out par appel) :

| Modèle | Backfill complet (une fois) | Régime de croisière |
|---|---|---|
| `gemini-3.1-flash-lite` | ~2,60 $ (1,30 $ en Batch) | ~0,10 $/mois |
| `gemini-3.5-flash-lite` | ~3,65 $ (1,80 $ en Batch) | ~0,15 $/mois |
| `gemini-3.6-flash` | ~14,60 $ (7,30 $ en Batch) | ~0,60 $/mois |

**Le modèle le plus cher coûte 12 $ de plus, une seule fois, et 0,50 $/mois de plus.** Le budget est préservé dans tous les cas. Le critère de choix redevient donc ce qu'il aurait toujours dû être : **la justesse**, car une polarité inversée transforme un ☀️ en ⛈️ et détruit la crédibilité du projet.

### 8.4 Recommandation par tâche

| Tâche | Modèle recommandé | Justification |
|---|---|---|
| **Extraction PDF** (`02-extract`) | **`gemini-3.6-flash`** | C'est la *ground truth* de tout le système. Une promesse mal extraite contamine tous les scores en aval. One-shot sur ~7 documents, coût ≈ 2 $. Aucune raison d'économiser ici. |
| **Classification — passe A** (ETL) | **`gemini-3.6-flash`** | La tâche la plus difficile et la plus lourde de conséquences du pipeline. |
| **Classification — passe B** (ETL) | **`gemini-3.5-flash-lite`** | Deuxième avis avec un modèle **d'une famille différente** : les erreurs sont bien moins corrélées qu'entre deux appels du même modèle. L'accord inter-modèles est un estimateur de confiance nettement plus solide que la `confidence` auto-déclarée (§3.3). Désaccord → `/admin`. |
| **Relecture qualité promesses** (`03-review`) | **`gemini-3.5-flash-lite`** | Contrôle formel (neutralité, concordance, concrétude). Tâche simple, volume élevé. |
| **Pré-filtrage des promesses candidates** | **aucun LLM** | Filtre lexical par thème, ou embeddings. Réduit ~1 000 promesses à 20-40 candidates : améliore simultanément rappel, précision et coût. |

**À supprimer** : le Context Cache. Avec le pré-filtrage, chaque appel porte sur un jeu de promesses différent — le cache perd sa raison d'être. Il apporte aujourd'hui un chemin de code de repli buggé (`index.ts:547-565`) pour une économie de quelques centimes. Le retirer est un gain net de fiabilité.

**À ajouter** : passer les appels par le **Batch API** (-50 %, SLA 24 h), parfaitement compatible avec un traitement nocturne — et qui supprime au passage la pression sur les rate limits du free tier.

---

## Sources

- [Data Assemblée nationale — portail open data](https://data.assemblee-nationale.fr/)
- [Votes et scrutins — Opendata AN](https://data.assemblee-nationale.fr/travaux-parlementaires)
- [Tous les amendements — Opendata AN](https://data.assemblee-nationale.fr/travaux-parlementaires/amendements/tous-les-amendements)
- [Datan — Les statistiques expliquées (loyauté, participation, Agreement Index)](https://datan.fr/statistiques/aide)
- [Datan — La loyauté politique des députés](https://datan.fr/statistiques/deputes-loyaute)
- [Comparative Party Pledges Project — publications](https://comparativepledges.net/publications/)
- [Thomson et al., *The Fulfillment of Parties' Election Pledges*, AJPS 2017](https://ajps.org/2017/06/07/the-fulfillment-of-parties-election-pledges-a-comparative-study-on-the-impact-of-power-sharing/)
- [*Political DEBATE: Efficient Zero-Shot and Few-Shot Classifiers for Political Text*, Political Analysis](https://www.cambridge.org/core/journals/political-analysis/article/political-debate-efficient-zeroshot-and-fewshot-classifiers-for-political-text/8D0B3E2AAF711F4812E42466DE503A13)
- [*On Verbalized Confidence Scores for LLMs*](https://arxiv.org/html/2412.14737v2)
- [*Assessing and Mitigating Miscalibration in LLM-Based Social Science Measurement*](https://arxiv.org/html/2605.11954v1)
- [*Semantic stability protocol: intercoder reliability for zero-shot classification*, Quality & Quantity](https://link.springer.com/article/10.1007/s11135-026-02832-9)
- [Supabase — limite par défaut de 1 000 lignes par requête](https://supabase.com/docs/reference/javascript/limit)
- [Gemini API — tarifs officiels](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API — calendrier des dépréciations](https://ai.google.dev/gemini-api/docs/deprecations)
- [Google — annonce Gemini 3.6 Flash, 3.5 Flash-Lite et 3.5 Flash Cyber (21 juillet 2026)](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/)
- [Google — Gemini 3.1 Flash-Lite](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/)
- [VentureBeat — Gemini 3.6 Flash cuts agent token costs](https://venturebeat.com/technology/googles-gemini-3-6-flash-model-cuts-ai-agent-token-costs-by-up-to-65-on-long-horizon-engineering-tasks-and-3-5-pro-is-on-the-way)
