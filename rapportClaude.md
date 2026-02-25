# Technical ecosystem for a French Civic Tech promise tracker

A solo developer can build a viable political promise-tracking app on free tiers — but must navigate sharp constraints. **No existing system automates promise-to-vote matching**, making this a genuine innovation opportunity. The core stack of Vercel Hobby + Supabase Free + Gemini API is feasible for an MVP, though Vercel's **2 daily-only cron jobs** and Supabase's **7-day pause policy** are the tightest bottlenecks. Gemini 2.5 Flash-Lite can handle the entire AI classification workload for **under $20/year**. The Assemblée nationale provides structured open data, but as bulk downloads — not a REST API. NosDéputés.fr fills that gap with a proper queryable API.

---

## Vercel Hobby plan: tight cron limits are the real constraint

Vercel's Hobby (free) tier is more generous than commonly assumed for compute, but severely restricted for scheduled jobs.

**Serverless functions** default to a 10-second timeout, but this is configurable. With Fluid Compute (now default for new functions), Hobby plan functions can run up to **300 seconds** — a major improvement from the previous 60-second cap. Fluid Compute bills only active CPU time, not I/O wait, so a function doing a 5-second API fetch against a 30-second wall-clock duration uses minimal quota. The monthly budget is **4 CPU-hours** and **1 million function invocations**, which is ample for a low-traffic civic tech app.

**Edge Functions** run on V8 isolates with sub-50ms cold starts (versus 100ms–3s for Node.js serverless functions). The Hobby bundle size limit is **1 MB** (vs. 2 MB on Pro). All plans share a 300-second execution duration cap.

**The critical constraint is cron jobs.** Hobby allows only **2 cron jobs total** across all projects, each limited to running **once per day** minimum. You cannot schedule hourly or more frequent jobs. This means if the app needs to poll the Assemblée nationale for new votes and also run a daily classification pipeline, those two crons are consumed entirely. Workaround: use Supabase's pg_cron (no such frequency restriction) to trigger Supabase Edge Functions instead.

Other Hobby limits worth noting: **100 GB/month bandwidth** (hard cap — account pauses, no overages), **100 deployments/day**, **1 concurrent build**, and **1-hour log retention**. The plan **prohibits commercial use** — even a non-profit generating revenue technically violates terms. Cold start protection ("scale to one") is Pro-only, so infrequently called functions will always cold-start on Hobby.

| Resource | Hobby | Pro ($20/mo) |
|---|---|---|
| Serverless timeout (Fluid Compute) | 300s | 800s |
| Cron jobs | **2, daily only** | 40, every minute |
| Bandwidth | 100 GB/mo | 1 TB/mo |
| Function invocations | 1M/mo | 10M/mo |
| CPU time | 4 hours/mo | ~40 hours/mo |
| Cold start protection | None | Scale-to-one |
| Commercial use | Prohibited | Allowed |

---

## Supabase Free tier: pg_cron is the hidden superpower

Supabase's free tier is surprisingly capable for this use case. The standout feature: **pg_cron is fully available on the free tier** with no frequency restrictions, supporting cron syntax down to 1-second intervals. Combined with pg_net for async HTTP calls, pg_cron can trigger Supabase Edge Functions on any schedule — effectively bypassing Vercel's cron limitation entirely.

**Edge Functions** allow **500,000 invocations/month** with a **2-second CPU time limit** per invocation and **150-second wall-clock duration**. For a classification pipeline processing 30-50 laws per day, this is more than sufficient. The free tier supports up to **100 Edge Functions** per project.

**Database storage** is capped at **500 MB** on the Nano compute instance (shared CPU, 0.5 GB RAM). For parliamentary data — deputies, votes, promises, classifications — 500 MB is adequate for years of data. Connection limits are **60 direct** and **200 pooled** (via Supavisor, available on all tiers).

The most annoying constraint is the **7-day inactivity pause policy**. Free-tier projects exhibiting "extremely low activity" over 7 days get paused automatically. Prevention is simple: a weekly pg_cron job hitting the database keeps the project alive. Paused projects are restorable for 90 days. The free tier also limits you to **2 active projects** total.

Other limits: **1 GB file storage**, **5 GB database egress + 5 GB cached egress** per month, **50,000 monthly active users** for auth, and **200 concurrent Realtime connections**. API requests are technically "unlimited" — throttled only by compute resources (~1,200 reads/sec on Nano). No downloadable backups exist on free tier; manual pg_dump is required.

