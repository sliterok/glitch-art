# JPEG Glitcher & Background Lab

A fast, 100% client-side web application for creating deterministic JPEG glitch art and algorithmic backdrops. Runs entirely in your browser without any server backend.

🌐 **Live Demo on GitHub Pages**: [https://sliterok.github.io/glitch-art/](https://sliterok.github.io/glitch-art/)

---

## Features

### 1. Image Glitch Mode
- **Zero Server Uploads**: Your photos never leave your device. All processing happens in local browser memory.
- **Top Overscan Padding**: Sacrificial mirrored strip ensures row 0 is already glitched when displayed.
- **Auto-Validation**: Evaluates each candidate mutation for Huffman truncation, gray washouts, and visual drift (MAD).
- **DQT Table Mutation**: Optional Quantization Table corruption for painterly block artifacts.
- **Hold to Compare (O)**: Instantly toggle between glitched and original image.

### 2. Glitch Backgrounds Mode
Synthesize seeded glitch backdrops from scratch without uploading an image:
1. **Procedural JPEG**: Seeded trigonometric gradient/plasma/stripes/waves base subjected to real baseline JPEG scan mutations.
2. **Palette JPEG**: Soft harmonizer that gently pulls extreme corruption back into a cohesive 4-color palette, ideal for photo backdrops.
3. **Algo Synth (<15ms)**: Pure algorithmic YCbCr simulation featuring MCU row jogs, phase shifts, and 8x8 DCT quantization.
4. **DQT + Scan**: Dual hybrid mutating both DCT quantization tables and entropy scan bytes.
- **FG Overlay (F)**: Preview your uploaded subject centered over the generated background.
- **Match Uploaded Colors**: Extract a 4-color palette from your photo to color-match the synthesized background.

### 3. Workflow & Controls
- **Deterministic Seeds**: Space rolls a new seed; click **Lock** to tweak sliders (Intensity, Max Drift, Quality) on the same seed.
- **History Strip**: Keeps your last 30 renders plus all pinned favorites (**P**).
- **Export**: One-click download as high-resolution PNG (**S**) or baseline JPEG.
- **Keyboard Shortcuts**:
  - `Space` / Click Preview: Generate next
  - `←` / `→`: Navigate history
  - Hold `O`: View original
  - `F`: Toggle FG overlay
  - `P`: Pin/unpin current frame
  - `S`: Save PNG

---

## GitHub Pages Deployment

This repository is ready to be hosted on GitHub Pages:

### Option A: GitHub Actions (Recommended)
This repository includes a pre-configured workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
1. Go to your repository on GitHub: **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, select **GitHub Actions**.
3. Push to `main` branch, and GitHub Actions will automatically deploy the site.

### Option B: Deploy from Branch
1. Go to **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, select **Deploy from a branch**.
3. Select branch: `main` and folder: `/ (root)`.
4. Click **Save**. The app is served directly from `index.html`.

---

## Local Development

No build step or native dependencies required. You can run it with any static file server:

```bash
# Using Node.js built-in dev server:
pnpm dev
# or
pnpm start

# Or using Express server:
pnpm serve
# or
pnpm run server

# Or using npx serve:
npx serve .
```

Open `http://localhost:3000` in your browser.

---

## License

MIT

