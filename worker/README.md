# FRACTURE shared library: setup

The site works without this; it keeps the library on each device. This Worker makes the library shared.
Everything is done in the Cloudflare dashboard (works on iPad). It stays within the free plan.

1. **Create the database.** Cloudflare dashboard → *Storage & Databases* → *D1 SQL Database* → *Create* → name it `fracture` → Create.
   (No tables to set up; the Worker creates them on its first visit.)
2. **Create the Worker.** *Workers & Pages* → *Create* → *Create Worker* → name it `fracture-library` → *Deploy*.
   Then *Edit code* → delete everything in the editor → paste the whole of `worker/worker.js` from this repo → *Deploy*.
3. **Connect the database.** In the Worker: *Settings* → *Bindings* → *Add* → *D1 database* →
   variable name `DB` → pick `fracture` → *Save*.
4. **Add settings.** *Settings* → *Variables and Secrets* → *Add*:
   - `ALLOWED_ORIGINS` (Text): `https://lampwrecked.github.io`
   - `SALT` (Secret): any random words, e.g. `glass anvil 174 static`
   - `ADMIN_KEY` (Secret): a long password only you know
   Then *Deploy* again.
5. **Check it.** Open the Worker's address (shown at the top, like `https://fracture-library.YOURNAME.workers.dev`).
   You should see `{"ok":true,"name":"fracture library"}`.
6. **Point the site at it.** In `index.html` find `const API_URL='';` and put the Worker address between the quotes:
   `const API_URL='https://fracture-library.YOURNAME.workers.dev';` → commit. The library panel then says **SHARED LIBRARY**.

## Moderation
- Recipes and songs are numbers only; there is no text or image field anywhere.
- Each visitor can save 30 recipes and 15 songs per hour.
- Any card or song reported by 3 different visitors hides itself.
- Open the site with `?admin=YOUR_ADMIN_KEY` added to the address to get a **HIDE** button on every card and song.
