# eBay Keyword Checker

A small Windows 11 app that watches **newly listed** eBay items for your keywords and sends matches to **Discord**. It's built to be light, quick to use, and gentle on eBay.

![icon](build/icon.png)

## Features

- **+keyword / -keyword** rules, plus phrases, any-of groups, and prefix wildcards
- **Price range**, optionally counting shipping
- **Format** (All / Buy It Now / Auction) and **condition** (Any / New / Used) filters
- **Discord webhook** alerts as rich embeds (title, price, shipping, condition, photo, link). You can set a separate webhook per search and an optional `@mention`.
- Windows notifications, a **Matches** history, and an activity log
- **Light and dark mode**, following Windows or set manually
- Runs in the system tray and can start with Windows
- **Auto-updates** from GitHub Releases. It checks at launch and every 12 hours, downloads only the changed parts, then asks you to restart. If you choose *Later*, it installs on the next restart.

## Keyword syntax

| You type | Meaning |
| --- | --- |
| `rtx 4090` | sent to eBay as the search text (eBay matches loosely) |
| `+founders` | the title **must** contain "founders" |
| `-broken` | hide listings whose title or condition contains "broken" |
| `-"for parts"` | hide listings containing that exact phrase |
| `+(fe,founders)` | the title must contain **any one** of these |
| `-box*` | prefix match: hides "box", "boxed", "boxes" |

Matching ignores case and accents and respects word boundaries. So `-case` won't hide "showcase", while `+4090` still matches "RTX4090".

Example: `rtx 4090 +(fe,founders) -broken -"for parts"` with max price `1600`.

## Staying under eBay's radar

- Each cycle waits a **random 12–15 minutes** (at most 4–5 per hour). The minimum allowed is 12 minutes.
- Searches within a cycle are spaced **8–25 seconds apart**, at random.
- If eBay pushes back (HTTP 429 or a bot challenge), the app **backs off exponentially** for up to 2 hours.
- "Check Now" has a 5-minute cooldown.
- Requests go through Chromium's own network stack with a persistent cookie jar, so they look like a normal Chrome visit. If eBay shows a challenge, the app solves it once in a hidden window with images and fonts blocked, then returns to the light path.
- The first check of a new search **silently** marks existing listings as seen, so you only get alerts for genuinely new ones. You can change this in Settings.

## Resource use

- No UI framework; the window is plain HTML/CSS.
- Closing the window **destroys** it, not just hides it. In the tray, only the background process runs.
- No page rendering for normal checks: the search page is fetched as HTML and parsed in about 50 ms.
- GPU acceleration is disabled.

## Development

```bash
npm install
npm start          # run the app
npm test           # 137 unit tests (vitest)
npm run smoke -- out/   # screenshots of every screen, light + dark
npx electron scripts/live-check.js   # one real check against eBay (no Discord)
npm run icons      # regenerate icon.png / icon.ico / tray.png from build/icon.svg
```

## Releasing an update

1. Bump `version` in `package.json` (for example `1.0.1`).
2. Commit, then tag and push:
   ```bash
   git tag v1.0.1 && git push origin main --tags
   ```
3. GitHub Actions (`.github/workflows/release.yml`) runs the tests on Windows, builds the installer, and publishes the release with `latest.yml` and the `.blockmap` file.
4. Installed copies find it within 12 hours, or on their next launch, and download only the changed blocks.

## Notes

- The installer isn't code-signed, so Windows SmartScreen may show "Windows protected your PC" on first install. Click **More info → Run anyway**. Updates install without that prompt.
- Your settings, searches and seen-history live in `%APPDATA%\eBay Keyword Checker\data.json`.
- This app reads public eBay search pages for personal use. Keep the check rate reasonable.