| Resource | Free | Pro ($25/mo) |
|---|---|---|
| Database storage | 500 MB | 8 GB |
| pg_cron | ✅ No restrictions | ✅ |
| Edge Function invocations | 500K/mo | 2M/mo |
| Edge Function CPU per request | 2s | 2s |
| Inactivity pause | **7 days** | Never |
| Active projects | 2 | Unlimited |
| File storage | 1 GB | 100 GB |

---

## The Assemblée nationale provides data, not an API

The official open data portal at **data.assemblee-nationale.fr** is a bulk download repository, not a REST API. It provides zipped XML and JSON files covering deputies, votes (scrutins), amendments, legislative dossiers, and debates for the current 17th legislature. The vote data file (`Scrutins.json.zip`) updates **daily** and contains every deputy's position on each solemn vote. No OpenAPI/Swagger documentation exists. The data schema is published but lacks versioning stability.

**NosDéputés.fr**, operated by Regards Citoyens, provides the most practical queryable API. It returns JSON, XML, and CSV across well-structured endpoints: `/deputes/enmandat/json` for current deputies, `/17/scrutin/{num}/json` for individual vote details, `/{slug}/votes/json` for a deputy's voting record, and a full-text search endpoint with faceted filtering. A Python wrapper (`pip install cpc-api`) simplifies integration. Data is licensed CC-BY-SA/ODbL.

**ParlAPI.fr**, also by Regards Citoyens, was designed as a true REST API with filtering operators (`__ilike=`, `__gt=`, `__isnull=`) over the official open data. However, it appears **currently unreachable** (DNS resolution failing as of February 2026) and was self-described as "incomplete with non-final format."

Other notable data sources include **Datan.fr** (weekly CSV exports on data.gouv.fr with computed statistics like loyalty scores and majority proximity), **Tricoteuses** (npm package that cleans and restructures the raw official data), and **nosdonneesparlementaires.fr** (a newer REST API requiring registration, updated daily).

For a solo developer, the pragmatic approach is: download bulk data from data.assemblee-nationale.fr for initial population, use NosDéputés.fr API for ongoing queries, and consider the Tricoteuses npm package for data cleaning.

---

## Gemini Flash-Lite can run the entire AI pipeline for under $20/year

Google's Gemini API offers remarkable value for this use case thanks to **native PDF processing** (no preprocessing needed), a **1 million token context window**, and a **free tier** with no credit card required.

**Gemini 2.5 Flash-Lite** is the optimal model for classification tasks at **$0.10 per million input tokens** and **$0.40 per million output tokens**. Each PDF page counts as **258 tokens** of image input. A 100-page political program costs roughly $0.003 to process. The entire corpus of 10-20 party programs (50-200 pages each) costs between **$0.03 and $0.27** — essentially free.

Monthly law classification is the recurring cost. Processing 500-1,000 law descriptions against a 50,000-token promise context costs **$2.59-$5.45/month without caching**. With Gemini's **context caching** (the promise set is identical across all requests), costs drop to roughly **$1.35-$3.82/month** using Gemini 2.5 Flash, an **~80% reduction**. Flash models charge flat rates regardless of context length — no surcharge for prompts over 128K tokens.

The free tier provides **1,000 requests/day** for Flash-Lite and **250,000 tokens/minute**, enough to handle the entire monthly classification workload in a single day. Development and testing can run entirely free.

| Component | Flash-Lite | 2.5 Flash | 2.5 Flash + Cache |
|---|---|---|---|
| PDF processing (15 PDFs × 125 pages) | $0.11 | $0.53 | $0.53 |
| Monthly classification (1,000 laws) | $5.45/mo | $17.00/mo | **$3.82/mo** |
| Estimated annual cost | ~$66 | ~$205 | ~$46 |

Competitors are significantly more expensive: GPT-4o-mini costs ~50% more with only 128K context (requiring chunking for large PDFs), Claude Haiku 3.5 is **8× more expensive** on input. Neither offers free tiers or native PDF processing comparable to Gemini. Note that Gemini 1.5 Flash is already retired, and **2.0 Flash retires March 31, 2026** — build on 2.5 Flash or Flash-Lite.

---

