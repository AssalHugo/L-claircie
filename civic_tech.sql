CREATE TABLE "dim_groupe" (
  "id" SERIAL PRIMARY KEY,
  "uid_officiel" varchar(20) UNIQUE NOT NULL,
  "sigle" varchar(20) UNIQUE NOT NULL,
  "nom_complet" varchar(200) NOT NULL,
  "couleur_hex" char(7) NOT NULL,
  "nb_sieges" smallint NOT NULL,
  "actif" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "dim_depute" (
  "id" SERIAL PRIMARY KEY,
  "uid_an" varchar(20) UNIQUE NOT NULL,
  "nom" varchar(100) NOT NULL,
  "prenom" varchar(100) NOT NULL,
  "groupe_id" int NOT NULL,
  "departement" varchar(100) NOT NULL,
  "num_circo" smallint NOT NULL,
  "profession" varchar(200),
  "photo_url" varchar(500),
  "actif" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "dim_depute_groupe_historique" (
  "id" SERIAL PRIMARY KEY,
  "depute_id" int NOT NULL,
  "groupe_id" int NOT NULL,
  "date_debut" date NOT NULL,
  "date_fin" date
);

CREATE TABLE "dim_theme" (
  "id" SERIAL PRIMARY KEY,
  "slug" varchar(50) UNIQUE NOT NULL,
  "label" varchar(100) NOT NULL,
  "emoji" char(4),
  "ordre" smallint
);

CREATE TABLE "dim_promesse" (
  "id" SERIAL PRIMARY KEY,
  "groupe_id" int NOT NULL,
  "theme_id" int NOT NULL,
  "intitule_court" varchar(200) NOT NULL,
  "description_longue" text,
  "source_pdf_nom" varchar(200) NOT NULL,
  "source_pdf_page" smallint NOT NULL,
  "source_citation" text NOT NULL,
  "statut" varchar(20) NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "fact_scrutin" (
  "id" SERIAL PRIMARY KEY,
  "uid_an" varchar(50) UNIQUE NOT NULL,
  "numero" int NOT NULL,
  "legislature" smallint NOT NULL DEFAULT 17,
  "titre" varchar(500) NOT NULL,
  "objet" text NOT NULL,
  "expose_des_motifs" text,
  "date_scrutin" date NOT NULL,
  "sort_adopte" boolean NOT NULL,
  "url_an" varchar(500),
  "llm_traite" boolean NOT NULL DEFAULT false,
  "pertinent" boolean,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "fact_vote_individuel" (
  "id" SERIAL PRIMARY KEY,
  "depute_id" int NOT NULL,
  "scrutin_id" int NOT NULL,
  "groupe_id_au_moment_du_vote" int NOT NULL,
  "position_vote" smallint
);

CREATE TABLE "llm_classification" (
  "id" SERIAL PRIMARY KEY,
  "scrutin_id" int NOT NULL,
  "promesse_id" int NOT NULL,
  "polarite_llm" smallint NOT NULL,
  "confidence_score" numeric(3,2) NOT NULL,
  "statut_validation" varchar(20) NOT NULL DEFAULT 'auto',
  "statut_publication" varchar(20) NOT NULL DEFAULT 'brouillon',
  "modele_llm" varchar(50) NOT NULL,
  "prompt_hash" char(64) NOT NULL,
  "raisonnement_llm" text,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "cache_score_groupe" (
  "id" SERIAL PRIMARY KEY,
  "groupe_id" int NOT NULL,
  "theme_id" int,
  "score_0_100" smallint NOT NULL,
  "score_brut" numeric(7,4) NOT NULL,
  "nb_scrutins" int NOT NULL,
  "label_meteo" varchar(20) NOT NULL,
  "computed_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "cache_score_depute" (
  "id" SERIAL PRIMARY KEY,
  "depute_id" int NOT NULL,
  "theme_id" int,
  "score_0_100" smallint NOT NULL,
  "score_brut" numeric(7,4) NOT NULL,
  "nb_scrutins" int NOT NULL,
  "delta_vs_groupe" smallint,
  "computed_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "user_preferences" (
  "user_id" uuid PRIMARY KEY,
  "departement" varchar(100),
  "num_circo" smallint,
  "themes_favoris" int[],
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "user_alertes" (
  "id" SERIAL PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "groupe_id" int NOT NULL,
  "theme_id" int,
  "actif" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "etl_run_log" (
  "id" SERIAL PRIMARY KEY,
  "run_type" varchar(50) NOT NULL,
  "statut" varchar(20) NOT NULL,
  "nb_scrutins_nouveaux" int,
  "nb_classes" int,
  "nb_erreurs" int DEFAULT 0,
  "detail_erreur" text,
  "duree_ms" int,
  "cout_llm_usd" numeric(8,6),
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE INDEX "idx_groupe_sigle" ON "dim_groupe" ("sigle");

CREATE INDEX "idx_depute_uid_an" ON "dim_depute" ("uid_an");

CREATE INDEX "idx_depute_groupe" ON "dim_depute" ("groupe_id");

CREATE INDEX "idx_depute_circo" ON "dim_depute" ("departement", "num_circo");

CREATE INDEX "idx_histo_depute_date" ON "dim_depute_groupe_historique" ("depute_id", "date_debut");

CREATE INDEX "idx_promesse_groupe_theme" ON "dim_promesse" ("groupe_id", "theme_id");

CREATE INDEX "idx_promesse_statut" ON "dim_promesse" ("statut");

CREATE INDEX "idx_scrutin_uid_an" ON "fact_scrutin" ("uid_an");

CREATE INDEX "idx_scrutin_date" ON "fact_scrutin" ("date_scrutin");

CREATE INDEX "idx_scrutin_etl_queue" ON "fact_scrutin" ("llm_traite", "pertinent");

CREATE UNIQUE INDEX "uq_vote_depute_scrutin" ON "fact_vote_individuel" ("depute_id", "scrutin_id");

CREATE INDEX "idx_vote_scrutin_groupe" ON "fact_vote_individuel" ("scrutin_id", "groupe_id_au_moment_du_vote");

CREATE INDEX "idx_vote_groupe" ON "fact_vote_individuel" ("groupe_id_au_moment_du_vote");

CREATE UNIQUE INDEX "uq_classification_scrutin_promesse" ON "llm_classification" ("scrutin_id", "promesse_id");

CREATE INDEX "idx_classif_statut" ON "llm_classification" ("statut_publication", "statut_validation");

CREATE INDEX "idx_classif_confidence" ON "llm_classification" ("confidence_score");

CREATE UNIQUE INDEX "uq_score_groupe_theme" ON "cache_score_groupe" ("groupe_id", "theme_id");

CREATE INDEX "idx_score_groupe" ON "cache_score_groupe" ("groupe_id");

CREATE UNIQUE INDEX "uq_score_depute_theme" ON "cache_score_depute" ("depute_id", "theme_id");

CREATE INDEX "idx_score_depute" ON "cache_score_depute" ("depute_id");

CREATE INDEX "idx_score_delta" ON "cache_score_depute" ("delta_vs_groupe");

CREATE INDEX "idx_pref_circo" ON "user_preferences" ("departement", "num_circo");

CREATE UNIQUE INDEX "uq_alerte_user_groupe_theme" ON "user_alertes" ("user_id", "groupe_id", "theme_id");

CREATE INDEX "idx_etl_log_type_date" ON "etl_run_log" ("run_type", "created_at");

CREATE INDEX "idx_etl_log_statut" ON "etl_run_log" ("statut");

COMMENT ON COLUMN "dim_groupe"."uid_officiel" IS 'Code officiel AN, ex: ''PO717460'' — sert de clé pour les jointures avec les fichiers JSON de l''AN';

COMMENT ON COLUMN "dim_groupe"."sigle" IS 'Ex: ''RN'', ''EPR'', ''LFI-NFP'', ''SOC''';

COMMENT ON COLUMN "dim_groupe"."nom_complet" IS 'Ex: ''Rassemblement National''';

COMMENT ON COLUMN "dim_groupe"."couleur_hex" IS 'Ex: ''#003189'' — pour l''UI météo. Stocké en DB pour cohérence entre web et potentiels exports.';

COMMENT ON COLUMN "dim_groupe"."nb_sieges" IS 'Mis à jour manuellement si changement de composition';

COMMENT ON COLUMN "dim_groupe"."actif" IS 'false si le groupe est dissous en cours de législature';

COMMENT ON COLUMN "dim_depute"."uid_an" IS 'Identifiant technique de l''Assemblée nationale. Ex: ''PA719464''';

COMMENT ON COLUMN "dim_depute"."groupe_id" IS 'Groupe actuel. Voir dim_depute_groupe_historique pour les changements de groupe.';

COMMENT ON COLUMN "dim_depute"."departement" IS 'Ex: ''Paris'', ''Nord''';

COMMENT ON COLUMN "dim_depute"."num_circo" IS 'Ex: 3 pour la 3e circonscription';

COMMENT ON COLUMN "dim_depute"."profession" IS 'Optionnel, utile pour la fiche ''Mode Expert''';

COMMENT ON COLUMN "dim_depute"."photo_url" IS 'URL vers l''image officielle de l''AN ou Wikimedia';

COMMENT ON COLUMN "dim_depute"."actif" IS 'false si démission, décès, nomination au gouvernement';

COMMENT ON COLUMN "dim_depute_groupe_historique"."date_fin" IS 'NULL = groupe actuel';

COMMENT ON COLUMN "dim_theme"."slug" IS 'Ex: ''fiscalite'', ''immigration'', ''ecologie'', ''sante'', ''pouvoir-achat''';

COMMENT ON COLUMN "dim_theme"."label" IS 'Ex: ''Fiscalité'', ''Immigration'', ''Écologie''';

COMMENT ON COLUMN "dim_theme"."emoji" IS 'Ex: ''💰'', ''🌿'', ''🏥'' — pour l''UI onboarding utilisateur';

COMMENT ON COLUMN "dim_theme"."ordre" IS 'Ordre d''affichage dans l''onboarding';

COMMENT ON COLUMN "dim_promesse"."intitule_court" IS 'Ex: ''Retraite à 60 ans pour les carrières longues'' — affiché en UI';

COMMENT ON COLUMN "dim_promesse"."description_longue" IS 'Résumé étendu pour le Mode Expert';

COMMENT ON COLUMN "dim_promesse"."source_pdf_nom" IS 'Ex: ''Programme-RN-Legislatives-2024.pdf''';

COMMENT ON COLUMN "dim_promesse"."source_pdf_page" IS 'Numéro de page dans le PDF source';

COMMENT ON COLUMN "dim_promesse"."source_citation" IS 'Extrait textuel brut du programme (max 500 chars). Fourni par Gemini, validé manuellement. C''est la preuve inattaquable.';

COMMENT ON COLUMN "dim_promesse"."statut" IS 'ENUM logique: ''active'' | ''suspendue'' | ''retiree''. Une promesse ''retirée'' n''entre plus dans le calcul du score.';

COMMENT ON COLUMN "fact_scrutin"."uid_an" IS 'Ex: ''VTANR5L17V0842''. Clé d''idempotence pour l''ETL.';

COMMENT ON COLUMN "fact_scrutin"."numero" IS 'Numéro du scrutin dans la législature, ex: 842';

COMMENT ON COLUMN "fact_scrutin"."titre" IS 'Titre court du texte (champ ''titre'' du JSON AN)';

COMMENT ON COLUMN "fact_scrutin"."objet" IS 'Description de l''objet du vote (champ ''objet'' du JSON AN). Envoyé au LLM.';

COMMENT ON COLUMN "fact_scrutin"."expose_des_motifs" IS 'L''exposé des motifs est l''entrée principale pour la classification. NULL si absent du JSON.';

COMMENT ON COLUMN "fact_scrutin"."sort_adopte" IS 'true si le texte a été adopté. Issu du champ ''sort'' du JSON AN.';

COMMENT ON COLUMN "fact_scrutin"."url_an" IS 'Ex: ''https://www.assemblee-nationale.fr/dyn/17/scrutins/842''. Pour le lien ''Mode Expert''.';

COMMENT ON COLUMN "fact_scrutin"."llm_traite" IS 'Flag ETL : ce scrutin a-t-il déjà été envoyé au LLM pour classification ? Évite les doubles appels API.';

COMMENT ON COLUMN "fact_scrutin"."pertinent" IS 'NULL = non encore filtré. true = à classifier. false = scrutin procédural écarté par le filtre ETL.';

COMMENT ON COLUMN "fact_vote_individuel"."groupe_id_au_moment_du_vote" IS 'Dénormalisé intentionnellement. Groupe du député AU MOMENT DU VOTE.';

COMMENT ON COLUMN "fact_vote_individuel"."position_vote" IS '1=Pour, -1=Contre, 0=Abstention, NULL=Absent/Non-votant';

COMMENT ON COLUMN "llm_classification"."polarite_llm" IS '1 = ce vote, s''il est POUR, va dans le sens de la promesse. -1 = va à l''encontre.';

COMMENT ON COLUMN "llm_classification"."confidence_score" IS '0.00 à 1.00. Fourni par le LLM dans sa réponse JSON structurée.';

COMMENT ON COLUMN "llm_classification"."statut_validation" IS 'ENUM logique côté IA : ''auto'' (confiance >= 0.7), ''review'' (confiance < 0.7, en attente), ''valide'' (IA jugée correcte manuellement), ''rejete'' (faux positif écarté). Concerne la QUALITÉ de la classification.';

COMMENT ON COLUMN "llm_classification"."statut_publication" IS 'ENUM logique côté éditorial : ''brouillon'' (en attente de validation humaine), ''publie'' (approuvé, entre dans le calcul du score). Modifié via l''interface /admin.';

COMMENT ON COLUMN "llm_classification"."modele_llm" IS 'Ex: ''gemini-2.5-flash-lite''. Versioning pour audit.';

COMMENT ON COLUMN "llm_classification"."prompt_hash" IS 'SHA-256 du system prompt utilisé. Permet de retracer quelle version du prompt a produit ce résultat.';

COMMENT ON COLUMN "llm_classification"."raisonnement_llm" IS 'Chain-of-thought optionnel retourné par le modèle. Utile pour debug.';

COMMENT ON COLUMN "cache_score_groupe"."theme_id" IS 'NULL = score global multi-thématique';

COMMENT ON COLUMN "cache_score_groupe"."score_0_100" IS 'Score normalisé 0-100. Seuils météo: 0-30=Orage, 31-60=Nuage, 61-80=Éclaircies, 81-100=Soleil.';

COMMENT ON COLUMN "cache_score_groupe"."score_brut" IS 'Valeur réelle de la formule Σ(vote × polarité) / N. Téléchargeable pour vérification indépendante.';

COMMENT ON COLUMN "cache_score_groupe"."nb_scrutins" IS 'Dénominateur du score = nombre de scrutins pris en compte.';

COMMENT ON COLUMN "cache_score_groupe"."label_meteo" IS 'ENUM logique: ''soleil'' | ''eclaircies'' | ''nuage'' | ''orage''. Dérivé de score_0_100, stocké pour perf.';

COMMENT ON COLUMN "cache_score_groupe"."computed_at" IS 'Timestamp du dernier recalcul. Affiché en footer de l''UI pour transparence.';

COMMENT ON COLUMN "cache_score_depute"."theme_id" IS 'NULL = score global';

COMMENT ON COLUMN "cache_score_depute"."delta_vs_groupe" IS 'Différence score député - score groupe. Ex: +15 = député plus cohérent que son groupe. NULL si < 5 scrutins (pas statistiquement fiable).';

COMMENT ON COLUMN "user_preferences"."user_id" IS 'FK vers auth.users(id) de Supabase. Type UUID natif.';

COMMENT ON COLUMN "user_preferences"."departement" IS 'Ex: ''Bas-Rhin''. NULL si l''utilisateur n''a pas renseigné sa circo.';

COMMENT ON COLUMN "user_preferences"."num_circo" IS 'Ex: 2 pour la 2e circonscription du Bas-Rhin.';

COMMENT ON COLUMN "user_preferences"."themes_favoris" IS 'Array d''IDs de dim_theme. Ex: ARRAY[1, 3, 5]. Utilisé pour pondérer l''affichage du dashboard.';

COMMENT ON COLUMN "user_alertes"."user_id" IS 'FK logique vers auth.users(id). Pas de FK physique pour éviter les complications avec le schema auth.';

COMMENT ON COLUMN "user_alertes"."theme_id" IS 'NULL = alertes sur toutes thématiques pour ce groupe';

COMMENT ON COLUMN "etl_run_log"."run_type" IS 'Ex: ''daily_etl'', ''llm_classification'', ''score_refresh'', ''depute_sync''';

COMMENT ON COLUMN "etl_run_log"."statut" IS 'ENUM: ''running'' | ''success'' | ''partial'' | ''error''';

COMMENT ON COLUMN "etl_run_log"."nb_scrutins_nouveaux" IS 'Scrutins nouveaux détectés lors de ce run';

COMMENT ON COLUMN "etl_run_log"."nb_classes" IS 'Scrutins envoyés au LLM et classifiés';

COMMENT ON COLUMN "etl_run_log"."detail_erreur" IS 'Stack trace ou message d''erreur si statut = ''error''. NULL sinon.';

COMMENT ON COLUMN "etl_run_log"."duree_ms" IS 'Durée d''exécution en millisecondes. Utile pour détecter les dégradations de perf.';

COMMENT ON COLUMN "etl_run_log"."cout_llm_usd" IS 'Coût de l''appel API Gemini pour ce run. Calculé à partir des tokens consommés retournés par l''API.';

ALTER TABLE "dim_depute" ADD FOREIGN KEY ("groupe_id") REFERENCES "dim_groupe" ("id");

ALTER TABLE "dim_depute_groupe_historique" ADD FOREIGN KEY ("depute_id") REFERENCES "dim_depute" ("id");

ALTER TABLE "dim_depute_groupe_historique" ADD FOREIGN KEY ("groupe_id") REFERENCES "dim_groupe" ("id");

ALTER TABLE "dim_promesse" ADD FOREIGN KEY ("groupe_id") REFERENCES "dim_groupe" ("id");

ALTER TABLE "dim_promesse" ADD FOREIGN KEY ("theme_id") REFERENCES "dim_theme" ("id");

ALTER TABLE "fact_vote_individuel" ADD FOREIGN KEY ("depute_id") REFERENCES "dim_depute" ("id");

ALTER TABLE "fact_vote_individuel" ADD FOREIGN KEY ("scrutin_id") REFERENCES "fact_scrutin" ("id");

ALTER TABLE "fact_vote_individuel" ADD FOREIGN KEY ("groupe_id_au_moment_du_vote") REFERENCES "dim_groupe" ("id");

ALTER TABLE "llm_classification" ADD FOREIGN KEY ("scrutin_id") REFERENCES "fact_scrutin" ("id");

ALTER TABLE "llm_classification" ADD FOREIGN KEY ("promesse_id") REFERENCES "dim_promesse" ("id");

ALTER TABLE "cache_score_groupe" ADD FOREIGN KEY ("groupe_id") REFERENCES "dim_groupe" ("id");

ALTER TABLE "cache_score_groupe" ADD FOREIGN KEY ("theme_id") REFERENCES "dim_theme" ("id");

ALTER TABLE "cache_score_depute" ADD FOREIGN KEY ("depute_id") REFERENCES "dim_depute" ("id");

ALTER TABLE "cache_score_depute" ADD FOREIGN KEY ("theme_id") REFERENCES "dim_theme" ("id");

ALTER TABLE "user_alertes" ADD FOREIGN KEY ("groupe_id") REFERENCES "dim_groupe" ("id");

ALTER TABLE "user_alertes" ADD FOREIGN KEY ("theme_id") REFERENCES "dim_theme" ("id");
