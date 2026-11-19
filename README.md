# JPEG Glitcher & Background Lab

A fast, deterministic JPEG glitch art and algorithmic backdrop laboratory featuring **Controlled Error Cancellation**, **Readability-Aware Validation**, and real-time parameter tweaking.

Works seamlessly in two modes:
1. **High-Performance Native Backend** (Node.js + `sharp` / `libvips` C++ engine at ~30–75ms per generation).
2. **100% Client-Side In-Browser Engine** (Web Workers + Canvas / `createImageBitmap` for zero-server hosting like GitHub Pages).

🌐 **Live Demo on GitHub Pages**: [https://sliterok.github.io/glitch-art/](https://sliterok.github.io/glitch-art/)

---

## Why Readable Glitches Matter: DC Drift & Error Cancellation

In a baseline sequential JPEG scan:
- **AC coefficients** (sharp edges, anime lineart, text, eyes) are encoded per 8×8 block.
- **DC coefficients** (average brightness `Y` and color `Cb`/`Cr`) are **differentially encoded (DPCM)**—each block stores only the delta from the preceding block.

When a byte mutation causes a Huffman desync and the decoder re-synchronizes, the AC edge data quickly recovers, but the running DC predictor inherits an offset $(\Delta Y, \Delta Cb, \Delta Cr)$ that cascades down the remainder of the image:
- **Readable Glitch**: The luminance offset $\Delta Y$ remains mild or gets pulled back toward neutral by cancelling mutations, while chroma offsets $(\Delta Cb, \Delta Cr)$ shift boldly through vibrant bands. Pixel values stay within $[0, 255]$ so underlying lineart and text remain crisp.
- **Unreadable Blowout**: Successive DC errors compound unidirectionally, pinning `Y` or `Cb/Cr` to the $0$ or $255$ rails. Entire sections clip to flat neon yellow/white or crushed black, erasing contrast and destroying all detail.

This laboratory solves this with **Sequential Band-Balanced Search** and **Readability-Aware Metrics** evaluated on fast 64×64 thumbnails during generation.

---

## Core Features & Architecture

### 1. Unified `Corruption` (0–100) & Auto-Balance System
Replaces arbitrary mutation counts with an intuitive, unified slider interpolated smoothly across 4 operational regimes:

| Slider (0–100) | Mutation Operator | Balancing Trials ($M$) | Max Added Clip | Min Detail Retention | Target Luma MAD | Target Chroma MAD |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **0–25 (Clean Bands)** | 1-bit flips | Strong ($M = 6$) | $\le 0.08$ | $\ge 0.80$ | $8\text{–}22$ | $18\text{–}55$ |
| **26–55 (Readable Glitch)** | 1–2 bit flips | Moderate ($M = 5$) | $\le 0.18$ | $\ge 0.65$ | $15\text{–}40$ | $25\text{–}75$ |
| **56–80 (Heavy Decay)** | 2–4 bit / nibble masks | Light ($M = 3$) | $\le 0.45$ | $\ge 0.35$ | $30\text{–}75$ | $35\text{–}100$ |
| **81–100 (Full Meltdown)** | Full-byte overwrites + DQT | Off ($M = 1$) | $\le 0.85$ | $\ge 0.10$ | $50\text{–}130$ | $40\text{–}130$ |

- **Auto-Balance Toggle**: Actively searches micro-batches ($M = 3\text{–}6$) in each vertical zone to find mutations that cancel DC drift and pull luminance back toward neutral. Toggle off for runaway compounding drift.
- **Strict 0xFF Marker Invariant**: Guarantees bit flips never produce `0xFF` or mutate byte-stuffed `0x00` markers, preventing decoder aborts.

### 2. Readability-Aware Validation Metrics (64×64)
Evaluated in less than 0.1ms per candidate thumbnail:
- **Added Clipping Ratio (`addedClipRatio`)**: Measures pixels where luminance is crushed ($Y < 16$ or $Y > 240$) or where $\ge 2$ RGB channels hit the rails ($\le 10$ or $\ge 245$), penalizing yellow/white washouts and crushed black.
- **Local Detail Retention (`detailRetention`)**: Divides the luminance map into an $8\times 8$ grid of $8\times 8$ cells (64 total). Calculates the fraction of high-contrast cells in the original ($\text{origRange} > 25$) that still retain visible contrast ($\text{glitchRange} > 18$), preserving drawing lineart and typography even under horizontal MCU shearing.
- **Independent Luma vs. Chroma Drift**: Evaluates luminance drift (`lumaMad`) separately from color shifts (`chromaMad`), incentivizing bold color bands while preserving exposure.
- **Truncation & Top Row Shift Guards**: Automatically rejects premature decoder termination (`addedBottomGray > 0.30`) and enforces visible glitch on rows 0–11 via sacrificial top overscan.

### 3. Sequential Band-Balanced Search (Mechanism A)
Instead of applying all mutations blindly at once:
1. Divides the scan stream into $K = 5$ vertical zones (Zone 0 = sacrificial overscan; Zones 1–4 = visible vertical bands).
2. Injects mutations sequentially from top to bottom.
3. For each zone, tests a deterministic micro-batch ($M$ trials via `rng.fork('zone-' + z + '-try-' + m)`).
4. Scores the downstream region using the weighted cost function:
   $$\text{cost} = w_{\text{clip}} \cdot \max(0, \text{addedClip} - \text{maxClip}) + w_{\text{detail}} \cdot \max(0, \text{minDetail} - \text{detailRetention}) + w_Y \cdot \vert{}\text{lumaMad} - \text{targetLuma}\vert{} + w_C \cdot \max(0, \text{minChroma} - \text{chromaMad})$$
5. Early short-circuiting commits candidates hitting $\text{cost} < 3.5$ immediately, completing the entire generation in ~30–75ms.

### 4. Image Glitch Mode
- **Zero Server Uploads Required**: If using client-side mode, your images never leave your browser. If using the native server, processing is handled entirely in local RAM.
- **Top Overscan Padding**: Prepends a 64px mirrored & textured strip so row 0 is already glitched upon display.
- **Hold to Compare (O)**: Instantly view the unglitched original for comparison.
- **Include DQT**: Optional quantization table corruption for painterly mosaic blocks.

### 5. Glitch Backgrounds Mode
Synthesize seeded glitch backdrops from scratch without uploading an image:
1. **Procedural JPEG**: Trigonometric gradient/plasma/stripes/waves base subjected to real baseline JPEG scan mutations.
2. **Palette JPEG**: Soft harmonizer that gently pulls extreme corruption into a cohesive 4-color palette, ideal for photo backdrops.
3. **Algo Synth (<15ms)**: Pure algorithmic YCbCr simulation featuring MCU row jogs, phase shifts, and 8x8 DCT quantization.
4. **DQT + Scan**: Dual hybrid mutating both DCT quantization tables and entropy scan bytes.
- **FG Overlay (F)**: Preview your uploaded subject centered over the generated background.
- **Match Uploaded Colors**: Extract a 4-color palette from your photo to color-match the synthesized background.

### 6. Gallery, Favorites & Persistent History
- **Persistent In-Browser History (IndexedDB)**: Generations are stored locally in your browser's IndexedDB, surviving page reloads and browser restarts.
- **Pinned Active Source Image**: The active source image is pinned at position 0 with a 📌 badge and `SRC` tag.
- **Dedicated Gallery Filter Tabs**: Filter between **All**, **Glitches**, **Sources**, and **❤️ Favs** in both the footer strip and fullscreen modal.
- **Smart ZIP Batch Downloads**: Downloads exceeding 3 images are automatically packaged into a single `.zip` archive (client-side PKZip Store compression).
- **Fullscreen Gallery Modal (G)**: Fullscreen responsive grid with synchronized batch action bar and favorites filter (`Esc` to exit).
- **Range Select & Marquee Box Drag**: Hold `Shift` to preview and range-select items, or click and drag a marquee selection box.
- **"Use as Source" Feedback Loop (U)**: Promote any generated background or historic glitch frame directly to the active source image without duplicating history records.

---

## Workflow & Controls

- **Drift Modes**:
  - **1D**: Continuous smooth 1D wave displacement across rows.
  - **2D**: Smooth continuous 2D coordinate noise evaluated at $(x, y)$.
  - **Color**: Displacement and chroma warping driven dynamically by pixel luminance and chroma.
  - **Random**: Pseudo-random scanline jumps.
- **Noise Frequency Multiplier**: Tune wave frequency from `0.1×` to `4.0×`.
- **Clipboard Image Paste (Ctrl+V)**: Paste images or screenshots directly into the application.
- **Deterministic Seeds**: Space rolls a new seed; click **Lock** to tweak sliders (Corruption, Noise Mult, Quality) on the same seed in real-time.
- **Export**: One-click download as high-resolution PNG (**S**) or baseline JPEG.
- **Keyboard Shortcuts**:
  - `Space` / Click Preview: Generate next
  - `←` / `→`: Navigate history
  - Hold `O`: View original
  - `U`: Use active frame as glitch source
  - `Ctrl+V`: Paste image as new source
  - `P`: Toggle Favorite
  - `G`: Toggle Fullscreen History Gallery
  - `Esc`: Exit Fullscreen or cancel batch selection
  - Hold `Shift`: Preview and range-select items
  - `F`: Toggle FG overlay
  - `S`: Save PNG

---

## Local Development & Servers

### Dual Server Options

```bash
# 1. Native High-Performance Server (Node.js + Sharp / libvips C++ backend)
pnpm serve
# or
pnpm run server

# 2. Static Dev Server (Client-Side App with Web Worker + Canvas)
pnpm dev
# or
pnpm start
```

Open `http://localhost:3000` (or `http://localhost:3001` if port 3000 is occupied) in your browser. The frontend automatically detects the active backend via `/api/ping`.

---

## GitHub Pages Deployment

This repository is ready for zero-backend hosting on GitHub Pages:

### Option A: GitHub Actions (Recommended)
This repository includes a pre-configured workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
1. Go to your repository on GitHub: **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, select **GitHub Actions**.
3. Push to `main` branch, and GitHub Actions will automatically deploy the site.

### Option B: Deploy from Branch
1. Go to **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, select **Deploy from a branch**.
3. Select branch: `main` and folder: `/ (root)`.
4. Click **Save**.

---

## License

MIT


