import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./client/index.html", "./client/src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        chart: {
          "1": "var(--chart-1)",
          "2": "var(--chart-2)",
          "3": "var(--chart-3)",
          "4": "var(--chart-4)",
          "5": "var(--chart-5)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar-background)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    /**
     * `coarse:` — the device has a touch screen, whatever its width.
     *
     * Touch density used to be keyed to the `md:` width breakpoint, which gets
     * an iPad wrong in both directions: at 834px it takes the desktop arm and
     * ends up with 11px inputs and 14px steppers on a device with no mouse.
     *
     * `any-pointer`, not `pointer`: `pointer` describes the *primary* pointing
     * device and flips to `fine` the moment a Magic Keyboard trackpad is
     * attached to an iPad, which would shrink every control mid-session while
     * the customer is still touching the screen. `any-pointer: coarse` stays
     * true while a coarse input exists at all — size for the coarsest input the
     * device can produce.
     */
    require("tailwindcss/plugin")(
      ({ addVariant }: { addVariant: (name: string, definition: string) => void }) => {
        addVariant("coarse", "@media (any-pointer: coarse)");
        /**
         * `layersheet:` — inside the phone's summoned layers sheet.
         *
         * `LayerRow` is shared with the desktop sidebar, and an iPad renders
         * that sidebar on a touch screen, so `coarse:` cannot be used to grow
         * the row's targets for the phone: it would move the iPad too, and the
         * iPad layout is required to stay byte-identical. Scoping on an
         * attribute that only the phone's layers sheet sets keeps the change
         * where it is wanted.
         */
        addVariant("layersheet", "[data-mobile-layers] &");
      },
    ),
  ],
} satisfies Config;
