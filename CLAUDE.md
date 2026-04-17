# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

트렌디맵 (Trendy Map) — an Express.js + PostgreSQL service that aggregates store locations from Kakao and Naver APIs, displays them on Naver Maps, and lets users suggest stores/foods. Deployed on Railway.

## Commands

```bash
npm install      # install dependencies
npm start        # starts server at http://localhost:8080
```

Requires a running PostgreSQL instance. Tables are auto-created on startup via `initDB()`.

## Required Environment Variables

Set in `.env` (see `.env.example`): `DATABASE_URL`, `KAKAO_REST_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `ADMIN_PASSWORD`.

The Naver Maps client ID is also hardcoded in `public/index.html` (`<script>` tag src) — must be updated alongside `.env` when changing Naver Cloud API keys.

## Architecture

**Single backend file:** `server.js` — Express server handling all API routes, PostgreSQL connection, and external API calls (Kakao Local Search, Naver Local Search).

**Static frontend:** `public/` — served by Express. No build step.
- `index.html` — main map UI (Naver Maps), ~83KB, contains all frontend JS inline
- `admin.html` — admin panel for managing stores/suggestions (password-protected)
- `suggest.html` — public store/food suggestion forms
- `about.html`, `legal.html` — informational pages

**Database:** Three PostgreSQL tables (auto-created):
- `custom_stores` — manually registered stores with `query_tags` for search matching
- `store_suggestions` — user-submitted store suggestions (pending/approved/rejected)
- `food_suggestions` — user-submitted trending food suggestions

## Key Data Flow

`GET /api/stores?query=...&lat=...&lng=...&radius=...` is the main search endpoint:
1. Searches Kakao Local API, Naver Local API, and `custom_stores` DB in parallel
2. Fetches business hours from Kakao Place Detail API for each Kakao result
3. Deduplicates across sources (name+address similarity OR coordinates within 50m via Haversine)
4. Returns merged, distance-sorted results

`GET /api/store-search?keyword=...&category=...` searches nationwide by store name (no radius constraint).

## Admin Routes

All admin routes use `authAdmin` middleware — password passed as `pw` query param or body field. CRUD for `custom_stores`, `store_suggestions`, `food_suggestions`.

## Utility

`blog-search.js` — standalone CLI script that scrapes Naver blog posts to find frequently mentioned store names. Run: `node blog-search.js "검색어"`. Requires Naver API keys.

## Gotchas

- Naver Local Search returns KATEC coordinates (mapy/mapx) — converted via `katecToWgs84()` which divides by 1e7. This is a simplified conversion.
- `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` is set globally at the top of `server.js`.
- The SSL config for PostgreSQL differs based on whether `DATABASE_URL` contains `railway.internal`.
- No test suite exists. No linter configured.