## Eleven political groups span a fragmented Assemblée

The June-July 2024 snap elections produced a **record 11 political groups** in the 17th legislature, with no bloc holding the 289-seat absolute majority. The three blocs are the Nouveau Front Populaire (left, ~195 seats), the coalition gouvernementale (center-right, ~211 seats), and the far-right opposition (~140 seats).

**Left (NFP):** La France insoumise – Nouveau Front Populaire (**LFI-NFP**, ~71 seats, Mathilde Panot), Socialistes et apparentés (**SOC**, ~66 seats, Boris Vallaud), Écologiste et Social (**EcoS**, ~38 seats), Gauche Démocrate et Républicaine (**GDR**, ~17 seats, PCF allies).

**Center-right (government coalition):** Ensemble pour la République (**EPR**, ~94 seats, Gabriel Attal — main Macronist group), Droite Républicaine (**DR**, ~47 seats, Laurent Wauquiez — Les Républicains), Les Démocrates (**DEM**, ~36 seats, Marc Fesneau — MoDem), Horizons & Indépendants (**HOR**, ~33 seats, Paul Christophe).

**Far right:** Rassemblement National (**RN**, ~125 seats — largest single group, Marine Le Pen), Union des droites pour la République (**UDR**, ~16 seats, Éric Ciotti's LR breakaway faction allied with RN).

**Cross-partisan:** Libertés, Indépendants, Outre-mer et Territoires (**LIOT**, ~23 seats) — a heterogeneous group of regionalists and centrist independents. Roughly 10 deputies remain non-inscrits.

Member counts fluctuate due to ministerial appointments, by-elections, and group-switching. The official list is at assemblee-nationale.fr/dyn/les-groupes-politiques; Datan.fr provides weekly-updated datasets with group statistics.

---

## No one has automated promise-to-vote matching yet

The civic tech landscape reveals a clear gap. Existing platforms fall into three categories: **parliamentary monitors** (NosDéputés.fr, TheyWorkForYou, Datan.fr) that track what legislators do but not whether they fulfill promises; **manual promise trackers** (PolitiFact's Promise Meters) that rely entirely on journalists rating promise fulfillment; and **program comparators** (Voxe.org, now dormant) that compared candidate platforms but didn't track post-election follow-through.

**PolitiFact** is the gold standard for promise tracking, currently running its MAGA-Meter with 75 Trump second-term promises rated across six levels (Not Yet Rated → Promise Kept/Broken/Compromise). But it's pure editorial journalism — a small team manually evaluates each promise. It cannot scale to every politician or every vote.

**NosDéputés.fr** is the closest French equivalent, and its v2 rewrite uses **Next.js + PostgreSQL** — the same stack a Supabase/Vercel project would use. Its data pipeline (separate from frontend) is the architectural model to follow. TheyWorkForYou (UK, PHP/MySQL, open source BSD) pioneered the separated parser/frontend pattern and spawned clones across 20+ countries.

**Voxe.org's decline** is cautionary: its manual crowdsourced approach to program comparison couldn't sustain engagement between election cycles. The project pivoted away from its core mission.

The **Manifesto Project** (WZB Berlin) offers the most relevant AI precedent. Their **manifestoberta** model — a fine-tuned multilingual XLM-RoBERTa — classifies political text into 56 policy categories and is freely available on HuggingFace. However, research shows **zero-shot LLM classification of political text scores an F1 of only 0.21** — fine-tuning or structured few-shot prompting is essential for accuracy. This suggests a hybrid approach: use Gemini for initial classification with carefully crafted prompts and human review for edge cases.

## Conclusion

The technical stack is viable but requires architectural creativity around free-tier limits. **Use Supabase pg_cron as the scheduling backbone** (not Vercel's 2 daily-only cron jobs) to trigger Edge Functions for data fetching and classification. The Assemblée nationale's daily bulk data updates, combined with NosDéputés.fr's queryable API, provide sufficient data freshness. Gemini 2.5 Flash-Lite with context caching keeps AI costs under $4/month at scale. The 500 MB Supabase database limit and 7-day pause policy are manageable with a weekly heartbeat cron and lean schema design. The biggest risk isn't technical — it's that **automated promise-to-vote matching is an unsolved problem** requiring careful prompt engineering, domain-specific evaluation, and transparency about AI confidence levels to maintain civic trust.