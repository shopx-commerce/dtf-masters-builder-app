import { useState, useEffect, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { ALL_PROFILES, type ProfileConfig } from "@/lib/profiles";
import { IconHotPeel, IconFluorescent, IconUvDtf, IconSpecialtyColdPeel, IconDieCutStickers } from "@/components/profile-icons";
import { useLanguage } from "@/lib/i18n";
import LanguageToggle from "@/components/language-toggle";

const CARD_KEYS: Record<string, { subline: string; bullets: string[]; press: string }> = {
  "hot-peel": {
    subline: "landing.hotPeel.subline",
    bullets: ["landing.hotPeel.bullet1", "landing.hotPeel.bullet2", "landing.hotPeel.bullet3"],
    press: "landing.hotPeel.press",
  },
  fluorescent: {
    subline: "landing.fluorescent.subline",
    bullets: ["landing.fluorescent.bullet1", "landing.fluorescent.bullet2", "landing.fluorescent.bullet3"],
    press: "landing.fluorescent.press",
  },
  "uv-dtf": {
    subline: "landing.uvDtf.subline",
    bullets: ["landing.uvDtf.bullet1", "landing.uvDtf.bullet2", "landing.uvDtf.bullet3"],
    press: "landing.uvDtf.press",
  },
  "specialty-dtf": {
    subline: "landing.specialty.subline",
    bullets: ["landing.specialty.bullet1", "landing.specialty.bullet2", "landing.specialty.bullet3"],
    press: "landing.specialty.press",
  },
  "die-cut-stickers": {
    subline: "landing.dieCut.subline",
    bullets: ["landing.dieCut.bullet1", "landing.dieCut.bullet2", "landing.dieCut.bullet3"],
    press: "landing.dieCut.press",
  },
};

const PROFILE_ICONS: Record<string, React.ReactNode> = {
  "hot-peel": <IconHotPeel className="w-10 h-10" />,
  fluorescent: <IconFluorescent className="w-10 h-10" />,
  "uv-dtf": <IconUvDtf className="w-10 h-10" />,
  "specialty-dtf": <IconSpecialtyColdPeel className="w-10 h-10" />,
  "die-cut-stickers": <IconDieCutStickers className="w-10 h-10" />,
};

const PROFILE_GRADIENTS: Record<string, string> = {
  "hot-peel": "from-cyan-400 to-blue-500",
  fluorescent: "from-purple-400 to-pink-400",
  "uv-dtf": "from-amber-300 to-orange-400",
  "specialty-dtf": "[background:linear-gradient(120deg,#fbbf24_0%,#f8fafc_18%,#94a3b8_22%,#94a3b8_78%,#f8fafc_82%,#34d399_100%)]",
  "die-cut-stickers": "from-sky-400 to-indigo-500",
};

const PROFILE_ICON_TILES: Record<string, string> = {
  "hot-peel": "bg-cyan-500/10 border border-cyan-500/20 text-cyan-600",
  fluorescent: "bg-purple-500/10 border border-purple-500/20 text-purple-600",
  "uv-dtf": "bg-amber-500/10 border border-amber-500/20 text-amber-600",
  "specialty-dtf": "[background:linear-gradient(120deg,rgba(251,191,36,0.15)_0%,rgba(248,250,252,0.3)_18%,rgba(148,163,184,0.15)_22%,rgba(148,163,184,0.15)_78%,rgba(248,250,252,0.3)_82%,rgba(52,211,153,0.15)_100%)] border border-slate-200/50 text-emerald-700",
  "die-cut-stickers": "bg-sky-500/10 border border-sky-500/20 text-sky-600",
};

const PROFILE_GLOWS: Record<string, string> = {
  "hot-peel": "hover:shadow-cyan-500/20",
  fluorescent: "hover:shadow-purple-500/20",
  "uv-dtf": "hover:shadow-amber-500/20",
  "specialty-dtf": "hover:shadow-slate-300/30",
  "die-cut-stickers": "hover:shadow-sky-500/20",
};

const PROFILE_CTA_STYLES: Record<string, React.CSSProperties> = {
  "specialty-dtf": {
    background: "linear-gradient(120deg, #b0b0b0 0%, #d8d8d8 30%, #e8e8e8 50%, #d0d0d0 70%, #b0b0b0 100%)",
    color: "#B8860B",
    textShadow: "0 1px 2px rgba(0,0,0,0.12)",
  },
};

function ProfileCard({ profile }: { profile: ProfileConfig }) {
  const [, setLocation] = useLocation();
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const { t } = useLanguage();

  const keys = CARD_KEYS[profile.id] ?? { subline: "", bullets: [], press: "" };
  const gradient = PROFILE_GRADIENTS[profile.id] ?? "from-gray-500 to-gray-600";
  const glow = PROFILE_GLOWS[profile.id] ?? "";
  const icon = PROFILE_ICONS[profile.id];

  const handleClick = (e: React.MouseEvent) => {
    if (profile.comingSoon) {
      e.preventDefault();
      setShowPasswordModal(true);
      setPasswordInput("");
    }
  };

  const handleProceed = () => {
    if (profile.comingSoon && passwordInput.trim() !== "") {
      setShowPasswordModal(false);
      setLocation(profile.route);
    }
  };

  const card = (
    <div
      onClick={handleClick}
      className={`group relative h-full bg-white border border-gray-200 rounded-2xl p-6 cursor-pointer transition-all duration-300 hover:border-gray-400 hover:shadow-2xl ${glow} hover:-translate-y-1 flex flex-col`}
    >
      {profile.comingSoon && (
        <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-purple-100 text-purple-700 text-[10px] font-semibold uppercase tracking-wide">
          {t("landing.comingSoon")}
        </div>
      )}

      <div
        className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 ${PROFILE_ICON_TILES[profile.id] ?? "bg-gray-500/10 border border-gray-500/20 text-gray-600"}`}
      >
        {icon}
      </div>

      <h2 className="text-xl font-semibold text-gray-900 mb-2 tracking-wide">{profile.name}</h2>

      <p className="text-[15px] font-medium text-gray-800 mb-3 leading-snug">{t(keys.subline)}</p>

      <ul className="space-y-1.5 mb-3">
        {keys.bullets.map((bKey, i) => (
          <li key={i} className="text-[13px] text-gray-600 leading-relaxed flex gap-2">
            <span className="text-gray-400 mt-0.5">•</span>
            <span>{t(bKey)}</span>
          </li>
        ))}
      </ul>

      <p className="text-[12px] text-gray-500 opacity-80 mb-5 flex-1">{t(keys.press)}</p>

      <div
        className={`w-full h-12 rounded-xl flex items-center justify-center text-base font-semibold opacity-90 group-hover:opacity-100 transition-opacity shadow-sm ${PROFILE_CTA_STYLES[profile.id] ? '' : `bg-gradient-to-r ${gradient} text-white`}`}
        style={PROFILE_CTA_STYLES[profile.id] || undefined}
      >
        {t("landing.openBuilder")}
      </div>
    </div>
  );

  return (
    <>
      {profile.comingSoon ? (
        card
      ) : (
        <Link href={profile.route} className="block h-full">
          {card}
        </Link>
      )}
      {profile.comingSoon && showPasswordModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowPasswordModal(false)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-gray-700 mb-4">{t("landing.passwordPrompt")}</p>
            <input
              type="password"
              placeholder={t("landing.enterPassword")}
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-center font-mono text-lg mb-4 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowPasswordModal(false)}
                className="flex-1 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50"
              >
                {t("landing.cancel")}
              </button>
              <button
                onClick={handleProceed}
                disabled={passwordInput.trim() === ""}
                className="flex-1 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("landing.proceed")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const BUILDER_PATHS = new Set(["uv-dtf", "hot-peel", "fluorescent", "specialty-dtf", "die-cut-stickers"]);

function shopifyLandingRedirect(): boolean {
  if (typeof window === "undefined") return false;
  const p = new URLSearchParams(window.location.search);
  const ctx = p.get("ctx");
  const shop = p.get("shop");
  const variant = p.get("variant") || p.get("variant_id");
  return !!(ctx || (shop && variant));
}

export default function Landing() {
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  const needsShopifyRedirect = useMemo(shopifyLandingRedirect, []);

  useEffect(() => {
    if (!needsShopifyRedirect) return;
    const params = new URLSearchParams(window.location.search);
    const builder = (params.get("builder") || params.get("profile") || "uv-dtf").replace(/^\//, "");
    const path = BUILDER_PATHS.has(builder) ? `/${builder}` : "/uv-dtf";
    const query = params.toString();
    setLocation(query ? `${path}?${query}` : path);
  }, [needsShopifyRedirect, setLocation]);

  if (needsShopifyRedirect) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="border-b border-gray-200 px-6 py-4">
        <h1
          className="text-2xl font-black tracking-widest text-center"
          style={{
            fontFamily: "'Orbitron', sans-serif",
            background: "linear-gradient(90deg, #06b6d4, #3b82f6, #8b5cf6, #06b6d4)",
            backgroundSize: "200% auto",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            animation: "gradientShift 4s linear infinite",
            filter: "drop-shadow(0 0 8px rgba(6,182,212,0.5))",
          }}
        >
          {t("landing.title")}
        </h1>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-6xl">
          <p className="text-center text-gray-700 mb-10 text-base font-semibold">{t("landing.subtitle")}</p>
          {/* Wrapping flex (not a 5-col grid) so the 5th card drops to a centered
              second row instead of squeezing every card narrower. */}
          <div className="flex flex-wrap justify-center gap-6">
            {ALL_PROFILES.map((profile) => (
              <div
                key={profile.id}
                className="w-full sm:w-[calc(50%-0.75rem)] lg:w-[calc(33.333%-1rem)] xl:w-[calc(25%-1.125rem)]"
              >
                <ProfileCard profile={profile} />
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="border-t border-gray-200 px-6 py-3 flex items-center justify-center gap-4">
        <span className="text-[11px] text-gray-600">
          {t("landing.footer")}{" "}
          <a href="mailto:Support@anynestapp.com" className="text-cyan-600 hover:text-cyan-700 font-semibold">
            Support@anynestapp.com
          </a>
        </span>
        <LanguageToggle />
      </footer>
    </div>
  );
}
