# Deprecated assets

These files were previously part of the front-end but are no longer used by any HTML pages. The app now uses a single script `web/app.js` for Manager and Selectors.

Archived here for reference:
- manager.js
- selector-checkpoint.js
- selector-lora.js
- modal.css

Rationale:
- All HTML pages (manager.html, selector-*.html) only load `/web/app.js` and `/web/styles.css`.
- The extension injects its own inline modal styles; `modal.css` is not referenced.

If you need functionality from these files, prefer porting it into `app.js` to avoid duplication.

