export type FontSize = "small" | "default" | "large" | "larger";
export const FONT_SIZES: FontSize[] = ["small", "default", "large", "larger"];
export const FONT_SIZE_STORAGE_KEY = "cssa-hub-font-size";

/** Percent of the browser's base size, so a system-wide larger text setting still applies. */
export const FONT_SCALE: Record<FontSize, string> = { small: "87.5%", default: "", large: "112.5%", larger: "125%" };

/** Runs before paint in the root layout so pages don't jump to the chosen size. */
export const fontSizeScript = `try{var s=${JSON.stringify(FONT_SCALE)}[localStorage.getItem(${JSON.stringify(FONT_SIZE_STORAGE_KEY)})];if(s)document.documentElement.style.fontSize=s}catch{}`;
