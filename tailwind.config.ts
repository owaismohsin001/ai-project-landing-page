import type { Config } from "tailwindcss";

/**
 * Blue / black theme. `brand` is the blue accent scale, `ink` is the
 * near-black background scale used across the app.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
        },
        ink: {
          900: "#05070d",
          800: "#0a0e1a",
          700: "#111726",
          600: "#1a2236",
        },
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { transform: "translateX(0%)" },
          "100%": { transform: "translateX(400%)" },
        },
        "draw-circle": {
          "0%": { strokeDashoffset: "166" },
          "100%": { strokeDashoffset: "0" },
        },
        "draw-check": {
          "0%": { strokeDashoffset: "48" },
          "100%": { strokeDashoffset: "0" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.6)" },
          "60%": { opacity: "1", transform: "scale(1.08)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "modal-in": {
          "0%": { opacity: "0", transform: "scale(0.92) translateY(8px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s ease-out both",
        "draw-circle": "draw-circle 500ms ease-out forwards",
        "draw-check": "draw-check 350ms ease-out 450ms forwards",
        "pop-in": "pop-in 250ms ease-out both",
        "fade-in": "fade-in 200ms ease-out both",
        "modal-in": "modal-in 220ms cubic-bezier(0.16,1,0.3,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
