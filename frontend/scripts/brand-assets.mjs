// Regenerates the derived brand images from assets/brand/logo.webp (640×193, transparent):
//   assets/brand/logo-on-dark.webp  full lockup with the dark text recolored for the dark theme
//   assets/brand/logo-mark.webp     phoenix + "UCSB CSSA" wordmark, without the text block
// and from assets/brand/app-icon.webp (1024×1024 phoenix on black, full bleed):
//   app/icon.png                    favicon
//   app/apple-icon.png              iOS home-screen icon
//   public/brand/icon-{192,512}.png web app manifest icons (app/manifest.ts)
// Run with `npm run brand --workspace frontend` after replacing either source. The crop boxes
// below are measured on the current logo and need re-measuring if its layout changes.
// Uses the sharp copy that Next.js installs.
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const file = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const SOURCE = file("assets/brand/logo.webp");
const APP_ICON = file("assets/brand/app-icon.webp");

/** Everything right of this x is the text block (divider line + names). */
const TEXT_START_X = 358;
const MARK = { left: 0, top: 0, width: 376, height: 160 };

const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;
const raw = (buffer) => sharp(buffer, { raw: { width, height, channels: 4 } });
const isGrey = (buffer, i) => {
  const max = Math.max(buffer[i], buffer[i + 1], buffer[i + 2]);
  const min = Math.min(buffer[i], buffer[i + 1], buffer[i + 2]);
  return max - min < 40 && max < 170;
};

const onDark = Buffer.from(data);
const mark = Buffer.from(data);
for (let y = 0; y < height; y++) {
  for (let x = TEXT_START_X; x < width; x++) {
    const i = (y * width + x) * 4;
    if (!isGrey(data, i)) continue;
    onDark[i] = onDark[i + 1] = onDark[i + 2] = 240;
    mark[i + 3] = 0;
  }
}

await raw(onDark).webp({ quality: 90 }).toFile(file("assets/brand/logo-on-dark.webp"));
await raw(mark).extract(MARK).webp({ quality: 90 }).toFile(file("assets/brand/logo-mark.webp"));

/** Shrinks the art onto black so the wingtips clear the rounded corners iOS and Android apply. */
const APP_ICON_FILL = 0.9;
const { width: iconSide } = await sharp(APP_ICON).metadata();
const art = await sharp(APP_ICON).resize(Math.round(iconSide * APP_ICON_FILL)).png().toBuffer();
const icon = await sharp({
  create: { width: iconSide, height: iconSide, channels: 3, background: { r: 0, g: 0, b: 0 } },
})
  .composite([{ input: art, gravity: "center" }])
  .png()
  .toBuffer();

await sharp(icon).resize(128, 128).png().toFile(file("app/icon.png"));
await sharp(icon).resize(180, 180).png().toFile(file("app/apple-icon.png"));
for (const size of [192, 512]) {
  await sharp(icon).resize(size, size).png({ palette: true, quality: 90 }).toFile(file(`public/brand/icon-${size}.png`));
}

// 小飒 (public/brand/{idle,think}.gif, 480×480): small animations for chat avatars and still
// first frames for reduced motion.
for (const state of ["idle", "think"]) {
  const source = file(`public/brand/${state}.gif`);
  await sharp(source, { animated: true })
    .resize(160, 160)
    .gif({ colours: 96, effort: 10, interFrameMaxError: 8, interPaletteMaxError: 8 })
    .toFile(file(`public/brand/${state}-160.gif`));
  await sharp(source).resize(128, 128).png({ palette: true }).toFile(file(`public/brand/${state}.png`));
}

console.log("Brand assets written.");
