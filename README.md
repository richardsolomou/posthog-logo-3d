# posthog-logo-3d

A 3D printable PostHog logo, split into one piece per color. It looks the same from both sides, and the pieces press together with tenons that are part of the print, so there are no loose pegs.

## Build

```sh
pnpm install
pnpm build
```

`pnpm build` writes the site to `dist/`:

- `stl/*.stl` has one part per color, generated from `src/posthog-logomark.svg` by `src/parts.mjs`. The build fails if any two assembled parts overlap by more than the designed crush-rib interference.
- `posthog-logo-x2d.3mf` is a Bambu Studio project for the Bambu Lab X2D: one plate, printed by object, with each part on its own Bambu PLA Basic color. `bambu/build.py` makes it with the Bambu Studio CLI, then slices it and fails if the G-code does not have exactly one filament change per extra color.
- `index.html` and `assembled.glb` are the 3D viewer and download page.

The 3MF step needs Bambu Studio. Locally it uses the macOS app in `/Applications` and its downloaded system presets. Set `BAMBU_STUDIO` and `BAMBU_PRESETS` to use a different binary or preset folder.

Formatting and linting come from [ras-stack](https://github.com/richardsolomou/ras-stack), selected in `ras.config.ts`. `pnpm check` runs both, and `pnpm fix` applies them.

## Fit

The fit is set by `TENON_CLEARANCE` and `RIB` at the top of `src/parts.mjs`. Each tenon has crush ribs that are `RIB - TENON_CLEARANCE` (0.15 mm) tight per side. If the pieces are too tight to press together on your printer, lower `RIB`. If they are loose, glue fills the gap.

## Deploy

Every push to `main` builds the site and deploys it as a static-assets [Cloudflare Worker](https://developers.cloudflare.com/workers/static-assets/) through `.github/workflows/deploy.yml`. Pull requests run the same build without deploying. CI uses the pinned Bambu Studio Linux AppImage, so the 3MF does not depend on whatever version is installed locally.

The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN`, a token with the "Edit Cloudflare Workers" template, and `CLOUDFLARE_ACCOUNT_ID`.

To preview the build locally, run `pnpm dev`.

## License

The code is MIT. The PostHog logo is a trademark of PostHog Inc.
