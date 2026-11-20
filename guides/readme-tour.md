# Re-record the README tour

The README animation is captured from Goga Desktop’s renderer, not drawn from mockups. The recording opens a hidden Electron window with an in-memory bridge and a disposable profile. The sample folder picker returns a project from the fixture; it never opens a system picker. Launching the sample returns a completed run with synthetic output. The real Desktop host, Goga CLI and Docker are not started.

## Regenerate it

From the repository root on macOS, use the same Node version as CI (24), the locked Node dependencies (`npm ci` if needed), and an installed Electron binary from those dependencies. The image compositor requires Python 3.9+ with Pillow 10.1+; install Pillow in a Python virtual environment, not into the project's Node dependencies.

```sh
node scripts/readme-tour/generate.mjs --ui-locale en --caption-locale en
```

Use `PYTHON` to specify a Python interpreter if needed. The command captures a fresh sequence, renders the animation, then updates `guides/media/desktop-tour.gif` and its reduced-motion poster. To review a new recording before replacing the current one, add `--output work/readme-tour/preview`. Keep raw frames, profiles, and contact sheets out of Git.

## What to show

1. Start on Home. Show the Projects list with Atlas and Orbit.
2. Open **+** beside Projects so **Open existing** and **Create new** can be read. Choose **Open existing** to add Field Notes.
3. Open the **…** menu on Field Notes. Show the destination **Studio**, choose it, then show Field Notes inside the group.
4. Open the project overview, then its topics board.
5. Open **Launch**. Hold on the expanded menu showing **Pipeline**, **Build**, and **Start demonstration** together.
6. Choose **Pipeline**, select **refinement**, and show its four stages: define, discover, specify, review.
7. Launch it through the form. End on the run tab, with the sample output explicitly identified as simulated in the caption.

## Change a language or a scene

| What changes | Where to edit |
| --- | --- |
| Clicks and readiness checks | [Capture actions](../scripts/readme-tour/capture-window.cjs). Use actual UI controls; wait for their results, not fixed delays. |
| Project names, board data, pipeline catalog or sample output | [Renderer fixture](../scripts/readme-tour/fixture.cjs). Use invented data only. |
| Scene order, framing and reading time | [Storyboard](../scripts/readme-tour/scenario.json). Each scene ID names a captured PNG; keep the same ID for the same action across languages. |
| Captions printed around the screenshot | [English captions](../scripts/readme-tour/captions/en.json). Copy the file into the same directory using the target locale name, translate its text but not the scene IDs, then pass `--caption-locale`. |
| Labels to match in the real UI | [English controls](../scripts/readme-tour/ui-en.json) and [Russian controls](../scripts/readme-tour/ui-ru.json). Add a locator pack matching the actual controls for another UI language. |

**UI language and caption language are independent.** The fixture seeds the same initial language preference that Desktop reads from its preload. Record English or Russian with the same storyboard; changing captions does not translate the app. To verify Russian without replacing the README, use `--ui-locale ru --caption-locale en --output work/readme-tour/ru`. If a control has moved or been renamed, fix the interaction rather than reusing an old frame.

For a caption-only revision, record raw frames once and render them separately:

```sh
node scripts/readme-tour/capture.mjs --output work/readme-tour/raw --ui-locale ru
python3 scripts/readme-tour/render.py --frames work/readme-tour/raw --locale en \
  --output work/readme-tour/preview --contact-sheet work/readme-tour/preview/sheet.png
```

Before publishing, inspect the still poster, the contact sheet, and the GIF at README width. Verify that the group membership, all three launch choices, pipeline name, stages and run output are legible, captions match the images, and no real paths, projects, accounts or credentials are visible.

[Back to the README](../README.md)
